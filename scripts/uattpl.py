#!/usr/bin/env python3
"""Project templates for the uat-deploy skill.

A template (templates/<id>.yml) describes one project on UAT: its servers, its apps, how each app is built, deployed,
started, stopped and checked, its config files, and instructions. Templates are shared through git, so nothing in
them is personal or secret. Per-user values (local repo folders, build overrides, git identity, how to sign in to
each server, the chosen template) live in ~/.config/uat-deploy/local.yml; passwords in ~/.config/uat-deploy/passwords/.

  templates                     list the templates
  use ID                        choose the template later commands work on
  check [ID|FILE]               validate a template; exit 1 on errors
  apps                          apps of the chosen template
  instructions [APP]            the template's instructions and server notes (and one app's)
  env APP [CFG|-]               shell assignments for one app (and one config file) for the uat helper
  server-ids                    servers the chosen template's apps use
  server-env [SERVER]           shell assignments for one server
  check-plan                    what check-paths verifies, by server
  show                          the chosen template with this machine's values
  setup-status                  what is configured and what is missing
  local-set KEY VALUE           save one setting for this machine
  save-password [SERVER]        save the password for a server, read from stdin
The chosen template is UAT_TEMPLATE_FILE (a draft file), else UAT_TEMPLATE (an id), else the one saved with use,
else the only template there is.
"""
import getpass
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import uatlib  # noqa: E402

SKILL = HERE.parent
TEMPLATES = SKILL / "templates"
CONF_DIR = Path(os.environ.get("UAT_DEPLOY_CONFIG_DIR") or Path.home() / ".config" / "uat-deploy")
CACHE_DIR = Path(os.environ.get("UAT_DEPLOY_CACHE_DIR") or Path.home() / ".cache" / "uat-deploy")
STATE_DIR = Path(os.environ.get("UAT_DEPLOY_STATE_DIR") or Path.home() / ".local" / "state" / "uat-deploy")
LOCAL = CONF_DIR / "local.yml"
PASSWORDS = CONF_DIR / "passwords"

SCHEMA = 1
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
USER_RE = re.compile(r"^[a-z_][a-z0-9_.-]{0,31}$")
HOST_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$")
PATH_RE = re.compile(r"^/[A-Za-z0-9._/@+~-]*$")
REL_RE = re.compile(r"^(?!/)(?!.*(^|/)\.\.(/|$))[A-Za-z0-9._/@+*-]+$")
PROD_RE = re.compile(r"(^|[^a-z])(prod|production|live)([^a-z]|$)", re.I)
STYLES = ("jar-start-script", "custom", "none")
EDITS = ("duplicate", "replace")
FORMATS = ("yaml", "properties", "json", "xml", "text")
PLACEHOLDERS = ("new", "dir", "upload_dir", "stamp")
PLACEHOLDER_RE = re.compile(r"\{([A-Za-z_]+)\}")
EXT_RE = re.compile(r"\*((?:\.[A-Za-z0-9]+)+)$")
SECRET_KEY_RE = re.compile(r"(password|passwd|secret|token|private[_-]?key|credential)", re.I)
SECRET_VALUE_RE = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY|\bsshpass\b|\b(password|passwd|pwd|secret)\s*=\s*['\"]?[^\s'\"{}$]", re.I)
SPRING_READY = {"log": "Started [A-Za-z0-9_$]+ in [0-9.]+ seconds", "fail": "APPLICATION FAILED TO START"}
DEFAULT_START_TIMEOUT = 180
DEFAULT_STOP_TIMEOUT = 30

ORDER = {
    "top": ["schema", "id", "name", "description", "servers", "defaults", "apps", "instructions"],
    "server": ["label", "host", "user", "aliases", "notes"],
    "defaults": ["start_timeout", "stop_timeout", "ready"],
    "app": ["id", "name", "server", "dir", "port", "process", "log", "start", "stop", "start_timeout", "stop_timeout",
            "ready", "build", "deploy", "configs", "instructions"],
    "ready": ["log", "fail", "url"],
    "build": ["repo", "detect", "command", "output"],
    "deploy": ["style", "start_script", "edit", "name_prefix", "upload_dir", "steps", "rollback"],
    "config": ["id", "path", "format", "git_repo", "served_by", "verify_url", "restart", "notes"],
}
CHILD = {("top", "defaults"): "defaults", ("defaults", "ready"): "ready", ("app", "ready"): "ready",
         ("app", "build"): "build", ("app", "deploy"): "deploy"}
LIST_CHILD = {("top", "apps"): "app", ("app", "configs"): "config"}
INTS = {"schema", "port", "start_timeout", "stop_timeout"}


class TemplateError(Exception):
    pass


def _yaml():
    try:
        import yaml
        return yaml
    except ImportError:
        raise TemplateError("PyYAML is missing: pip install --user pyyaml")


def _s(v):
    return isinstance(v, str) and v.strip() != ""


# ---------------------------------------------------------------- normalize and render


def _clean_str(v):
    v = v.replace("\r\n", "\n")
    if "\n" in v.strip("\n"):
        return "\n".join(line.rstrip() for line in v.strip("\n").split("\n")) + "\n"
    return v.strip()


def _norm_value(kind, key, v):
    if isinstance(v, str):
        v = _clean_str(v)
        return int(v) if key in INTS and re.fullmatch(r"\d{1,9}", v) else v
    if isinstance(v, list):
        sub = LIST_CHILD.get((kind, key))
        items = [_norm(x, sub) if sub else _norm_value(kind, key, x) for x in v]
        return [x for x in items if x not in (None, "", [], {})]
    if isinstance(v, dict):
        if (kind, key) == ("top", "servers"):
            return {str(k).strip(): _norm(s, "server") for k, s in v.items()}
        sub = CHILD.get((kind, key))
        return _norm(v, sub) if sub else v
    if isinstance(v, float) and key in INTS and v.is_integer():
        return int(v)
    return v


def _norm(obj, kind):
    if not isinstance(obj, dict):
        return obj
    order = ORDER[kind]
    out = {}
    for k in [k for k in order if k in obj] + [k for k in obj if k not in order]:
        v = _norm_value(kind, k, obj[k])
        if v is None or v == "" or v == [] or v == {}:
            continue
        out[k] = v
    if kind == "app" and out.get("deploy") == {"style": "none"}:
        del out["deploy"]
    return out


