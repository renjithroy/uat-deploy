#!/usr/bin/env python3
"""Helpers for the uat-deploy skill.

  mask                          stdin -> stdout with secrets masked
  check read|write CMD          exit 0 if CMD is allowed in that mode, else print the reason and exit 1
  swapjar MODE FILE NEWJAR OUT [APPDIR]
                                write OUT = FILE with its one active -jar line switched to NEWJAR
  yaml-find FILE KEY            list where KEY occurs (dotted path, line range, value preview)
  yaml-check FILE               parse every document; fail on syntax errors and duplicate keys
  yaml-diff OLD NEW             unified diff plus the list of changed paths
  yaml-served OLD NEW SERVED [KEY]
                                check SERVED has the new value of every path changed from OLD to NEW
  format-check FORMAT FILE      syntax check for yaml, json, xml or properties
  text-diff OLD NEW             unified diff with secret values masked
  guard                         Claude Code PreToolUse hook: block direct ssh/scp to UAT and password reads
"""
import difflib
import json
import os
import re
import shlex
import sys

SECRET_KEY = re.compile(r"(password|passwd|pwd|secret|token|private)", re.I)
MASK_RE = re.compile(r"((?:password|passwd|secret)[A-Za-z0-9_.-]*\s*[=:]\s*['\"]?)[^'\"\s,]+", re.I)


def _password():
    path = os.environ.get("UAT_PASSWORD_FILE")
    try:
        with open(path) as f:
            return f.read().strip() or None
    except (TypeError, OSError):
        return None


def mask_text(text, pw=None):
    text = MASK_RE.sub(r"\1****", text)
    if pw:
        text = text.replace(pw, "****")
    return text


def cmd_mask():
    pw = _password()
    for line in sys.stdin:
        sys.stdout.write(mask_text(line, pw))


# ---------------------------------------------------------------- command policy

READ_CMDS = {
    "cat", "head", "tail", "grep", "egrep", "fgrep", "zgrep", "zegrep", "zcat", "ls", "pwd", "cd", "tree",
    "wc", "sort", "uniq", "cut", "tr", "awk", "gawk", "sed", "find", "stat", "file", "du", "df", "free",
    "uptime", "whoami", "hostname", "id", "date", "ps", "pgrep", "pidof", "ss", "netstat", "lsof", "vmstat",
    "iostat", "mpstat", "nproc", "lscpu", "lsblk", "uname", "which", "readlink", "realpath", "basename",
    "dirname", "md5sum", "sha1sum", "sha256sum", "diff", "cmp", "jq", "column", "nl", "rev", "echo", "printf",
    "true", "test", "[", "ip", "ifconfig", "jps", "jstack", "jstat", "strings", "xxd", "od", "nslookup", "dig",
    "ping", "printenv", "env", "git", "curl", "systemctl", "journalctl", "top", "java", "nginx", "crontab",
    "timeout", "getent", "groups", "last", "w", "who", "zless", "tac", "fold", "expand", "base64",
}
SHELLS = {"bash", "sh", "zsh", "dash", "ksh", "eval", "exec", "source", ".", "xargs", "python", "python3",
          "perl", "ruby", "node", "php", "lua", "nohup", "setsid", "su", "sudo", "doas"}
WRITE_DENY = {"rm", "rmdir", "unlink", "shred", "dd", "truncate", "chmod", "chown", "chgrp", "chattr",
              "reboot", "shutdown", "halt", "poweroff", "init", "kill", "pkill", "killall", "iptables",
              "useradd", "userdel", "usermod", "passwd", "mount", "umount", "fdisk", "parted", "wipefs"}
SEGMENT_OPS = {"|", "||", "&&", ";"}
REDIRECTS = {">", ">>", ">&", "&>", ">|", "<", "<<", "<<<", "&>>"}
GIT_READ = {"status", "log", "diff", "show", "rev-parse", "ls-files", "blame", "shortlog", "describe",
            "branch", "config", "remote", "tag", "cat-file", "reflog"}
GIT_WRITE_DENY = {"push", "reset", "clean", "checkout", "restore", "rebase", "rm", "stash", "filter-branch",
                  "gc", "prune", "update-ref", "switch", "am", "cherry-pick", "merge", "pull", "fetch"}