def normalize(t):
    return _norm(t, "top") if isinstance(t, dict) else t


def render(t):
    yaml = _yaml()

    class Dumper(yaml.SafeDumper):
        def increase_indent(self, flow=False, indentless=False):
            return super().increase_indent(flow, False)

    def str_rep(d, s):
        return d.represent_scalar("tag:yaml.org,2002:str", s, style="|" if "\n" in s else None)

    Dumper.add_representer(str, str_rep)
    tid = t.get("id", "ID") if isinstance(t, dict) else "ID"
    head = (f"# UAT template for the uat-deploy skill. Edit it from /uat-deploy (Edit template) or by hand,\n"
            f"# then check it with: uat template-check {tid}\n")
    return head + yaml.dump(t, Dumper=Dumper, sort_keys=False, allow_unicode=True, width=4096, default_flow_style=False)


# ---------------------------------------------------------------- derived values


def script_of(cmd):
    """The script a command runs from the app folder (./x.sh or bash x.sh), or None."""
    try:
        toks = shlex.split(cmd or "")
    except ValueError:
        return None
    while toks and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", toks[0]):
        toks = toks[1:]
    if not toks:
        return None
    if toks[0].startswith("./") and "/" not in toks[0][2:]:
        return toks[0][2:]
    if toks[0] in ("bash", "sh") and len(toks) > 1 and re.fullmatch(r"(\./)?[A-Za-z0-9._-]+\.sh", toks[1]):
        return toks[1].removeprefix("./")
    return None


def start_script(app):
    d = app.get("deploy") or {}
    return d.get("start_script") or script_of(app.get("start"))


def artifact_ext(app):
    m = EXT_RE.search(((app.get("build") or {}).get("output") or "").rsplit("/", 1)[-1])
    return m.group(1) if m else ""


def ready_of(t, app):
    return app.get("ready") if app.get("ready") else ((t.get("defaults") or {}).get("ready") or {})


def timeout_of(t, app, key, default):
    return app.get(key) or (t.get("defaults") or {}).get(key) or default


# ---------------------------------------------------------------- validate


def _label(t, path):
    out = []
    for i, p in enumerate(path):
        if isinstance(p, int) and i > 0:
            parent = path[i - 1]
            items = t.get(parent) if i == 1 else None
            if parent == "configs":
                items = t["apps"][path[1]].get("configs") if isinstance(t.get("apps"), list) else None
            name = None
            try:
                name = items[p].get("id") if items else None
            except (AttributeError, IndexError, TypeError):
                pass
            out[-1] += f"[{name or p}]"
        else:
            out.append(str(p))
    return ".".join(out)


def _unknown(obj, kind, path, err):
    for k in obj:
        if k not in ORDER[kind]:
            err(path + (k,), f"unknown field '{k}'")


def _secrets(obj, path, err):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if SECRET_KEY_RE.search(str(k)):
                err(path + (k,), "templates are shared in git; keep passwords, tokens and keys out of them")
            _secrets(v, path + (k,), err)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            _secrets(v, path + (i,), err)
    elif isinstance(obj, str) and SECRET_VALUE_RE.search(obj):
        err(path, "this looks like a secret; templates are shared in git, so keep passwords and keys out of them")


def _command(path, cmd, err, allowed, what="command"):
    if not _s(cmd):
        err(path, f"enter the {what}")
        return
    if "\n" in cmd.strip():
        err(path, "one line only; put longer logic in a script on the server")
        return
    bad = sorted({p for p in PLACEHOLDER_RE.findall(cmd) if p not in allowed})
    if bad:
        err(path, f"unknown placeholder {{{bad[0]}}}; available: " + ", ".join("{" + p + "}" for p in allowed))
        return
    why = uatlib.check_template_cmd(PLACEHOLDER_RE.sub("x", cmd))
    if why:
        err(path, why)


def _abs(path, v, err, what, required=False):
    if v in (None, ""):
        if required:
            err(path, f"enter {what} as an absolute path")
        return
    if not isinstance(v, str) or not PATH_RE.match(v):
        err(path, f"{what}: an absolute path (/opt/...) with no spaces or quotes")


def _regex(path, v, err):
    if v in (None, ""):
        return
    try:
        re.compile(v)
    except re.error as e:
        err(path, f"not a valid pattern: {e}")


def _url(path, v, err):
    if v not in (None, "") and not (isinstance(v, str) and re.match(r"^https?://\S+$", v)):
        err(path, "an http:// or https:// URL")


def _pos_int(path, v, err, hi=86400):
    if v in (None, ""):
        return
    if not isinstance(v, int) or isinstance(v, bool) or not 0 < v <= hi:
        err(path, f"a whole number from 1 to {hi}")