def _tokens(cmd):
    lex = shlex.shlex(cmd, posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    return list(lex)


def _segments(tokens):
    seg = []
    for t in tokens:
        if t in SEGMENT_OPS:
            yield seg
            seg = []
        else:
            seg.append(t)
    yield seg


def _strip_prefix(seg):
    """Drop VAR=value assignments and a leading `timeout [opts] N`."""
    i = 0
    while i < len(seg) and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", seg[i]):
        i += 1
    seg = seg[i:]
    if seg and seg[0] == "timeout":
        j = 1
        while j < len(seg) and seg[j].startswith("-"):
            j += 1
        seg = seg[j + 1:]
    return seg


def _has(args, *flags):
    for a in args:
        for f in flags:
            if a == f or (f.startswith("--") and a.startswith(f + "=")) or (len(f) == 2 and a.startswith(f) and not a.startswith("--")):
                return True
    return False


def _read_rule(name, args):
    if name == "sed" and (_has(args, "-i", "--in-place") or any(re.search(r"(^|[;}/])\s*w\s", a) for a in args)):
        return "sed may only print here (no -i, no w command)"
    if name == "find" and _has(args, "-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"):
        return "find may only list here (no -delete or -exec)"
    if name in ("awk", "gawk") and any(re.search(r"system\s*\(|print[f]?[^;{}]*>|\|\s*\"|\"\s*\||getline", a) for a in args):
        return "awk may only print here (no system, getline, pipes or > redirects)"
    if name in ("tail", "journalctl") and _has(args, "-f", "-F", "--follow"):
        return "follow mode never returns; read a fixed number of lines instead"
    if name == "journalctl" and _has(args, "--vacuum-size", "--vacuum-time", "--vacuum-files", "--rotate", "--flush"):
        return "journalctl may only read here"
    if name == "sort" and _has(args, "-o", "--output"):
        return "sort -o writes a file"
    if name == "uniq" and len([a for a in args if not a.startswith("-")]) > 1:
        return "uniq with an output file writes it"
    if name == "date" and _has(args, "-s", "--set"):
        return "date -s changes the clock"
    if name == "hostname" and [a for a in args if not a.startswith("-")]:
        return "hostname NAME renames the host"
    if name == "env" and args:
        return "env with arguments runs a command"
    if name == "top" and "-b" not in args:
        return "top needs -b -n 1 (batch mode)"
    if name == "java" and args not in (["-version"], ["--version"]):
        return "java is allowed only as java -version"
    if name == "nginx" and (not args or any(a not in ("-t", "-T", "-v", "-V") for a in args)):
        return "nginx is allowed only with -t, -T, -v or -V"
    if name == "crontab" and args != ["-l"]:
        return "crontab is allowed only as crontab -l"
    if name == "ip" and any(a in ("add", "del", "delete", "set", "flush", "change", "replace", "append") for a in args):
        return "ip may only show here"
    if name == "ifconfig" and [a for a in args if a not in ("-a", "-s")][1:]:
        return "ifconfig may only show here"
    if name == "systemctl" and (not args or args[0] not in ("status", "list-units", "list-unit-files", "is-active", "is-enabled", "show", "cat")):
        return "systemctl may only show status here"
    if name == "git":
        rest = list(args)
        while rest and rest[0] in ("-C", "--git-dir", "--work-tree", "-c"):
            rest = rest[2:]
        if rest == ["--version"]:
            return None
        if not rest or rest[0] not in GIT_READ:
            return "git is allowed only for status, log, diff, show and similar reads"
        sub, sargs = rest[0], rest[1:]
        if sub == "config" and not _has(sargs, "--get", "--get-all", "--list", "-l"):
            return "git config may only be read (--get or --list)"
        if sub in ("branch", "tag", "remote") and [a for a in sargs if a not in ("-a", "-r", "-v", "-vv", "--list", "-l")]:
            return f"git {sub} may only list"
    if name == "curl":
        if _has(args, "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "-F", "--form",
                "-T", "--upload-file", "-o", "-O", "--output", "--remote-name", "-K", "--config"):
            return "curl may only GET here (no upload, form, data or output file)"
        for i, a in enumerate(args):
            m = a[2:] if a.startswith("-X") and len(a) > 2 else (args[i + 1] if a in ("-X", "--request") and i + 1 < len(args) else None)
            if m is not None and m.upper() not in ("GET", "HEAD"):
                return "curl may only GET or HEAD here"
    return None


def check(mode, cmd):
    if "\n" in cmd or "\r" in cmd:
        return "one command line only"
    if "`" in cmd or "$(" in cmd or "<(" in cmd or ">(" in cmd:
        return "command substitution is not allowed"
    try:
        tokens = _tokens(cmd)
    except ValueError as e:
        return f"cannot parse command: {e}"
    if not tokens:
        return "empty command"
    for i, t in enumerate(tokens):
        if t in ("&", "(", ")", "{", "}"):
            return "background jobs, subshells and groups are not allowed"
        if t in REDIRECTS:
            nxt = tokens[i + 1] if i + 1 < len(tokens) else ""
            if t in ("<", "<<", "<<<"):
                continue
            if nxt == "/dev/null" or (t == ">&" and nxt in ("1", "2")):
                continue
            if mode == "write" and t in (">>", "&>>"):
                continue
            return "output redirection to a file is not allowed" + (" (use >> to append)" if mode == "write" else "")
    for seg in _segments(tokens):
        seg = [t for t in _strip_prefix(seg) if t not in REDIRECTS]
        if not seg:
            continue
        name = os.path.basename(seg[0])
        args = seg[1:]
        if name in SHELLS:
            return f"'{name}' runs other commands and is not allowed"
        if mode == "read":
            if name not in READ_CMDS:
                return f"'{name}' is not on the read-only list"
            why = _read_rule(name, args)
            if why:
                return why
        else:
            if name in WRITE_DENY:
                return f"'{name}' is blocked on UAT"
            if name == "find" and _has(args, "-delete"):
                return "find -delete is blocked on UAT"
            if name in ("mv", "cp") and not _has(args, "-n", "--no-clobber"):
                return f"{name} must use -n so it never overwrites a file"
            if name == "crontab" and args != ["-l"]:
                return "crontab changes are blocked on UAT"
            if name == "systemctl" and args and args[0] not in ("status", "list-units", "is-active", "show"):
                return "systemctl changes are blocked on UAT"
            if name == "rsync" and any(a.startswith("--delete") or a == "--remove-source-files" for a in args):
                return "rsync deletion is blocked on UAT"
            if name == "git":
                rest = list(args)
                while rest and rest[0] in ("-C", "--git-dir", "--work-tree", "-c"):
                    rest = rest[2:]
                if rest and rest[0] in GIT_WRITE_DENY:
                    return f"git {rest[0]} is blocked on UAT"
                if rest and rest[0] == "branch" and _has(rest[1:], "-d", "-D", "--delete", "-m", "-M"):
                    return "git branch deletion and renames are blocked on UAT"
    return None


def cmd_check(mode, cmd):
    why = check(mode, cmd)
    if why:
        print(f"REFUSED ({mode}): {why}")
        return 1
    return 0


# Template commands (start, stop, deploy and rollback steps) are reviewed in git and shown in every plan, so they may
# use kill, nohup, & and > the way start and stop scripts do; only clearly destructive commands are refused.
TEMPLATE_DENY = {"rm", "rmdir", "unlink", "shred", "dd", "mkfs", "truncate", "sudo", "su", "doas", "reboot", "shutdown",
                 "halt", "poweroff", "init", "useradd", "userdel", "usermod", "passwd", "iptables", "mount", "umount",
                 "fdisk", "parted", "wipefs", "chown", "chgrp", "chattr", "killall"}
TEMPLATE_DENY_RE = re.compile(r"(^|[\s;&|(`$])(" + "|".join(sorted(TEMPLATE_DENY, key=len, reverse=True)) + r")(?=\s|$|;|\))")


def check_template_cmd(cmd):
    m = TEMPLATE_DENY_RE.search(cmd)
    if m:
        return f"'{m.group(2)}' is not allowed in template commands; nothing is deleted or reconfigured on UAT"
    try:
        tokens = _tokens(cmd)
    except ValueError as e:
        return f"cannot parse command: {e}"
    for seg in _segments(tokens):
        seg = [t for t in _strip_prefix(seg) if t not in REDIRECTS]
        if not seg:
            continue
        name, args = os.path.basename(seg[0]), seg[1:]
        if name == "git":
            rest = list(args)
            while rest and rest[0] in ("-C", "--git-dir", "--work-tree", "-c"):
                rest = rest[2:]
            if rest and rest[0] in GIT_WRITE_DENY:
                return f"git {rest[0]} is not allowed in template commands"
        if name == "find" and _has(args, "-delete"):
            return "find -delete is not allowed in template commands"
        if name == "rsync" and any(a.startswith("--delete") or a == "--remove-source-files" for a in args):
            return "rsync deletion is not allowed in template commands"
        if name == "crontab" and args != ["-l"]:
            return "crontab changes are not allowed in template commands"
        if name == "systemctl" and args and args[0] not in ("status", "is-active", "show", "--user"):
            return "systemctl changes need sudo, which template commands cannot use"
    return None


# ---------------------------------------------------------------- start script edit

# -jar, an optional opening quote, an optional folder, then the jar's file name; only the file name is swapped
JAR_RE = re.compile(r"(-jar\s+[\"']?)((?:[^\s\"']*/)?)([^\s\"'/]+\.jar)")
JAVA_RE = re.compile(r"(^|[\s/\"'])java[\"']?\s")


def cmd_swapjar(mode, path, newjar, out, appdir=None):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*\.jar", newjar):
        print(f"FAIL new jar name '{newjar}' must be letters, digits, . _ - and end in .jar")
        return 1
    with open(path, newline="") as f:
        lines = f.readlines()
    active = [i for i, l in enumerate(lines) if JAR_RE.search(l) and not l.lstrip().startswith("#")]
    if len(active) != 1:
        where = ", ".join(str(i + 1) for i in active) or "none"
        print(f"FAIL expected exactly one active -jar line, found {len(active)} (lines: {where})")
        return 1
    i = active[0]
    line = lines[i]
    m = JAR_RE.search(line)
    folder, old = m.group(2), m.group(3)
    if old == newjar:
        print(f"FAIL {newjar} is already the active jar")
        return 1
    # push copies the jar into the app folder, so a fixed folder elsewhere would point the script at nothing
    fixed = folder.startswith("/") and "$" not in folder
    if fixed and appdir and os.path.normpath(folder) != os.path.normpath(appdir):
        print(f"FAIL the start script runs the jar from {folder}, but push copies {newjar} to {appdir}")
        return 1
    new_line = JAR_RE.sub(lambda m: m.group(1) + m.group(2) + newjar, line, count=1)
    if mode == "replace":
        lines[i] = new_line
    elif mode == "duplicate":
        # the commented copy must hold the whole command: no backslash continuation into or out of this line
        continued = i > 0 and lines[i - 1].rstrip("\r\n").endswith("\\")
        if continued or line.rstrip("\r\n").endswith("\\") or not JAVA_RE.search(line):
            print("FAIL duplicate mode needs the whole java command on the -jar line; use replace for multi-line scripts")
            return 1
        lines[i:i + 1] = ["# " + line, new_line]
    else:
        print(f"FAIL unknown edit mode '{mode}'")
        return 1
    with open(out, "w", newline="") as f:
        f.writelines(lines)
    with open(path, newline="") as f:
        before = f.readlines()
    print(f"OLD_JAR={folder}{old}")
    print(f"LINE={i + 1}")
    if folder and not fixed:
        print(f"WARN  the start script runs the jar from {folder}; push copies {newjar} to the app folder, so check that is the same folder")
    pw = _password()
    for d in difflib.unified_diff(before, lines, "before", "after", n=1):
        sys.stdout.write(mask_text(d if d.endswith("\n") else d + "\n", pw))
    return 0


# ---------------------------------------------------------------- yaml


def _yaml():
    try:
        import yaml
        return yaml
    except ImportError:
        print("FAIL PyYAML is missing: pip install --user pyyaml")
        sys.exit(1)


def _preview(key, node):
    yaml = _yaml()
    if isinstance(node, yaml.ScalarNode):
        v = node.value
        if SECRET_KEY.search(key):
            return "****"
        return v if len(v) <= 80 else v[:77] + "..."
    if isinstance(node, yaml.MappingNode):
        return f"<mapping, {len(node.value)} keys>"
    return f"<list, {len(node.value)} items>"


def _walk(node, path, out):
    yaml = _yaml()
    if isinstance(node, yaml.MappingNode):
        for k, v in node.value:
            name = str(k.value)
            p = f"{path}.{name}" if path else name
            out.append((p, k.start_mark.line + 1, v))
            _walk(v, p, out)
    elif isinstance(node, yaml.SequenceNode):
        for i, item in enumerate(node.value):
            _walk(item, f"{path}[{i}]", out)


def cmd_yaml_find(path, key):
    yaml = _yaml()
    with open(path) as f:
        text = f.read()
    hits, names = [], set()
    for doc, root in enumerate(yaml.compose_all(text)):
        nodes = []
        _walk(root, "", nodes)
        for p, line, v in nodes:
            names.add(p.rsplit(".", 1)[-1])
            if p == key or p.endswith("." + key):
                end = v.end_mark.line if isinstance(v, (yaml.MappingNode, yaml.SequenceNode)) else v.end_mark.line + 1
                hits.append((doc, line, max(line, end), p, _preview(p, v)))
    if not hits:
        print(f"NOT FOUND: {key}")
        close = difflib.get_close_matches(key.rsplit(".", 1)[-1], sorted(names), n=5, cutoff=0.6)
        if close:
            print("similar keys: " + ", ".join(close))
        return 1
    for doc, line, end, p, prev in hits:
        rng = f"line {line}" if end == line else f"lines {line}-{end}"
        print(f"FOUND doc {doc} {rng}: {p} = {prev}")
    return 0


def _unique_loader():
    yaml = _yaml()

    class Loader(yaml.SafeLoader):
        pass

    def construct_mapping(loader, node, deep=False):
        seen = {}
        for k, _ in node.value:
            if k.tag == "tag:yaml.org,2002:merge":
                continue
            key = loader.construct_object(k, deep=deep)
            try:
                if key in seen:
                    raise yaml.constructor.ConstructorError(
                        None, None, f"duplicate key '{key}' (first at line {seen[key]})", k.start_mark)
                seen[key] = k.start_mark.line + 1
            except TypeError:
                pass
        return yaml.SafeLoader.construct_mapping(loader, node, deep)

    Loader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, construct_mapping)
    return Loader


def _load_all(path):
    yaml = _yaml()
    with open(path) as f:
        return list(yaml.load_all(f, Loader=_unique_loader()))


def cmd_yaml_check(path):
    yaml = _yaml()
    try:
        docs = _load_all(path)
    except yaml.YAMLError as e:
        print(f"FAIL {path}: {e}")
        return 1
    with open(path) as f:
        tabs = [i + 1 for i, l in enumerate(f) if l.startswith("\t") or re.match(r"^ *\t", l)]
    if tabs:
        print(f"FAIL tab indentation on lines {tabs[:10]}")
        return 1
    print(f"OK {len(docs)} document(s), no duplicate keys")
    return 0


def _flatten(obj, path, out):
    if isinstance(obj, dict):
        for k, v in obj.items():
            _flatten(v, f"{path}.{k}" if path else str(k), out)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            _flatten(v, f"{path}[{i}]", out)
    else:
        out[path] = obj


ABSENT = "<absent>"
# helper output masks secrets, and a plain value starting with * reads as a YAML alias, so it is quoted before parsing
MASKED_RE = re.compile(r"^([ \t]*(?:-[ \t]+)?(?:[^\s#][^#\n]*?:[ \t]+)?)(\*\*\*\*[^\s#]*)(?=[ \t]*(?:#.*)?$)", re.M)
# a "key: value" line in a diff, including commented-out lines and list items; the key may be quoted
DIFF_KEY_RE = re.compile(r"^([ +-]\s*(?:#\s*)?(?:-\s+)?)([^\s#:'\"][^:#]*?|'[^']*'|\"[^\"]*\")(\s*:\s+)(\S.*)$")