def validate(t, stem=None):
    """(errors, warnings): lists of {path, label, message}."""
    errors, warnings = [], []

    def add(bucket, path, msg):
        bucket.append({"path": list(path), "label": _label(t, path) if isinstance(t, dict) else "", "message": msg})

    def err(path, msg):
        add(errors, path, msg)

    def warn(path, msg):
        add(warnings, path, msg)

    if not isinstance(t, dict):
        err((), "the template must be a YAML mapping")
        return errors, warnings
    _unknown(t, "top", (), err)
    if t.get("schema") != SCHEMA:
        err(("schema",), f"schema must be {SCHEMA}")
    tid = t.get("id")
    if not isinstance(tid, str) or not ID_RE.match(tid):
        err(("id",), "1 to 32 lowercase letters, digits or -, starting with a letter or digit")
    elif stem and tid != stem:
        err(("id",), f"the id must match the file name ({stem}.yml)")
    if not _s(t.get("name")):
        err(("name",), "give the template a name")

    servers = t.get("servers")
    if not isinstance(servers, dict) or not servers:
        err(("servers",), "add at least one server")
        servers = {}
    for sid, s in servers.items():
        p = ("servers", sid)
        if not ID_RE.match(str(sid)):
            err(p + ("id",), "server id: lowercase letters, digits or -")
        if not isinstance(s, dict):
            err(p, "must be a mapping")
            continue
        _unknown(s, "server", p, err)
        if PROD_RE.search(str(sid)) or PROD_RE.search(str(s.get("label") or "")):
            err(p + ("label",), "production servers are not allowed; this skill is for UAT only")
        if not _s(s.get("host")):
            err(p + ("host",), "enter the server's IP address or host name")
        elif not HOST_RE.match(s["host"]) or "@" in s["host"]:
            err(p + ("host",), "an IP address or host name only, without user@")
        if not _s(s.get("user")):
            err(p + ("user",), "enter the user you log in as")
        elif not USER_RE.match(s["user"]):
            err(p + ("user",), "a Linux user name")
        aliases = s.get("aliases") or []
        if not isinstance(aliases, list) or not all(isinstance(a, str) and re.fullmatch(r"[A-Za-z0-9._-]+", a) for a in aliases):
            err(p + ("aliases",), "Host names from ~/.ssh/config: letters, digits, . _ -")

    defaults = t.get("defaults") or {}
    if not isinstance(defaults, dict):
        err(("defaults",), "must be a mapping")
        defaults = {}
    _unknown(defaults, "defaults", ("defaults",), err)
    _pos_int(("defaults", "start_timeout"), defaults.get("start_timeout"), err, 3600)
    _pos_int(("defaults", "stop_timeout"), defaults.get("stop_timeout"), err, 3600)
    dready = defaults.get("ready") or {}
    if isinstance(dready, dict):
        _unknown(dready, "ready", ("defaults", "ready"), err)
        _regex(("defaults", "ready", "log"), dready.get("log"), err)
        _regex(("defaults", "ready", "fail"), dready.get("fail"), err)
        _url(("defaults", "ready", "url"), dready.get("url"), err)

    apps = t.get("apps")
    if not isinstance(apps, list) or not apps:
        err(("apps",), "add at least one app")
        apps = []
    ids = [a.get("id") for a in apps if isinstance(a, dict)]
    ports = {}
    for i, a in enumerate(apps):
        _validate_app(t, i, a, ids, servers, err, warn)
        if isinstance(a, dict) and isinstance(a.get("port"), int):
            ports.setdefault((a.get("server"), a["port"]), []).append(i)
    for (sid, port), idx in ports.items():
        if len(idx) > 1:
            for i in idx[1:]:
                warn(("apps", i, "port"), f"port {port} is also used by another app on {sid}")
    _secrets(t, (), err)
    return errors, warnings