def _same(a, b):
    """Equal in type as well as value, so 1 -> true and 0 -> false count as changes."""
    return type(a) is type(b) and a == b


def _loose(v):
    """A scalar as the config server may render it: values can come back as strings."""
    return "" if v is None else str(v).lower() if isinstance(v, bool) else str(v)


def _changed(da, db):
    """(doc, path, before, after) for every scalar path that differs between two lists of documents."""
    for i in range(max(len(da), len(db))):
        fa, fb = {}, {}
        _flatten(da[i] if i < len(da) else {}, "", fa)
        _flatten(db[i] if i < len(db) else {}, "", fb)
        for p in sorted(set(fa) | set(fb)):
            va, vb = fa.get(p, ABSENT), fb.get(p, ABSENT)
            if not _same(va, vb):
                yield i, p, va, vb


def _mask_diff_line(line, pw):
    m = DIFF_KEY_RE.match(line)
    if m and SECRET_KEY.search(m.group(2)):
        line = m.group(1) + m.group(2) + m.group(3) + "****\n"
    return mask_text(line, pw)


def cmd_yaml_diff(old, new):
    with open(old) as f:
        a = f.readlines()
    with open(new) as f:
        b = f.readlines()
    pw = _password()
    diff = list(difflib.unified_diff(a, b, "server (before)", "edited (after)", n=2))
    if not diff:
        print("NO CHANGES")
        return 1
    for d in diff:
        sys.stdout.write(_mask_diff_line(d if d.endswith("\n") else d + "\n", pw))
    yaml = _yaml()
    try:
        da, db = _load_all(old), _load_all(new)
    except yaml.YAMLError as e:
        print(f"\nFAIL edited file does not parse: {e}")
        return 1
    print("\nCHANGED PATHS")
    shown = 0
    for i, p, va, vb in _changed(da, db):
        if SECRET_KEY.search(p):
            va, vb = ("****" if va != ABSENT else va), ("****" if vb != ABSENT else vb)
        elif ABSENT not in (va, vb) and type(va) is not type(vb):
            va, vb = json.dumps(va, default=str), json.dumps(vb, default=str)
        tag = "+" if va == ABSENT else "-" if vb == ABSENT else "~"
        print(mask_text(f"  {tag} doc {i}: {p}: {va} -> {vb}", pw))
        shown += 1
    if not shown:
        print("  (none: only comments or formatting changed)")
    return 0


def cmd_format_check(fmt, path):
    """Syntax check for a config file of any format the templates support."""
    if fmt == "yaml":
        return cmd_yaml_check(path)
    try:
        text = open(path).read()
    except OSError as e:
        print(f"FAIL {path}: {e.strerror}")
        return 1
    if fmt == "json":
        try:
            json.loads(text)
        except ValueError as e:
            print(f"FAIL {path}: {e}")
            return 1
    elif fmt == "xml":
        import xml.etree.ElementTree as ET
        try:
            ET.fromstring(text)
        except ET.ParseError as e:
            print(f"FAIL {path}: {e}")
            return 1
    elif fmt == "properties":
        seen, dup = {}, []
        for i, line in enumerate(text.splitlines(), 1):
            s = line.strip()
            if not s or s[0] in "#!":
                continue
            k = re.split(r"\s*[=:]\s*|\s+", s, maxsplit=1)[0]
            if k in seen:
                dup.append(f"'{k}' on lines {seen[k]} and {i}")
            seen[k] = i
        if dup:
            print("FAIL duplicate keys: " + "; ".join(dup[:5]))
            return 1
    print(f"OK {fmt}")
    return 0


PROP_KEY_RE = re.compile(r"^([ +-]\s*(?:#\s*)?)([^\s=:#!][^=:]*?)(\s*[=:]\s*)(\S.*)$")