def _validate_app(t, i, a, ids, servers, err, warn):
    p = ("apps", i)
    if not isinstance(a, dict):
        err(p, "must be a mapping")
        return
    _unknown(a, "app", p, err)
    aid = a.get("id")
    if not isinstance(aid, str) or not ID_RE.match(aid):
        err(p + ("id",), "1 to 32 lowercase letters, digits or -")
    elif ids.count(aid) > 1:
        err(p + ("id",), f"another app already uses the id '{aid}'")
    if not _s(a.get("name")):
        err(p + ("name",), "give the app a name")
    if a.get("server") not in servers:
        err(p + ("server",), "pick one of the template's servers" if servers else "add a server first")
    _abs(p + ("dir",), a.get("dir"), err, "the app's folder on the server", required=True)
    if a.get("port") not in (None, ""):
        _pos_int(p + ("port",), a.get("port"), err, 65535)
    _abs(p + ("log",), a.get("log"), err, "the log file")
    _command(p + ("start",), a.get("start"), err, ("dir",), "start command (a script like ./start.sh, or the command you type)")
    _command(p + ("stop",), a.get("stop"), err, ("dir",), "stop command (a script like ./stop.sh, or the command you type)")
    _pos_int(p + ("start_timeout",), a.get("start_timeout"), err, 3600)
    _pos_int(p + ("stop_timeout",), a.get("stop_timeout"), err, 3600)
    if a.get("process") not in (None, "") and not _s(a.get("process")):
        err(p + ("process",), "text to look for in the process list")

    ready = a.get("ready") or {}
    if not isinstance(ready, dict):
        err(p + ("ready",), "must be a mapping")
        ready = {}
    _unknown(ready, "ready", p + ("ready",), err)
    _regex(p + ("ready", "log"), ready.get("log"), err)
    _regex(p + ("ready", "fail"), ready.get("fail"), err)
    _url(p + ("ready", "url"), ready.get("url"), err)
    eff = ready_of(t, a)
    if (eff.get("log") or eff.get("fail")) and not a.get("log"):
        warn(p + ("log",), "the ready check reads the log, but no log file is set")
    if not a.get("port") and not a.get("process"):
        warn(p + ("port",), "with no port and no process match, the skill cannot tell whether the app is running")
    if not (eff.get("log") and a.get("log")) and not eff.get("url") and not a.get("port"):
        warn(p + ("ready",), "no ready check: a restart cannot confirm the app came up")

    build = a.get("build") or {}
    if not isinstance(build, dict):
        err(p + ("build",), "must be a mapping")
        build = {}
    _unknown(build, "build", p + ("build",), err)
    deploy = a.get("deploy") or {"style": "none"}
    if not isinstance(deploy, dict):
        err(p + ("deploy",), "must be a mapping")
        deploy = {"style": "none"}
    _unknown(deploy, "deploy", p + ("deploy",), err)
    style = deploy.get("style") or "none"
    if style not in STYLES:
        err(p + ("deploy", "style"), "one of: " + ", ".join(STYLES))
    if build:
        if not isinstance(build.get("repo"), str) or not ID_RE.match(build.get("repo")):
            err(p + ("build", "repo"), "a short name for the local repo (apps built from one repo share it)")
        if not _s(build.get("command")):
            err(p + ("build", "command"), "the command that builds the app, run in the repo folder")
        out = build.get("output")
        if not _s(out) or not REL_RE.match(out) or not EXT_RE.search(out.rsplit("/", 1)[-1]):
            err(p + ("build", "output"), "where the build puts the file, relative to the repo, like target/*.jar")
        if build.get("detect") not in (None, "") and not (isinstance(build["detect"], str) and REL_RE.match(build["detect"])):
            err(p + ("build", "detect"), "a file in the repo, relative to it, like pom.xml")
    if style in ("jar-start-script", "custom") and not build:
        err(p + ("build",), "this deploy style needs a build: the repo, the build command and the output file")
    if style == "none" and build:
        warn(p + ("build",), "the build is not used while the deploy style is restart only")
    if style == "jar-start-script":
        if build and artifact_ext(a) != ".jar":
            err(p + ("build", "output"), "the jar + start script style deploys a .jar; the output must end in .jar")
        scr = start_script(a)
        if not scr:
            err(p + ("deploy", "start_script"), "name the start script whose java -jar line changes (or make the start command ./script.sh)")
        elif not re.fullmatch(r"[A-Za-z0-9._-]+", scr):
            err(p + ("deploy", "start_script"), "a file name in the app folder")
        if deploy.get("edit") not in (None, "") and deploy.get("edit") not in EDITS:
            err(p + ("deploy", "edit"), "duplicate or replace")
        for k in ("steps", "rollback", "upload_dir"):
            if deploy.get(k):
                warn(p + ("deploy", k), "used only by the custom style")
    if style == "custom":
        _abs(p + ("deploy", "upload_dir"), deploy.get("upload_dir"), err, "the upload folder")
        for key in ("steps", "rollback"):
            items = deploy.get(key) or []
            if not isinstance(items, list):
                err(p + ("deploy", key), "a list of commands")
                continue
            for j, c in enumerate(items):
                _command(p + ("deploy", key, j), c, err, PLACEHOLDERS, "step, or remove it")
        if not deploy.get("steps"):
            warn(p + ("deploy", "steps"), "no steps: a deploy only uploads the new file, then restarts")
        if not deploy.get("rollback"):
            warn(p + ("deploy", "rollback"), "no rollback steps: a failed deploy has to be undone by hand")
    if deploy.get("name_prefix") not in (None, "") and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", str(deploy.get("name_prefix"))):
        err(p + ("deploy", "name_prefix"), "letters, digits, . _ -")

    configs = a.get("configs") or []
    if not isinstance(configs, list):
        err(p + ("configs",), "a list")
        configs = []
    cids = [c.get("id") for c in configs if isinstance(c, dict)]
    for j, c in enumerate(configs):
        q = p + ("configs", j)
        if not isinstance(c, dict):
            err(q, "must be a mapping")
            continue
        _unknown(c, "config", q, err)
        if not isinstance(c.get("id"), str) or not ID_RE.match(c["id"]):
            err(q + ("id",), "a short id: lowercase letters, digits or -")
        elif cids.count(c["id"]) > 1:
            err(q + ("id",), f"another config file of this app uses '{c['id']}'")
        _abs(q + ("path",), c.get("path"), err, "the config file", required=True)
        if c.get("format") not in (None, "") and c.get("format") not in FORMATS:
            err(q + ("format",), "one of: " + ", ".join(FORMATS))
        repo = c.get("git_repo")
        _abs(q + ("git_repo",), repo, err, "the git repo")
        if repo and isinstance(c.get("path"), str) and not c["path"].startswith(repo.rstrip("/") + "/"):
            err(q + ("git_repo",), "the config file must be inside this repo")
        if c.get("served_by") not in (None, "") and c.get("served_by") not in ids:
            err(q + ("served_by",), "pick the app that serves this file")
        _url(q + ("verify_url",), c.get("verify_url"), err)
        if c.get("served_by") and not c.get("verify_url"):
            warn(q + ("verify_url",), "add the URL that serves this file so a change can be checked")
        if c.get("verify_url") and config_format(c) != "yaml":
            warn(q + ("verify_url",), "served values are compared for YAML files only")
        rs = c.get("restart") or []
        if not isinstance(rs, list) or any(r not in ids for r in rs):
            err(q + ("restart",), "app ids from this template")
    if a.get("instructions") not in (None, "") and not isinstance(a.get("instructions"), str):
        err(p + ("instructions",), "text")


def config_format(c):
    f = c.get("format")
    if f:
        return f
    ext = (c.get("path") or "").rsplit(".", 1)[-1].lower()
    return {"yml": "yaml", "yaml": "yaml", "properties": "properties", "json": "json", "xml": "xml"}.get(ext, "text")


# ---------------------------------------------------------------- files


def template_path(tid):
    return TEMPLATES / f"{tid}.yml"


def load_file(path):
    yaml = _yaml()
    try:
        data = yaml.safe_load(Path(path).read_text())
    except OSError as e:
        raise TemplateError(f"cannot read {path}: {e.strerror}")
    except yaml.YAMLError as e:
        raise TemplateError(f"{path} is not valid YAML: {e}")
    if not isinstance(data, dict):
        raise TemplateError(f"{path} is not a template (expected a mapping)")
    return data


def list_templates():
    out = []
    for f in sorted(TEMPLATES.glob("*.yml")):
        item = {"id": f.stem, "file": str(f), "modified": int(f.stat().st_mtime)}
        try:
            t = load_file(f)
            errors, warnings = validate(t, f.stem)
            item.update(name=t.get("name") or f.stem, description=t.get("description") or "",
                        apps=[{"id": a.get("id"), "name": a.get("name")} for a in t.get("apps") or [] if isinstance(a, dict)],
                        servers=[{"id": k, "host": (s or {}).get("host"), "user": (s or {}).get("user")}
                                 for k, s in (t.get("servers") or {}).items()],
                        errors=len(errors), warnings=len(warnings))
        except TemplateError as e:
            item.update(name=f.stem, description="", apps=[], servers=[], errors=1, warnings=0, problem=str(e))
        out.append(item)
    return out


def write_atomic(path, text, mode=0o644):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.replace(tmp, path)


def audit(target, text):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    with open(STATE_DIR / "audit.log", "a") as f:
        f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} | {getpass.getuser()} | {target} | {text}\n")


# ---------------------------------------------------------------- this machine


def load_local():
    if not LOCAL.exists():
        return {}
    data = _yaml().safe_load(LOCAL.read_text()) or {}
    return data if isinstance(data, dict) else {}


def save_local(data):
    CONF_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(CONF_DIR, 0o700)
    write_atomic(LOCAL, "# uat-deploy settings for this machine only; never commit this file.\n"
                 + _yaml().safe_dump(data, sort_keys=False, allow_unicode=True), 0o600)


def local_template(local, tid):
    return local.setdefault("templates", {}).setdefault(tid, {})


def server_key(s):
    return f"{s.get('user')}@{s.get('host')}"


def password_file(key):
    return PASSWORDS / key


def auth_of(local, key):
    """How this machine signs in to user@host: {auth, key_file, password_saved}."""
    s = (local.get("servers") or {}).get(key) or {}
    saved = password_file(key).is_file() and password_file(key).stat().st_size > 0
    auth = s.get("auth") or ("password" if saved else "key")
    return {"auth": auth, "key_file": s.get("key_file") or "", "password_saved": saved}


def ssh_keys():
    d = Path.home() / ".ssh"
    keys = []
    for f in sorted(d.glob("*")) if d.is_dir() else []:
        if f.is_file() and not f.name.endswith(".pub") and (f.with_name(f.name + ".pub")).exists():
            keys.append(str(f))
    return keys


def save_password(key, password):
    PASSWORDS.mkdir(parents=True, exist_ok=True)
    os.chmod(CONF_DIR, 0o700)
    os.chmod(PASSWORDS, 0o700)
    write_atomic(password_file(key), password + "\n", 0o600)


def set_auth(key, auth, key_file=""):
    local = load_local()
    servers = local.setdefault("servers", {})
    entry = {"auth": auth}
    if auth == "key" and key_file:
        entry["key_file"] = key_file
    servers[key] = entry
    save_local(local)


# ---------------------------------------------------------------- the chosen template


def current_id(local=None):
    local = load_local() if local is None else local
    tid = os.environ.get("UAT_TEMPLATE") or local.get("current_template")
    if tid:
        return tid
    found = sorted(TEMPLATES.glob("*.yml"))
    if len(found) == 1:
        return found[0].stem
    raise TemplateError("no template chosen yet; list them with uat templates and pick one with uat use ID")


def resolve(strict=True):
    """(template, template id, local settings) for the chosen template; strict refuses a template with errors."""
    local = load_local()
    draft = os.environ.get("UAT_TEMPLATE_FILE")
    if draft:
        t = normalize(load_file(draft))
        tid = t.get("id") or "draft"
        stem = None
    else:
        tid = current_id(local)
        f = template_path(tid)
        if not f.exists():
            raise TemplateError(f"template '{tid}' not found ({f}); list them with uat templates")
        t = normalize(load_file(f))
        stem = tid
    if strict:
        errors, _ = validate(t, stem)
        if errors:
            first = errors[0]
            raise TemplateError(f"template '{tid}' has {len(errors)} problem(s), first: {first['label']}: {first['message']}. "
                                f"Fix it with uat configure {tid} or uat template-check {tid}")
    return t, tid, local


def find_app(t, app_id):
    for a in t.get("apps") or []:
        if isinstance(a, dict) and a.get("id") == app_id:
            return a
    ids = ", ".join(str(a.get("id")) for a in t.get("apps") or [] if isinstance(a, dict))
    raise TemplateError(f"no app '{app_id}' in template '{t.get('id')}' (apps: {ids})")


def _server_vars(t, sid, local):
    servers = t.get("servers") or {}
    if sid not in servers:
        raise TemplateError(f"no server '{sid}' in template '{t.get('id')}' (servers: {', '.join(servers)})")
    s = servers[sid]
    key = server_key(s)
    auth = auth_of(local, key)
    kf = os.path.expanduser(auth["key_file"]) if auth["key_file"] else ""
    return {"S_ID": sid, "S_HOST": s.get("host", ""), "S_USER": s.get("user", ""), "S_LABEL": s.get("label") or sid,
            "S_AUTH": auth["auth"], "S_KEY": kf, "S_PWFILE": str(password_file(key))}


def _emit(values, arrays=None):
    for k, v in values.items():
        print(f"{k}={shlex.quote('' if v is None else str(v))}")
    for k, items in (arrays or {}).items():
        print(f"{k}=(" + " ".join(shlex.quote(str(x)) for x in items) + ")")


def cmd_env(app_id, cfg=None):
    t, tid, local = resolve()
    a = find_app(t, app_id)
    L = local_template(local, tid)
    build = a.get("build") or {}
    deploy = a.get("deploy") or {"style": "none"}
    ready = ready_of(t, a)
    out = build.get("output") or ""
    repo = build.get("repo") or ""
    values = {
        "T_ID": tid, "T_NAME": t.get("name"),
        "A_ID": a["id"], "A_LABEL": a.get("name"), "A_DIR": a.get("dir"), "A_PORT": a.get("port") or "",
        "A_PROCESS": a.get("process") or "", "A_LOG": a.get("log") or "",
        "A_START_CMD": a.get("start"), "A_STOP_CMD": a.get("stop"),
        "A_START_TIMEOUT": timeout_of(t, a, "start_timeout", DEFAULT_START_TIMEOUT),
        "A_STOP_TIMEOUT": timeout_of(t, a, "stop_timeout", DEFAULT_STOP_TIMEOUT),
        "A_READY_LOG": ready.get("log") or "", "A_READY_FAIL": ready.get("fail") or "", "A_READY_URL": ready.get("url") or "",
        "A_STYLE": deploy.get("style") or "none",
        "A_START": (start_script(a) or "") if deploy.get("style") == "jar-start-script" else "",
        "A_EDIT": deploy.get("edit") or "duplicate", "A_PREFIX": deploy.get("name_prefix") or a["id"],
        "A_UPLOAD_DIR": deploy.get("upload_dir") or a.get("dir"),
        "A_REPO": repo, "A_LOCAL": os.path.expanduser((L.get("repos") or {}).get(repo) or "") if repo else "",
        "A_BUILD": (L.get("builds") or {}).get(a["id"]) or build.get("command") or "",
        "A_OUT_DIR": os.path.dirname(out) or ".", "A_OUT_GLOB": os.path.basename(out), "A_EXT": artifact_ext(a),
        "A_START_EXEC": script_of(a.get("start")) or "", "A_STOP_EXEC": script_of(a.get("stop")) or "",
        "A_HAS_INSTRUCTIONS": "yes" if a.get("instructions") else "",
        "LOCAL_CONFIG_DIR": os.path.expanduser(L.get("config_dir") or ""),
        "GIT_NAME": (local.get("git") or {}).get("name") or "", "GIT_EMAIL": (local.get("git") or {}).get("email") or "",
    }
    values.update(_server_vars(t, a.get("server"), local))
    arrays = {"A_STEPS": deploy.get("steps") or [], "A_ROLLBACK": deploy.get("rollback") or [],
              "A_CONFIGS": [c.get("id") for c in a.get("configs") or []]}
    if cfg is not None:
        configs = a.get("configs") or []
        if cfg in ("", "-"):
            if len(configs) != 1:
                ids = ", ".join(c.get("id") for c in configs) or "none"
                raise TemplateError(f"{a['id']} has {len(configs)} config files ({ids}); name the one to use")
            c = configs[0]
        else:
            c = next((c for c in configs if c.get("id") == cfg), None)
            if c is None:
                ids = ", ".join(c.get("id") for c in configs) or "none"
                raise TemplateError(f"{a['id']} has no config file '{cfg}' (config files: {ids})")
        repo_dir = (c.get("git_repo") or "").rstrip("/")
        values.update({"C_ID": c["id"], "C_PATH": c["path"], "C_FORMAT": config_format(c), "C_GIT_REPO": repo_dir,
                       "C_REL": c["path"][len(repo_dir) + 1:] if repo_dir else "", "C_SERVED_BY": c.get("served_by") or "",
                       "C_VERIFY_URL": c.get("verify_url") or ""})
        arrays["C_RESTART"] = c.get("restart") or []
    _emit(values, arrays)