def cmd_text_diff(old, new):
    with open(old) as f:
        a = f.readlines()
    with open(new) as f:
        b = f.readlines()
    pw = _password()
    diff = list(difflib.unified_diff(a, b, "server (before)", "edited (after)", n=2))
    if not diff:
        print("NO CHANGES")
        return 1
    for d in diff:
        d = d if d.endswith("\n") else d + "\n"
        m = PROP_KEY_RE.match(d) or DIFF_KEY_RE.match(d)
        if m and SECRET_KEY.search(m.group(2)):
            d = m.group(1) + m.group(2) + m.group(3) + "****\n"
        sys.stdout.write(mask_text(d, pw))
    return 0


def cmd_yaml_served(old, new, served, key=None):
    yaml = _yaml()
    try:
        da, db = _load_all(old), _load_all(new)
        with open(served) as f:
            ds = [d for d in yaml.safe_load_all(MASKED_RE.sub(r"\1'\2'", f.read())) if d is not None]
    except yaml.YAMLError as e:
        print(f"FAIL cannot parse: {e}")
        print("SERVED=no")
        return 1
    fs = {}
    for d in ds:
        _flatten(d, "", fs)
    changes = [c for c in _changed(da, db) if not key or c[1] == key or c[1].endswith("." + key)]
    if not changes:
        print(f"FAIL no changed path matches '{key}'" if key else "FAIL the edited copy changes no values")
        print("SERVED=no")
        return 1
    pw = _password()
    bad = 0
    for i, p, _, want in changes:
        got = fs.get(p, ABSENT)
        if want == ABSENT:
            ok = got == ABSENT
            msg = "removed, not served" if ok else "removed in the edit, but still served (it may come from another file)"
        elif SECRET_KEY.search(p):
            # served secrets come back masked, so only their presence can be checked
            ok = got != ABSENT
            msg = "secret; served, value not compared" if ok else "secret; not served"
        else:
            ok = got != ABSENT and _loose(got) == _loose(want)
            w, g = _loose(want), _loose(got)
            msg = f"= {w}" if ok else f"not served (expected {w})" if got == ABSENT else f"served {g}, expected {w}"
        bad += not ok
        print(mask_text(f"  {'OK   ' if ok else 'WRONG'} doc {i}: {p} {msg}", pw))
    print("SERVED=yes" if not bad else f"SERVED=no ({bad} of {len(changes)} path(s) do not match)")
    return 1 if bad else 0