def cmd_server_env(sid=None):
    t, tid, local = resolve(strict=False)
    servers = t.get("servers") or {}
    if not sid:
        if len(servers) != 1:
            raise TemplateError(f"template '{tid}' has {len(servers)} servers ({', '.join(servers)}); pass --server ID")
        sid = next(iter(servers))
    values = {"T_ID": tid}
    values.update(_server_vars(t, sid, local))
    _emit(values)


def used_servers(t):
    seen = []
    for a in t.get("apps") or []:
        if isinstance(a, dict) and a.get("server") in (t.get("servers") or {}) and a["server"] not in seen:
            seen.append(a["server"])
    return seen or list(t.get("servers") or {})


def cmd_check_plan():
    t, _, _ = resolve(strict=False)
    for sid in used_servers(t):
        print(f"SERVER\t{sid}")
        for a in t.get("apps") or []:
            if not isinstance(a, dict) or a.get("server") != sid:
                continue
            aid, d = a.get("id"), (a.get("dir") or "").rstrip("/")
            checks = [("dir", d)]
            for cmd in (a.get("start"), a.get("stop")):
                s = script_of(cmd)
                if s:
                    checks.append(("exec", f"{d}/{s}"))
            dep = a.get("deploy") or {}
            if dep.get("style") == "jar-start-script" and start_script(a):
                checks.append(("exec", f"{d}/{start_script(a)}"))
            if dep.get("style") == "custom" and dep.get("upload_dir"):
                checks.append(("dir", dep["upload_dir"]))
            if a.get("log"):
                checks.append(("logdir", os.path.dirname(a["log"])))
            for c in a.get("configs") or []:
                if c.get("git_repo"):
                    checks.append(("gitrepo", c["git_repo"]))
                if c.get("path"):
                    checks.append(("file", c["path"]))
            done = set()
            for kind, path in checks:
                if path and (kind, path) not in done:
                    done.add((kind, path))
                    print(f"CHECK\t{sid}\t{aid}\t{kind}\t{path}")


# ---------------------------------------------------------------- reports


def cmd_templates():
    local = load_local()
    try:
        cur = current_id(local)
    except TemplateError:
        cur = ""
    items = list_templates()
    if not items:
        print(f"no templates in {TEMPLATES}; create one with uat configure --new")
        return 0
    for it in items:
        mark = "*" if it["id"] == cur else " "
        state = f"{it['errors']} problem(s)" if it["errors"] else "ok"
        apps = ", ".join(a["id"] for a in it["apps"])
        hosts = ", ".join(f"{s['user']}@{s['host']}" for s in it["servers"])
        print(f"{mark} {it['id']:<14} {it['name']:<22} apps: {apps or '-'}   servers: {hosts or '-'}   [{state}]")
    print(f"\n* chosen template. Folder: {TEMPLATES}")
    return 0


def cmd_use(tid):
    if not tid or not template_path(tid).exists():
        raise TemplateError(f"no template '{tid}'; list them with uat templates")
    local = load_local()
    old = local.get("current_template") or ""
    local["current_template"] = tid
    save_local(local)
    audit("-", f"settings | template: '{old}' -> '{tid}'")
    print(f"template: {tid}")
    return 0


def cmd_mode(value=None):
    """Show or set how /uat-deploy runs on this machine: terminal (default) or ui (the console page)."""
    local = load_local()
    env = os.environ.get("UAT_DEPLOY_MODE")
    if value is None:
        mode = env or local.get("mode") or "terminal"
        if mode not in ("ui", "terminal"):
            mode = "terminal"
        where = "the UAT_DEPLOY_MODE environment variable" if env else str(LOCAL) if local.get("mode") else "the default"
        print(f"MODE={mode} (from {where})")
        return 0
    if value not in ("ui", "terminal"):
        raise TemplateError("the mode is ui or terminal")
    old = local.get("mode") or "terminal"
    local["mode"] = value
    save_local(local)
    audit("-", f"settings | mode: '{old}' -> '{value}'")
    print(f"MODE={value} (saved in {LOCAL})")
    if env and env != value:
        print(f"UAT_DEPLOY_MODE={env} is set in this shell and wins over the saved mode.")
    return 0


def cmd_apps():
    t, tid, _ = resolve(strict=False)
    for a in t.get("apps") or []:
        if not isinstance(a, dict):
            continue
        style = (a.get("deploy") or {}).get("style") or "none"
        cfgs = ", ".join(c.get("id", "?") for c in a.get("configs") or []) or "-"
        print(f"{a.get('id'):<14} {a.get('name') or '':<24} server: {a.get('server')}  deploy: {style}  configs: {cfgs}")
    return 0


def cmd_show():
    t, tid, local = resolve(strict=False)
    L = local_template(local, tid)
    print(f"template {tid}: {t.get('name')}   file: {template_path(tid)}")
    if t.get("description"):
        print(f"  {t['description']}")
    for sid, s in (t.get("servers") or {}).items():
        a = auth_of(local, server_key(s))
        how = "password (saved)" if a["auth"] == "password" and a["password_saved"] else \
              "password (NOT SAVED)" if a["auth"] == "password" else f"ssh key {a['key_file'] or '(ssh default keys / agent)'}"
        print(f"\n[server {sid}] {server_key(s)}   sign-in: {how}")
    for a in t.get("apps") or []:
        build, dep = a.get("build") or {}, a.get("deploy") or {}
        r = ready_of(t, a)
        print(f"\n[{a.get('id')}] {a.get('name')}   on {a.get('server')}")
        print(f"  folder:       {a.get('dir')}   port: {a.get('port') or '-'}   process: {a.get('process') or '-'}")
        print(f"  start / stop: {a.get('start')}  /  {a.get('stop')}")
        print(f"  log:          {a.get('log') or '-'}")
        print(f"  ready:        log '{r.get('log') or '-'}'  fail '{r.get('fail') or '-'}'  url {r.get('url') or '-'}")
        style = dep.get("style") or "none"
        print(f"  deploy:       {style}" + (f" (start script {start_script(a)}, {dep.get('edit') or 'duplicate'})" if style == "jar-start-script" else ""))
        for k in ("steps", "rollback"):
            for j, c in enumerate(dep.get(k) or []):
                print(f"    {k} {j + 1}: {c}")
        if build:
            repo = build.get("repo")
            path = (L.get("repos") or {}).get(repo) or "<not set on this machine>"
            cmd = (L.get("builds") or {}).get(a.get("id"))
            print(f"  build:        repo {repo} = {path}")
            print(f"                {cmd or build.get('command')}" + ("   (this machine's override)" if cmd else ""))
            print(f"                output {build.get('output')}")
        for c in a.get("configs") or []:
            extra = f"  git repo {c['git_repo']}" if c.get("git_repo") else "  (not in git: backed up before upload)"
            print(f"  config {c.get('id')}: {c.get('path')} [{config_format(c)}]{extra}")
            if c.get("restart"):
                print(f"    after a change restart: {' -> '.join(c['restart'])}")
    git = local.get("git") or {}
    print(f"\nthis machine: git identity {git.get('name') or '<not set>'} <{git.get('email') or 'not set'}>, "
          f"local config folder {L.get('config_dir') or '<not set>'}")
    return 0