# ---------------------------------------------------------------- hook


def _marks():
    """Every server of every template: host names and ssh aliases."""
    try:
        import uattpl
        return uattpl.server_marks()
    except Exception:
        return []


def cmd_guard():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return 0
    if data.get("tool_name") != "Bash":
        return 0
    cmd = (data.get("tool_input") or {}).get("command") or ""
    skill = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    wrapper = os.path.realpath(os.path.join(skill, "scripts", "uat"))
    if "uat-deploy/password" in cmd:
        print("uat-deploy: UAT password files are never read or printed by commands; the uat helper uses them directly.", file=sys.stderr)
        return 2
    if "uat-deploy/console" in cmd:
        print("uat-deploy: the console page's session belongs to the user; approvals are given on the page, never through its API.", file=sys.stderr)
        return 2
    if not re.search(r"\b(ssh|scp|sftp|rsync|sshpass)\b", cmd):
        return 0
    marks = _marks()
    if not any(m in cmd for m in marks):
        return 0
    try:
        segs = list(_segments(_tokens(cmd)))
    except ValueError:
        segs = [[cmd]]
    for seg in segs:
        seg = _strip_prefix(seg)
        if not seg:
            continue
        first = os.path.realpath(os.path.expanduser(seg[0]))
        if first == wrapper:
            continue
        text = " ".join(seg)
        if re.search(r"\b(ssh|scp|sftp|rsync|sshpass)\b", text) and any(m in text for m in marks):
            print(f"uat-deploy: reach UAT only through {wrapper} (read, write, get, push, restart ...), never with ssh/scp directly.", file=sys.stderr)
            return 2
    return 0


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    op, args = argv[0], argv[1:]
    if op == "mask":
        return cmd_mask()
    if op == "check" and len(args) == 2 and args[0] in ("read", "write"):
        return cmd_check(*args)
    if op == "swapjar" and len(args) in (4, 5):
        return cmd_swapjar(*args)
    if op == "yaml-find" and len(args) == 2:
        return cmd_yaml_find(*args)
    if op == "yaml-check" and len(args) == 1:
        return cmd_yaml_check(*args)
    if op == "yaml-diff" and len(args) == 2:
        return cmd_yaml_diff(*args)
    if op == "yaml-served" and len(args) in (3, 4):
        return cmd_yaml_served(*args)
    if op == "format-check" and len(args) == 2:
        return cmd_format_check(*args)
    if op == "text-diff" and len(args) == 2:
        return cmd_text_diff(*args)
    if op == "guard":
        return cmd_guard()
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]) or 0)