def cmd_setup_status():
    local = load_local()
    print(f"skill folder:   {SKILL}")
    print(f"templates:      {', '.join(t['id'] for t in list_templates()) or 'none'}")
    try:
        tid = current_id(local)
        print(f"chosen:         {tid}")
    except TemplateError as e:
        print(f"chosen:         NONE ({e})")
        tid = None
    if tid:
        try:
            t, _, _ = resolve(strict=False)
            errors, warnings = validate(t, tid)
            print(f"template check: {len(errors)} problem(s), {len(warnings)} warning(s)")
            L = local_template(local, tid)
            repos = []
            for a in t.get("apps") or []:
                b = a.get("build") or {}
                if b.get("repo") and b["repo"] not in [r[0] for r in repos]:
                    repos.append((b["repo"], b.get("detect"), a.get("id")))
            for repo, detect, aid in repos:
                path = (L.get("repos") or {}).get(repo)
                state = "NOT SET" if not path else "MISSING FOLDER" if not os.path.isdir(os.path.expanduser(path)) else \
                    f"no {detect} in it" if detect and not os.path.exists(os.path.join(os.path.expanduser(path), detect)) else "ok"
                print(f"repo {repo:<10} {path or '-'}   [{state}]" + (f"  (look for {detect})" if detect else ""))
            for sid, s in (t.get("servers") or {}).items():
                a = auth_of(local, server_key(s))
                if a["auth"] == "password":
                    state = "password saved" if a["password_saved"] else "password NOT SAVED"
                else:
                    kf = os.path.expanduser(a["key_file"]) if a["key_file"] else ""
                    state = f"ssh key {kf}" + (" [MISSING]" if kf and not os.path.isfile(kf) else "") if kf else "ssh key (default keys / agent)"
                print(f"server {sid:<8} {server_key(s)}   sign-in: {state}")
            tools = set()
            for a in t.get("apps") or []:
                cmd = (L.get("builds") or {}).get(a.get("id")) or (a.get("build") or {}).get("command")
                if cmd:
                    toks = [x for x in shlex.split(cmd) if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", x)]
                    if toks:
                        tools.add(toks[0])
            for tool in sorted(tools):
                print(f"build tool:     {tool} {'ok' if shutil.which(tool) or os.path.exists(tool) else 'MISSING'}")
            print(f"config folder:  {L.get('config_dir') or '<not set>'}")
        except TemplateError as e:
            print(f"template:       ERROR {e}")
    git = local.get("git") or {}
    print(f"git identity:   {git.get('name') or '<not set>'} <{git.get('email') or 'not set'}>")
    gname = subprocess.run(["git", "config", "--global", "user.name"], capture_output=True, text=True).stdout.strip()
    gmail = subprocess.run(["git", "config", "--global", "user.email"], capture_output=True, text=True).stdout.strip()
    print(f"global git:     {gname or '-'} <{gmail or '-'}>")
    print("pyyaml:         ok")
    ssh = subprocess.run(["ssh", "-V"], capture_output=True, text=True)
    print(f"ssh:            {(ssh.stderr or ssh.stdout).strip().splitlines()[0] if (ssh.stderr or ssh.stdout).strip() else 'MISSING'}")
    keys = ssh_keys()
    print(f"ssh keys:       {', '.join(keys) if keys else 'none in ~/.ssh'}")
    return 0


def cmd_instructions(app_id=None):
    t, tid, _ = resolve(strict=False)
    print(f"template {tid}: {t.get('name')}")
    if t.get("instructions"):
        print("\n[project]\n" + t["instructions"].rstrip())
    for sid, s in (t.get("servers") or {}).items():
        if (s or {}).get("notes"):
            print(f"\n[server {sid}] {server_key(s)}\n" + s["notes"].rstrip())
    apps = [find_app(t, app_id)] if app_id else [a for a in t.get("apps") or [] if isinstance(a, dict)]
    for a in apps:
        if a.get("instructions"):
            print(f"\n[app {a.get('id')}] {a.get('name')}\n" + a["instructions"].rstrip())
    return 0


def cmd_check(arg=None):
    if arg and (arg.endswith((".yml", ".yaml")) or "/" in arg):
        path, stem = Path(arg), None
    else:
        tid = arg or current_id()
        path, stem = template_path(tid), tid
    t = normalize(load_file(path))
    errors, warnings = validate(t, stem)
    for e in errors:
        print(f"ERROR  {e['label'] or '(template)'}: {e['message']}")
    for w in warnings:
        print(f"WARN   {w['label'] or '(template)'}: {w['message']}")
    print(f"{path}: {len(errors)} problem(s), {len(warnings)} warning(s)")
    return 1 if errors else 0


def cmd_local_set(key, value):
    local = load_local()
    value = os.path.expanduser(value) if value.startswith("~") else value
    m = re.fullmatch(r"(repo|build)\.([a-z0-9][a-z0-9-]*)", key)
    if key in ("git.name", "git.email"):
        sect, field = key.split(".")
        old = (local.get(sect) or {}).get(field, "")
        local.setdefault(sect, {})[field] = value
    elif key == "config-dir" or m:
        tid = resolve(strict=False)[1]
        L = local_template(local, tid)
        if key == "config-dir":
            if value and not os.path.isdir(value):
                raise TemplateError(f"{value} is not a folder")
            old = L.get("config_dir", "")
            L["config_dir"] = value
        elif m.group(1) == "repo":
            if value and not os.path.isdir(value):
                raise TemplateError(f"{value} is not a folder")
            old = (L.get("repos") or {}).get(m.group(2), "")
            L.setdefault("repos", {})[m.group(2)] = value
        else:
            old = (L.get("builds") or {}).get(m.group(2), "")
            L.setdefault("builds", {})[m.group(2)] = value
            if not value:
                del L["builds"][m.group(2)]
        key = f"{tid}: {key}"
    elif re.fullmatch(r"auth\.[a-z0-9][a-z0-9-]*", key):
        t, tid, _ = resolve(strict=False)
        sid = key.split(".", 1)[1]
        s = (t.get("servers") or {}).get(sid)
        if not s:
            raise TemplateError(f"no server '{sid}' in template '{tid}'")
        how, _, kf = value.partition(":")
        if how not in ("key", "password"):
            raise TemplateError("auth is key, key:/path/to/private_key or password")
        if kf and not os.path.isfile(os.path.expanduser(kf)):
            raise TemplateError(f"{kf} is not a file")
        old = auth_of(local, server_key(s))["auth"]
        servers = local.setdefault("servers", {})
        servers[server_key(s)] = {"auth": how, **({"key_file": kf} if kf else {})}
        key = f"{tid}: sign-in for {server_key(s)}"
    else:
        raise TemplateError("unknown setting; use git.name, git.email, repo.NAME, build.APP, config-dir or auth.SERVER")
    save_local(local)
    audit("-", f"settings | {key}: '{old}' -> '{value}'")
    print(f"{key}: '{old}' -> '{value}'")
    return 0


def cmd_save_password(sid=None):
    t, tid, _ = resolve(strict=False)
    servers = t.get("servers") or {}
    if not sid:
        if len(servers) != 1:
            raise TemplateError(f"name the server: {', '.join(servers)}")
        sid = next(iter(servers))
    s = servers.get(sid)
    if not s:
        raise TemplateError(f"no server '{sid}' in template '{tid}'")
    pw = sys.stdin.readline().rstrip("\n")
    if not pw:
        raise TemplateError("pipe the password on stdin")
    key = server_key(s)
    save_password(key, pw)
    set_auth(key, "password")
    audit("-", f"settings | password saved for {key}")
    print(f"password saved for {key} (mode 600, {len(pw)} characters); sign-in set to password")
    return 0


# ---------------------------------------------------------------- hook support


def server_marks():
    """Host names, user@host and ssh aliases of every template, for the safety hook."""
    marks = set()
    for f in TEMPLATES.glob("*.yml"):
        try:
            t = load_file(f)
            for s in (t.get("servers") or {}).values():
                if isinstance(s, dict):
                    if s.get("host"):
                        marks.add(str(s["host"]))
                    for a in s.get("aliases") or []:
                        marks.add(str(a))
        except TemplateError:
            text = f.read_text(errors="replace")
            marks.update(re.findall(r"^\s*host:\s*['\"]?([A-Za-z0-9.:-]+)", text, re.M))
    return sorted(m for m in marks if len(m) >= 3)


# ---------------------------------------------------------------- main


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    op, args = argv[0], argv[1:]
    try:
        if op == "templates":
            return cmd_templates()
        if op == "use" and len(args) == 1:
            return cmd_use(args[0])
        if op == "check" and len(args) <= 1:
            return cmd_check(*args)
        if op == "apps":
            return cmd_apps()
        if op == "mode" and len(args) <= 1:
            return cmd_mode(*args)
        if op == "instructions" and len(args) <= 1:
            return cmd_instructions(*args)
        if op == "env" and len(args) in (1, 2):
            return cmd_env(*args) or 0
        if op == "server-ids":
            t, _, _ = resolve(strict=False)
            print("\n".join(used_servers(t)))
            return 0
        if op == "server-env" and len(args) <= 1:
            return cmd_server_env(*args) or 0
        if op == "check-plan":
            return cmd_check_plan() or 0
        if op == "show":
            return cmd_show()
        if op == "setup-status":
            return cmd_setup_status()
        if op == "local-set" and len(args) == 2:
            return cmd_local_set(*args)
        if op == "save-password" and len(args) <= 1:
            return cmd_save_password(*args)
    except TemplateError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]) or 0)
