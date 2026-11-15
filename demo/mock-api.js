/* uat-deploy live demo: a stand-in for the console (scripts/uat-console) and configurator (scripts/uat-ui) servers.
 *
 * The real pages talk to a Python server on 127.0.0.1 that runs the `uat` helper over ssh and headless Claude Code.
 * Here every /api/* request the pages make is answered in the browser instead: a simulated "Shopfront" project of a
 * fictional company (Acme Payments), with scripted, timed progress for deploys, restarts, rollbacks, config changes
 * and Ask UAT questions. Nothing leaves the browser. The response shapes follow the Python servers exactly, so the
 * pages in ui/ run unchanged.
 */
(() => {
  "use strict";

  const FX = window.__UAT_FIXTURES;
  const IN_CFG = location.pathname.startsWith("/configure");
  const realFetch = window.fetch.bind(window);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clone = o => JSON.parse(JSON.stringify(o));
  const hex = n => Array.from(crypto.getRandomValues(new Uint8Array(Math.ceil(n / 2))), b => b.toString(16).padStart(2, "0")).join("").slice(0, n);
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const rnd = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
  const DAY = 864e5;

  class ApiError extends Error {
    constructor(status, message, extra) { super(message); this.status = status; this.extra = extra || {}; }
  }
  const CANCEL = { cancelled: true };

  /* ---------------------------------------------------------------- dates and names */

  const pad = n => String(n).padStart(2, "0");
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hms = d => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const stampOf = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const mon = d => d.toLocaleString("en", { month: "short" }).toLowerCase();
  const md = d => `${mon(d)}-${d.getDate()}`;
  const daysAgo = (n, h, m, s = 0) => { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(h, m, s, 0); return d; };
  const fmtSpan = ms => { const s = Math.round(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)}m ${pad(s % 60)}s` : `${s}s`; };
  const etime = secs => { const d = Math.floor(secs / 86400), h = Math.floor(secs % 86400 / 3600), m = Math.floor(secs % 3600 / 60), s = secs % 60; return (d ? `${d}-` : "") + `${pad(h)}:${pad(m)}:${pad(s)}`; };
  const pascal = s => String(s).split(/[^A-Za-z0-9]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join("");
  const hashStr = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(16); };

  /* ---------------------------------------------------------------- template helpers (ports of scripts/uattpl.py) */

  const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
  const USER_RE = /^[a-z_][a-z0-9_.-]{0,31}$/;
  const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/;
  const PATH_RE = /^\/[A-Za-z0-9._/@+~-]*$/;
  const PROD_RE = /(^|[^a-z])(prod|production|live)([^a-z]|$)/i;
  const EXT_RE = /\*((?:\.[A-Za-z0-9]+)+)$/;
  const ORDER = {
    top: ["schema", "id", "name", "description", "servers", "defaults", "apps", "instructions"],
    server: ["label", "host", "user", "aliases", "notes"],
    defaults: ["start_timeout", "stop_timeout", "ready"],
    app: ["id", "name", "server", "dir", "port", "process", "log", "start", "stop", "start_timeout", "stop_timeout",
          "ready", "build", "deploy", "configs", "instructions"],
    ready: ["log", "fail", "url"],
    build: ["repo", "detect", "command", "output"],
    deploy: ["style", "start_script", "edit", "name_prefix", "upload_dir", "steps", "rollback"],
    config: ["id", "path", "format", "git_repo", "served_by", "verify_url", "restart", "notes"],
  };
  const CHILD = { "top/defaults": "defaults", "defaults/ready": "ready", "app/ready": "ready", "app/build": "build", "app/deploy": "deploy" };
  const LIST_CHILD = { "top/apps": "app", "app/configs": "config" };
  const INTS = new Set(["schema", "port", "start_timeout", "stop_timeout"]);
  const isEmpty = v => v == null || v === "" || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);

  function cleanStr(v) {
    v = v.replace(/\r\n/g, "\n");
    const core = v.replace(/^\n+|\n+$/g, "");
    if (core.includes("\n")) return core.split("\n").map(l => l.replace(/\s+$/, "")).join("\n") + "\n";
    return v.trim();
  }
  function normValue(kind, key, v) {
    if (typeof v === "string") { v = cleanStr(v); return INTS.has(key) && /^\d{1,9}$/.test(v) ? Number(v) : v; }
    if (Array.isArray(v)) {
      const sub = LIST_CHILD[`${kind}/${key}`];
      return v.map(x => sub ? norm(x, sub) : normValue(kind, key, x)).filter(x => !isEmpty(x));
    }
    if (v && typeof v === "object") {
      if (kind === "top" && key === "servers") return Object.fromEntries(Object.entries(v).map(([k, s]) => [String(k).trim(), norm(s, "server")]));
      const sub = CHILD[`${kind}/${key}`];
      return sub ? norm(v, sub) : v;
    }
    return v;
  }
  function norm(obj, kind) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
    const order = ORDER[kind], out = {};
    for (const k of [...order.filter(k => k in obj), ...Object.keys(obj).filter(k => !order.includes(k))]) {
      const v = normValue(kind, k, obj[k]);
      if (!isEmpty(v)) out[k] = v;
    }
    if (kind === "app" && out.deploy && Object.keys(out.deploy).length === 1 && out.deploy.style === "none") delete out.deploy;
    return out;
  }
  const normalize = t => norm(t, "top");

  /* YAML the way PyYAML's SafeDumper writes a template (block style, indented lists, | for multi-line text) */
  const YAML_SPECIAL = /^(?:~|null|Null|NULL|y|Y|yes|Yes|YES|n|N|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF|<<|=)$/;
  const YAML_NUM = /^[-+]?(?:0b[01_]+|0x[0-9a-fA-F_]+|0[0-7_]+|(?:0|[1-9][0-9_]*)|[1-9][0-9_]*(?::[0-5]?[0-9])+|(?:[0-9][0-9_]*)?\.[0-9_]*(?:[eE][-+][0-9]+)?|\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;
  const YAML_DATE = /^\d{4}-\d{1,2}-\d{1,2}/;
  function scalar(s) {
    if (typeof s === "number" || typeof s === "boolean") return String(s);
    if (s === "") return "''";
    if (/[\t\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s)) return JSON.stringify(s);
    const plain = !YAML_SPECIAL.test(s) && !YAML_NUM.test(s) && !YAML_DATE.test(s) && !/^[\s]|[\s]$/.test(s) &&
      !/^[-?:](\s|$)/.test(s) && !/^[,[\]{}#&*!|>'"%@`]/.test(s) && !/: |:$| #/.test(s) && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s);
    return plain ? s : `'${s.replace(/'/g, "''")}'`;
  }
  function block(s, ind) {
    const chomp = s.endsWith("\n") ? "" : "-";
    const body = s.replace(/\n$/, "").split("\n").map(l => l ? " ".repeat(ind) + l : "").join("\n");
    return `|${chomp}\n${body}`;
  }
  function dumpMap(o, ind) {
    let out = "";
    for (const [k, v] of Object.entries(o)) out += " ".repeat(ind) + scalar(k) + dumpValue(v, ind);
    return out;
  }
  function dumpValue(v, ind) {
    if (Array.isArray(v)) return v.length ? ":\n" + dumpList(v, ind + 2) : ": []\n";
    if (v && typeof v === "object") return Object.keys(v).length ? ":\n" + dumpMap(v, ind + 2) : ": {}\n";
    if (typeof v === "string" && v.includes("\n")) return ": " + block(v, ind + 2) + "\n";
    return ": " + scalar(v) + "\n";
  }
  function dumpList(arr, ind) {
    let out = "";
    for (const v of arr) {
      if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length) {
        const inner = dumpMap(v, ind + 2);
        out += " ".repeat(ind) + "- " + inner.slice(ind + 2);
      } else if (typeof v === "string" && v.includes("\n")) out += " ".repeat(ind) + "- " + block(v, ind + 2) + "\n";
      else out += " ".repeat(ind) + "- " + scalar(v) + "\n";
    }
    return out;
  }
  function render(t) {
    const tid = (t && t.id) || "ID";
    return `# UAT template for the uat-deploy skill. Edit it from /uat-deploy (Edit template) or by hand,\n# then check it with: uat template-check ${tid}\n` + dumpMap(t, 0);
  }

  function scriptOf(cmd) {
    const toks = String(cmd || "").trim().split(/\s+/).filter(Boolean);
    while (toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0])) toks.shift();
    if (!toks.length) return null;
    if (toks[0].startsWith("./") && !toks[0].slice(2).includes("/")) return toks[0].slice(2);
    if (["bash", "sh"].includes(toks[0]) && toks.length > 1 && /^(\.\/)?[A-Za-z0-9._-]+\.sh$/.test(toks[1])) return toks[1].replace(/^\.\//, "");
    return null;
  }
  const startScript = a => (a.deploy || {}).start_script || scriptOf(a.start);
  const artifactExt = a => { const m = EXT_RE.exec(((a.build || {}).output || "").split("/").pop()); return m ? m[1] : ""; };
  const readyOf = (t, a) => (a.ready && Object.keys(a.ready).length ? a.ready : ((t.defaults || {}).ready || {}));
  const timeoutOf = (t, a, k, d) => a[k] || (t.defaults || {})[k] || d;
  const configFormat = c => c.format || ({ yml: "yaml", yaml: "yaml", properties: "properties", json: "json", xml: "xml" })[String(c.path || "").split(".").pop().toLowerCase()] || "text";
  const serverKey = s => `${s.user}@${s.host}`;
  const usedServers = t => {
    const seen = [];
    for (const a of t.apps || []) if (a && (t.servers || {})[a.server] && !seen.includes(a.server)) seen.push(a.server);
    return seen.length ? seen : Object.keys(t.servers || {});
  };
  const dirname = p => String(p).replace(/\/[^/]*$/, "") || "/";
  const basename = p => String(p).split("/").pop();

  function validate(t, stem) {
    const errors = [], warnings = [];
    const add = (bucket, path, message) => bucket.push({ path, label: path.join("."), message });
    const err = (p, m) => add(errors, p, m), warn = (p, m) => add(warnings, p, m);
    if (!ID_RE.test(t.id || "")) err(["id"], "1 to 32 lowercase letters, digits or -, starting with a letter or digit");
    else if (stem && t.id !== stem) err(["id"], `the id must match the file name (${stem}.yml)`);
    if (!String(t.name || "").trim()) err(["name"], "give the template a name");
    const servers = t.servers && typeof t.servers === "object" ? t.servers : {};
    if (!Object.keys(servers).length) err(["servers"], "add at least one server");
    for (const [sid, s] of Object.entries(servers)) {
      const p = ["servers", sid];
      if (!ID_RE.test(sid)) err([...p, "id"], "server id: lowercase letters, digits or -");
      if (PROD_RE.test(sid) || PROD_RE.test(s.label || "")) err([...p, "label"], "production servers are not allowed; this skill is for UAT only");
      if (!String(s.host || "").trim()) err([...p, "host"], "enter the server's IP address or host name");
      else if (!HOST_RE.test(s.host) || s.host.includes("@")) err([...p, "host"], "an IP address or host name only, without user@");
      if (!String(s.user || "").trim()) err([...p, "user"], "enter the user you log in as");
      else if (!USER_RE.test(s.user)) err([...p, "user"], "a Linux user name");
    }
    const apps = Array.isArray(t.apps) ? t.apps : [];
    if (!apps.length) err(["apps"], "add at least one app");
    const ids = apps.map(a => a.id);
    apps.forEach((a, i) => {
      const p = ["apps", i];
      if (!ID_RE.test(a.id || "")) err([...p, "id"], "1 to 32 lowercase letters, digits or -");
      else if (ids.filter(x => x === a.id).length > 1) err([...p, "id"], `another app already uses the id '${a.id}'`);
      if (!String(a.name || "").trim()) err([...p, "name"], "give the app a name");
      if (!(a.server in servers)) err([...p, "server"], Object.keys(servers).length ? "pick one of the template's servers" : "add a server first");
      if (!a.dir) err([...p, "dir"], "enter the app's folder on the server as an absolute path");
      else if (!PATH_RE.test(a.dir)) err([...p, "dir"], "the app's folder on the server: an absolute path (/opt/...) with no spaces or quotes");
      if (a.log && !PATH_RE.test(a.log)) err([...p, "log"], "the log file: an absolute path (/opt/...) with no spaces or quotes");
      if (!String(a.start || "").trim()) err([...p, "start"], "enter the start command (a script like ./start.sh, or the command you type)");
      if (!String(a.stop || "").trim()) err([...p, "stop"], "enter the stop command (a script like ./stop.sh, or the command you type)");
      if (!a.port && !a.process) warn([...p, "port"], "with no port and no process match, the skill cannot tell whether the app is running");
      const style = (a.deploy || {}).style || "none", b = a.build || {};
      if ((style === "jar-start-script" || style === "custom") && !Object.keys(b).length) err([...p, "build"], "this deploy style needs a build: the repo, the build command and the output file");
      if (Object.keys(b).length) {
        if (!ID_RE.test(b.repo || "")) err([...p, "build", "repo"], "a short name for the local repo (apps built from one repo share it)");
        if (!String(b.command || "").trim()) err([...p, "build", "command"], "the command that builds the app, run in the repo folder");
        if (!b.output || !EXT_RE.test(String(b.output).split("/").pop())) err([...p, "build", "output"], "where the build puts the file, relative to the repo, like target/*.jar");
      }
      if (style === "jar-start-script" && Object.keys(b).length && artifactExt(a) !== ".jar") err([...p, "build", "output"], "the jar + start script style deploys a .jar; the output must end in .jar");
      if (style === "jar-start-script" && !startScript(a)) err([...p, "deploy", "start_script"], "name the start script whose java -jar line changes (or make the start command ./script.sh)");
      (a.configs || []).forEach((c, j) => {
        const q = [...p, "configs", j];
        if (!ID_RE.test(c.id || "")) err([...q, "id"], "a short id: lowercase letters, digits or -");
        if (!c.path || !PATH_RE.test(c.path)) err([...q, "path"], "enter the config file as an absolute path");
        if (c.git_repo && c.path && !c.path.startsWith(c.git_repo.replace(/\/$/, "") + "/")) err([...q, "git_repo"], "the config file must be inside this repo");
        if ((c.restart || []).some(r => !ids.includes(r))) err([...q, "restart"], "app ids from this template");
      });
    });
    return [errors, warnings];
  }

  /* ---------------------------------------------------------------- the simulated world (kept for this browser tab) */

  const KEY = "uat-deploy-demo:v1";
  const REPOS = {
    shopfront: { branch: "feature/checkout-retry", commit: "7c41e2a Retry declined card authorisations once", dirty: 0, version: "1.8.0-SNAPSHOT" },
    "admin-portal": { branch: "main", commit: "b18f0d3 Add refund export to the orders page", dirty: 1, version: "0.9.4-SNAPSHOT" },
  };
  const SIZES = { api: "68M", payments: "54M", admin: "61M" };

  const CONFIG_FILES = {
    "api/main": { head: "3f9a21c storefront-api config: update reservation-ttl", text:
`server:
  port: 8080
  shutdown: graceful
spring:
  application:
    name: storefront-api
  datasource:
    url: jdbc:postgresql://203.0.113.20:5432/shopfront_uat
    hikari:
      maximum-pool-size: 20
checkout:
  session-timeout: 180
  max-items: 50
  currency: USD
cart:
  #reservation-ttl: 15m
  reservation-ttl: 20m
payments:
  gateway-url: https://sandbox.payments.example.com/v2
  retry:
    max-attempts: 2
    backoff: 500ms
features:
  express-checkout: false
  gift-cards: true
logging:
  level:
    com.example.shopfront: INFO
` },
    "payments/main": { head: "8d02b6e payments-worker config: update batch-size", text:
`worker:
  poll-interval: 2s
  #batch-size: 50
  batch-size: 25
  threads: 4
gateway:
  url: https://sandbox.payments.example.com/v2
  timeout: 5s
  max-attempts: 2
settlement:
  cutoff: "22:00"
  timezone: UTC
refunds:
  auto-approve-below: 50
queue:
  name: payments-uat
  dead-letter-after: 5
` },
    "admin/props": { head: "", text:
`server.port=8090
admin.session.timeout-minutes=30
admin.audit.retention-days=90
admin.reports.export-limit=5000
spring.mail.host=smtp.example.com
features.bulk-refunds=false
` },
  };
  const LOCAL_CONFIG = { "payments.retry.max-attempts": "3", "checkout.session-timeout": "300", "gateway.timeout": "10s", "worker.threads": "6" };

  function seedLive() {
    const at = (n, h, m) => daysAgo(n, h, m).getTime();
    return {
      api: { running: "yes", file: `api-${md(daysAgo(2, 0, 0))}-cart-fixes.jar`, prev: `api-${md(daysAgo(16, 0, 0))}-loyalty.jar`, line: "14", startedAt: at(2, 15, 20), pid: "41822" },
      payments: { running: "yes", file: `worker-${md(daysAgo(9, 0, 0))}-settlement.jar`, prev: `worker-${md(daysAgo(23, 0, 0))}.jar`, line: "9", startedAt: at(1, 16, 45), pid: "43107" },
      admin: { running: "yes", file: `admin-${md(daysAgo(5, 0, 0))}-main.jar`, prev: `admin-${md(daysAgo(19, 0, 0))}-main.jar`, line: "", startedAt: at(5, 12, 5), pid: "40213" },
      config: { running: "yes", file: "config-server-2.4.1.jar", prev: "", line: "6", startedAt: at(1, 16, 43), pid: "43090" },
    };
  }

  function seedActivity(live) {
    const rows = [];
    const t = FX.template, apps = Object.fromEntries(t.apps.map(a => [a.id, a]));
    const put = (d, app, action, detail, exit) => rows.push({ time: `${ymd(d)} ${hms(d)}`, user: "demo", app, action, detail, exit });
    const tick = (d, s) => new Date(d.getTime() + s * 1000);
    const restart = (d, id, file, ok = true, why = "") => {
      const a = apps[id];
      put(tick(d, 1), id, "stop", `cd ${a.dir} && ${a.stop}`, 0);
      put(tick(d, 4), id, "start", `cd ${a.dir} && bash -lc ${a.start} </dev/null`, 0);
      put(tick(d, ok ? 19 : 184), id, "restart", ok ? file : `${file} ${why}`, ok ? 0 : 1);
    };
    const deploy = (d, id, name) => {
      const a = apps[id], s = startScript(a), repo = a.build.repo;
      put(d, id, "approved on the console page", `deploy ${name}`, null);
      if (a.deploy.style === "custom") {
        put(tick(d, 2), id, "upload", `scp ~/work/${repo}/${a.build.output.replace("*.jar", name)} -> ${a.deploy.upload_dir}/${name}`, 0);
        a.deploy.steps.forEach((c, i) => put(tick(d, 9 + i), id, `deploy step ${i + 1}`, `cd ${a.dir} && ${c.replace(/\{new\}/g, name)}`, 0));
      } else {
        put(tick(d, 2), id, "copy jar", `scp ~/work/${repo}/${a.build.output.replace("*.jar", name)} -> ${a.dir}/${name}`, 0);
        put(tick(d, 9), id, "back up start script", `cd ${a.dir} && cp -np ${s} ${s}.bak-${stampOf(d)} && test -f ${s}.bak-${stampOf(d)}`, 0);
        put(tick(d, 10), id, "update start script", `scp ~/.cache/uat-deploy/templates/shopfront/${id}/${s}.new -> ${a.dir}/${s}`, 0);
      }
      restart(tick(d, 11), id, name);
    };
    const config = (d, id, file, key, hash) => {
      const a = apps[id], c = a.configs[0];
      put(d, id, "approved on the console page", `config main ${a.name} config: update ${key}`, null);
      put(tick(d, 2), id, "upload config", `scp ~/.cache/uat-deploy/templates/shopfront/${id}/config-main/${basename(c.path)} -> ${c.path}`, 0);
      put(tick(d, 3), id, "commit config", `cd ${c.git_repo} && git add -- ${basename(c.path)} && git -c user.name='Demo User' -c user.email=**** commit -q -m '${a.name} config: update ${key}'`, 0);
      restart(tick(d, 4), "config", "config-server-2.4.1.jar");
      put(tick(d, 31), id, "approved on the console page", `restart after config change: ${id}`, null);
      restart(tick(d, 32), id, file);
    };
    deploy(daysAgo(9, 10, 12, 41), "payments", live.payments.file);
    restart(daysAgo(7, 17, 40, 2), "payments", live.payments.file, false, "not ready within 180s");
    restart(daysAgo(7, 17, 46, 30), "payments", live.payments.file);
    deploy(daysAgo(5, 12, 3, 8), "admin", live.admin.file);
    put(daysAgo(4, 9, 30, 12), "", "settings", "template shopfront updated from the configurator", null);
    config(daysAgo(3, 10, 47, 3), "api", live.api.prev, "reservation-ttl", "3f9a21c");
    deploy(daysAgo(2, 15, 18, 55), "api", live.api.file);
    config(daysAgo(1, 16, 42, 20), "payments", live.payments.file, "batch-size", "8d02b6e");
    return rows.reverse();
  }

  function seed() {
    const live = seedLive();
    return {
      v: 1, current: "shopfront", theme: "",
      templates: { shopfront: { t: clone(FX.template), text: FX.file_text, modified: Date.now() - 4 * DAY } },
      local: { shopfront: { repos: { shopfront: "~/work/shopfront", "admin-portal": "~/work/admin-portal" }, builds: {}, config_dir: "~/work/shopfront-config" } },
      git: { name: "Demo User", email: "demo@example.com" },
      auth: { "deploy@203.0.113.10": { auth: "key", key_file: "~/.ssh/id_ed25519", password_saved: false } },
      mode: "ui", live, activity: seedActivity(live), configs: clone(CONFIG_FILES),
      ask: { threads: [], saved: ["What is using the disk, largest first?", "What uses the most memory?", "Which ports are listening, and which process owns each?",
                                  "What are the latest errors in this app's log?", "Find ___ in every app's log and show the lines in time order",
                                  "Did anything restart or crash in the last 24 hours?"] },
    };
  }

  let W;
  try { W = JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch { W = null; }
  if (!W || W.v !== 1) W = seed();
  for (const th of W.ask.threads) for (const i of th.items) if (i.state === "running") Object.assign(i, { state: "cancelled", ended: Date.now() });
  let saveTimer = 0;
  const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { if (W) sessionStorage.setItem(KEY, JSON.stringify(W)); } catch {} }, 50); };
  addEventListener("pagehide", () => { try { if (W) sessionStorage.setItem(KEY, JSON.stringify(W)); } catch {} });

  // the demo opens in light mode whatever the OS prefers; the page's own toggle still switches to dark
  window.__prefs = { theme: W.theme || "light" };

  const cur = () => {
    const tid = W.templates[W.current] ? W.current : Object.keys(W.templates)[0];
    return { t: W.templates[tid].t, tid };
  };
  const localOf = tid => (W.local[tid] = W.local[tid] || { repos: {}, builds: {}, config_dir: "" });
  const findApp = (t, id) => { const a = (t.apps || []).find(x => x.id === id); if (!a) throw new ApiError(404, `no app '${id}' in template '${t.id}'`); return a; };
  function liveOf(id) {
    if (!W.live[id]) {
      const a = (cur().t.apps || []).find(x => x.id === id) || { id, name: id };
      W.live[id] = { running: "yes", file: `${(a.deploy || {}).name_prefix || a.name || id}-${md(daysAgo(6, 0, 0))}.jar`, prev: "", line: "12", startedAt: Date.now() - 6 * DAY - 3 * 3600e3, pid: String(rnd(30000, 49999)) };
    }
    return W.live[id];
  }
  function audit(app, action, detail, exit) {
    const d = new Date();
    W.activity.unshift({ time: `${ymd(d)} ${hms(d)}`, user: "demo", app, action, detail: String(detail).slice(0, 400), exit, mine: cur().tid });
    W.activity.length = Math.min(W.activity.length, 250);
    save();
  }

  /* ---------------------------------------------------------------- console: the template as the page needs it */

  function readyText(t, a) {
    const r = readyOf(t, a), parts = [];
    if (a.log && r.log) parts.push(`log line /${r.log}/`);
    if (a.port) parts.push(`port ${a.port} open`);
    if (r.url) parts.push(`${r.url} answers`);
    return (parts.length ? parts.join(", ") : "the process is up") + `, up to ${timeoutOf(t, a, "start_timeout", 180)} s`;
  }
  const restartRoute = (t, a) => [
    { key: "stop", zone: "change", label: "Stop", what: a.stop || "" },
    { key: "start", zone: "change", label: "Start", what: a.start || "" },
    { key: "ready", zone: "read", label: "Wait until ready", what: readyText(t, a) }];
  function pushRoute(a) {
    const dep = a.deploy || {};
    if (dep.style === "jar-start-script") {
      const s = startScript(a) || "the start script";
      return [{ key: "copy", zone: "change", label: "Copy the new file", what: a.dir || "" },
              { key: "unchanged", zone: "read", label: "Confirm the start script is unchanged", what: s },
              { key: "backup", zone: "change", label: "Back up the start script", what: `${s}.bak-<time>` },
              { key: "switch", zone: "change", label: "Point the start script at the new file",
                what: (dep.edit || "duplicate") === "duplicate" ? "comment the old line, add a copy" : "swap the name in place" }];
    }
    return [{ key: "copy", zone: "change", label: "Upload the new file", what: dep.upload_dir || a.dir || "" },
            ...(dep.steps || []).map((c, i) => ({ key: `step${i + 1}`, zone: "change", label: `Step ${i + 1}`, what: c }))];
  }
  function rollbackRoute(a) {
    const dep = a.deploy || {};
    if (dep.style === "jar-start-script") return [{ key: "restore", zone: "change", label: "Restore the start script", what: "from the backup made before the deploy" }];
    return (dep.rollback || []).map((c, i) => ({ key: `rb${i + 1}`, zone: "change", label: `Rollback step ${i + 1}`, what: c }));
  }
  const deployRoute = (t, a, cmd) => [
    { key: "name", zone: "local", label: "Name the new file", what: "" },
    { key: "build", zone: "local", label: "Build", what: cmd },
    { key: "rename", zone: "local", label: "Rename the built file", what: (a.build || {}).output || "" },
    { key: "check", zone: "read", label: "Check UAT", what: "folder, scripts, disk, name; nothing changes" },
    { key: "gate", zone: "gate", label: "Your approval", what: "" },
    ...pushRoute(a), ...restartRoute(t, a)];

  const OPS = new Map();
  const busyApps = {}, busyRepos = {};
  const latestOp = (appId, kinds) => [...OPS.values()].sort((x, y) => y.started - x.started).find(o => o.app === appId && kinds.includes(o.kind) && !o.dismissed)?.id || null;
  const DEPLOY_KINDS = ["deploy", "restart", "rollback"], CONFIG_KINDS = ["config", "config-revert"];
  function busyBy(appId) {
    const op = OPS.get(busyApps[appId]);
    return op && op.app !== appId ? `Restarting for a config change of ${op.label}` : "";
  }

  function appView(t, tid, a) {
    const L = localOf(tid), build = a.build || {}, dep = a.deploy || {};
    const style = dep.style || "none", repo = build.repo || "";
    const path = repo ? (L.repos[repo] || "") : "";
    const cmd = L.builds[a.id] || build.command || "";
    let blocked = "";
    if (style !== "none") {
      if (!cmd) blocked = "The template has no build command for this app.";
      else if (!path) blocked = `The local folder of the '${repo}' repo is not set on this machine.`;
    }
    const s = (t.servers || {})[a.server] || {};
    return {
      id: a.id, name: a.name || a.id, server: a.server, target: serverKey(s), dir: a.dir, port: a.port || null, process: a.process || "",
      log: a.log || "", start: a.start || "", stop: a.stop || "", style, ext: artifactExt(a),
      startScript: style === "jar-start-script" ? (startScript(a) || "") : "", repo, repoPath: path, build: cmd,
      buildOverride: !!L.builds[a.id], blocked, ready: readyText(t, a), hasRollback: style === "jar-start-script" || !!(dep.rollback || []).length,
      configs: (a.configs || []).map(c => ({ id: c.id, path: c.path, format: configFormat(c), git: !!c.git_repo, servedBy: c.served_by || "",
                                            verify: !!c.verify_url, restart: c.restart || [] })),
      route: style !== "none" ? deployRoute(t, a, cmd) : [], restartRoute: restartRoute(t, a),
      op: latestOp(a.id, DEPLOY_KINDS), cfgOp: latestOp(a.id, CONFIG_KINDS), busyBy: busyBy(a.id),
    };
  }

  function templateList() {
    return Object.entries(W.templates).sort(([x], [y]) => x.localeCompare(y)).map(([id, { t, modified }]) => {
      const [errors, warnings] = validate(t, id);
      return { id, file: `templates/${id}.yml`, modified: Math.round(modified / 1000), name: t.name || id, description: t.description || "",
               apps: (t.apps || []).map(a => ({ id: a.id, name: a.name })), servers: Object.entries(t.servers || {}).map(([k, s]) => ({ id: k, host: s.host, user: s.user })),
               errors: errors.length, warnings: warnings.length };
    });
  }

  function state() {
    const { t, tid } = cur();
    const [errors] = validate(t, tid);
    return {
      template: { id: tid, name: t.name || tid, description: t.description || "", problems: errors.length },
      templates: templateList().map(x => ({ id: x.id, name: x.name })),
      servers: usedServers(t).map(sid => { const s = t.servers[sid] || {}; return { id: sid, label: s.label || sid, target: serverKey(s), signIn: "SSH key", signInReady: true }; }),
      user: "demo", apps: (t.apps || []).filter(a => a && a.id).map(a => appView(t, tid, a)), claude: true, engine: true, model: "sonnet",
    };
  }

  function suggestions(a) {
    const dep = a.deploy || {}, ext = artifactExt(a), repo = REPOS[(a.build || {}).repo] || { branch: "main" };
    const slugRaw = repo.branch.split("/").pop().toLowerCase().replace(/[^a-z0-9.-]/g, "-");
    const prefix = dep.name_prefix || a.id;
    const slug = prefix.endsWith(slugRaw) ? "" : slugRaw;
    const L = liveOf(a.id), cur = L.active || L.file;
    // the demo always offers a name that deploys cleanly: never the running jar, the previous one, or one deployed earlier
    const taken = new Set([L.active, L.file, L.prev, ...(L.used || [])].filter(Boolean));
    const free = (stem) => {
      const m = /^(.*)-v(\d+)$/.exec(stem), base = m ? m[1] : stem;
      let n = m ? +m[2] : 1, name = stem + ext;
      while (taken.has(name)) name = `${base}-v${++n}${ext}`;
      return name;
    };
    const suggested = free(`${prefix}-${md(new Date())}${slug ? "-" + slug : ""}`);
    let append = "";
    if (cur) { const stem = cur.slice(0, cur.length - ext.length); append = free(/-v\d+$/.test(stem) ? stem : `${stem}-v2`); }
    if (append === suggested) append = "";
    return { suggested, append, branch: repo.branch };
  }

  function current(appId) {
    const { t } = cur(), a = findApp(t, appId), L = liveOf(appId), style = (a.deploy || {}).style || "none";
    const up = L.running === "yes";
    const out = { app: appId, at: Date.now(), ok: true, error: "", running: L.running, uptime: up ? Math.round((Date.now() - L.startedAt) / 1000) : null,
                  pid: up ? L.pid : "", runningFile: up ? L.file : "", activeFile: L.active || L.file, activeLine: style === "jar-start-script" ? L.line : "",
                  suggested: "", append: "", branch: "", missingDir: "" };
    if (style !== "none") Object.assign(out, suggestions(a));
    // the demo's default path always succeeds: an empty name field, or one still holding a name already on the server
    // (the jar just deployed), is filled with the free suggested name; a name the visitor typed is left alone
    try {
      const d = S.drafts[appId], onServer = [L.active, L.file, L.prev, ...(L.used || [])];
      if (out.suggested && (!d || onServer.includes(d))) S.drafts[appId] = out.suggested;
    } catch { /* the page has not started yet */ }
    return out;
  }

  function overview() {
    const { t } = cur();
    const servers = {};
    for (const sid of usedServers(t)) {
      const s = t.servers[sid] || {};
      servers[sid] = { ok: true, text: `connected as ${s.user}@${(s.aliases || [])[0] || sid}; openjdk version "21.0.5" 2024-10-15; git 2.34.1; login shell: ok` };
    }
    const apps = {};
    for (const a of t.apps || []) apps[a.id] = current(a.id);
    return { servers, apps };
  }

  /* ---------------------------------------------------------------- operations */

  class Op {
    constructor(kind, app, view, route, name = "") {
      this.id = hms(new Date()).replace(/:/g, "") + "-" + hex(6);
      Object.assign(this, { kind, app, label: view.name, name, target: view.target, repo: view.repo });
      this.stations = route.map(s => ({ ...s, status: "pending", note: "", t0: null, t1: null }));
      Object.assign(this, { state: "running", phase: "prepare", lines: [], n: 0, plan: null, result: {}, error: "", failedAt: "", facts: [],
                            canRollback: false, rolledBack: false, dismissed: false, started: Date.now(), ended: null, cancelled: false,
                            cfg: "", text: "", question: "", info: {}, plan2: null, canRevert: false, reverted: false, restarted: [], waiters: [] });
    }
    touch() { const w = this.waiters.splice(0); w.forEach(f => f()); }
    st(key) { return this.stations.find(s => s.key === key); }
    mark(key, status, note) {
      const s = this.st(key);
      if (!s) return;
      if (status === "running" && s.t0 == null) s.t0 = Date.now();
      if (["done", "failed", "skipped"].includes(status)) { s.t0 = s.t0 || Date.now(); s.t1 = Date.now(); }
      s.status = status;
      if (note != null) s.note = String(note).slice(0, 300);
      this.touch();
    }
    say(key, text, raw = false) {
      this.n += 1;
      this.lines.push({ n: this.n, st: key, t: String(text).slice(0, 600), raw });
      if (this.lines.length > 1500) this.lines.shift();
      this.touch();
    }
    stamp() { return hashStr(JSON.stringify([this.n, this.state, this.question, !!this.plan, !!this.plan2, this.stations.map(s => [s.status, s.note])])); }
    view(since) {
      return { id: this.id, kind: this.kind, app: this.app, label: this.label, name: this.name, state: this.state, phase: this.phase,
               stations: this.stations, plan: this.plan, result: this.result, error: this.error, failedAt: this.failedAt, facts: this.facts,
               canRollback: this.canRollback && !this.rolledBack, rolledBack: this.rolledBack, started: this.started, ended: this.ended, n: this.n,
               cfg: this.cfg, text: this.text, question: this.question, plan2: this.plan2, canRevert: this.canRevert && !this.reverted,
               reverted: this.reverted, lines: this.lines.filter(l => l.n > since) };
    }
  }

  const pause = async (op, ms) => { await sleep(ms); if (op.cancelled) throw CANCEL; };

  function finish(op, how) {
    op.state = how; op.ended = Date.now();
    for (const [a, id] of Object.entries(busyApps)) if (id === op.id) delete busyApps[a];
    for (const [r, id] of Object.entries(busyRepos)) if (id === op.id) delete busyRepos[r];
    save();
    op.touch();
  }
  function fail(op, key, reason) {
    if (op.cancelled) { op.mark(key, "failed", "cancelled"); return finish(op, "cancelled"); }
    op.mark(key, "failed", reason);
    op.error = reason; op.failedAt = key;
    for (const s of op.stations) if (s.status === "pending") s.status = "skipped";
    finish(op, "failed");
  }
  function claim(app, repo, op) {
    if (busyApps[app]) throw new ApiError(409, "This app already has an operation running.");
    if (repo && busyRepos[repo]) throw new ApiError(409, `${OPS.get(busyRepos[repo]).label} is building from the same local repo. Start this one when that build is done.`);
    const family = CONFIG_KINDS.includes(op.kind) ? CONFIG_KINDS : DEPLOY_KINDS;
    for (const o of OPS.values()) if (o.app === app && family.includes(o.kind)) o.dismissed = true;
    busyApps[app] = op.id;
    if (repo) busyRepos[repo] = op.id;
    OPS.set(op.id, op);
  }
  function guarded(op, fn, ...args) {
    (async () => {
      try { await fn(op, ...args); }
      catch (e) {
        const key = op.stations.find(s => s.status === "running")?.key || op.stations[0].key;
        if (e === CANCEL) { op.mark(key, "failed", "cancelled"); for (const s of op.stations) if (s.status === "pending") s.status = "skipped"; finish(op, "cancelled"); }
        else if (["running", "awaiting"].includes(op.state)) { console.error(e); fail(op, key, `the console hit an error: ${e.message}`); }
      }
    })();
  }

  /* walk stations the way the console's stepper does: each step's output lines become its note */
  async function runSteps(op, steps) {
    let prev = null;
    for (const step of steps) {
      if (prev) op.mark(prev, "done");
      op.mark(step.key, "running");
      prev = step.key;
      for (const [ms, line] of step.lines) {
        await pause(op, ms);
        if (!line) continue;
        op.say(step.key, line);
        if (!/^(ERROR:|---)/.test(line)) op.mark(step.key, "running", line);
      }
    }
    return prev;
  }

  const BROKEN = {
    api: { key: "checkout.tax-service-url", bean: "taxClient", cls: "TaxClient", type: "java.net.URI", value: "https://tax.sandbox.example.com/v1" },
    payments: { key: "settlement.report-bucket", bean: "settlementReporter", cls: "SettlementReporter", type: "java.lang.String", value: "acme-uat-settlement-reports" },
    admin: { key: "admin.reports.storage-dir", bean: "reportStore", cls: "ReportStore", type: "java.nio.file.Path", value: "/opt/acme/admin-portal/reports" },
  };
  const brokenOf = a => BROKEN[a.id] || { key: "app.feature.new-checkout", bean: "featureFlags", cls: "FeatureFlags", type: "java.lang.Boolean", value: "false" };
  const cfgName = a => (a.configs && a.configs[0] ? basename(a.configs[0].path) : "its config file");

  const mainClass = a => ({ api: "StorefrontApiApplication", payments: "PaymentsWorkerApplication", admin: "AdminPortalApplication", config: "ConfigServerApplication" })[a.id] || pascal(a.name || a.id) + "Application";

  async function restartPart(op, appId = op.app, prefix = "") {
    const { t } = cur(), a = findApp(t, appId), L = liveOf(appId), r = readyOf(t, a);
    if (appId !== op.app) {
      const other = OPS.get(busyApps[appId]);
      if (other && other.id !== op.id) { fail(op, prefix + "stop", `${appId} has an operation running (${other.kind}); restart it when that is done`); return false; }
      busyApps[appId] = op.id;
    }
    const broken = op.kind === "deploy" && appId === op.app && /broken|fail/i.test(op.name);
    const next = L.active || L.file;
    await runSteps(op, [
      { key: prefix + "stop", lines: [[1300, a.port ? `port ${a.port} is free` : a.process ? `no process matches '${a.process}'` : "the template sets no port or process match, so the stop is not checked"]] },
      { key: prefix + "start", lines: [[900, ""]] }]);
    audit(appId, "stop", `cd ${a.dir} && ${a.stop}`, 0);
    audit(appId, "start", `cd ${a.dir} && bash -lc ${a.start} </dev/null`, 0);
    L.running = "no"; save();
    const key = prefix + "ready";
    op.mark(prefix + "start", "done");
    op.mark(key, "running");
    const port = a.port ? (ok => `, port ${a.port} ${ok ? "open" : "not open yet"}`) : () => "";
    const url = r.url ? (ok => `, health URL ${ok ? "answers" : "not answering yet"}`) : () => "";
    for (const sec of broken ? [5, 10, 15] : [5, 10]) {
      await pause(op, 1300);
      const line = `${sec}s: process up${port(false)}${url(false)}`;
      op.say(key, line); op.mark(key, "running", line);
    }
    if (broken) {
      await pause(op, 900);
      const why = `${a.name} did not come up: the log matched the failure pattern /${r.fail || "APPLICATION FAILED TO START"}/`;
      op.say(key, `ERROR: ${why}`);
      audit(appId, "restart", `${next} ${why}`, 1);
      L.running = "no"; L.brokenAt = Date.now(); save();
      op.facts.push([appId === op.app ? "App" : appId, "not running"]);
      fail(op, key, why);
      return false;
    }
    await pause(op, 1300);
    const secs = (rnd(800, 1650) / 100).toFixed(2);
    const ready = r.log && a.log ? `15s: Started ${mainClass(a)} in ${secs} seconds (process running for ${(+secs + 1.2).toFixed(1)})`
      : `15s: process up${port(true)}${url(true)}`;
    op.say(key, ready);
    op.say(key, `RESTART OK: ${a.name} is running${(a.deploy || {}).style === "jar-start-script" ? " " + next : ""}`);
    Object.assign(L, { running: "yes", file: next, active: undefined, startedAt: Date.now(), pid: String(rnd(44000, 49999)), brokenAt: undefined });
    audit(appId, "restart", next, 0);
    op.mark(key, "done", ready);
    op.result.ready = ready;
    return true;
  }

  function buildLines(v, a) {
    const repo = REPOS[v.repo] || { version: "1.0.0-SNAPSHOT" }, ver = repo.version, root = v.repoPath;
    const mod = /-pl\s+(\S+)/.exec(v.build)?.[1];
    const lines = [], L = (ms, t) => lines.push([ms, t]);
    const plugin = (name, goal, mod2, extra = []) => { L(90, "[INFO] "); L(110, `[INFO] --- ${name}:${goal} @ ${mod2} ---`); extra.forEach(x => L(160, x)); };
    const module = (name, pack, n, total, src, files, slow) => {
      L(120, `[INFO] ${"-".repeat(Math.max(3, 26 - name.length / 2))}< com.example.shopfront:${name} >${"-".repeat(Math.max(3, 26 - name.length / 2))}`);
      L(80, `[INFO] Building ${name} ${ver}${" ".repeat(Math.max(1, 46 - name.length - ver.length))}[${n}/${total}]`);
      L(60, `[INFO]   from ${src}`);
      L(60, `[INFO] --------------------------------[ ${pack} ]---------------------------------`);
      plugin("clean:3.3.2", "clean (default-clean)", name, pack === "pom" ? [] : [`[INFO] Deleting ${root}/${src.replace(/pom\.xml$/, "")}target`]);
      if (pack === "pom") return;
      plugin("resources:3.3.1", "resources (default-resources)", name, [`[INFO] Copying ${rnd(2, 9)} resources from src/main/resources to target/classes`]);
      plugin("compiler:3.13.0", "compile (default-compile)", name, ["[INFO] Recompiling the module because of changed source code.", `[INFO] Compiling ${files} source files with javac [debug release 21] to target/classes`]);
      if (slow) { L(900, ""); if (name === "storefront-api") L(1200, `[WARNING] ${root}/${src.replace(/pom\.xml$/, "")}src/main/java/com/example/shopfront/api/legacy/CouponMapper.java: Some input files use or override a deprecated API.`); L(1500, ""); }
      plugin("surefire:3.2.5", "test (default-test)", name, ["[INFO] Tests are skipped."]);
      plugin("jar:3.4.1", "jar (default-jar)", name, [`[INFO] Building jar: ${root}/${src.replace(/pom\.xml$/, "")}target/${name}-${ver}.jar`]);
      if (slow) plugin("spring-boot:3.3.5", "repackage (repackage)", name, [`[INFO] Replacing main artifact ${root}/${src.replace(/pom\.xml$/, "")}target/${name}-${ver}.jar with repackaged archive, adding nested dependencies in BOOT-INF/.`]);
    };
    L(300, "[INFO] Scanning for projects...");
    const mods = mod ? [["shopfront", "pom", "pom.xml", 0, false], ["shopfront-common", "jar", "shopfront-common/pom.xml", 46, false], [mod, "jar", `${mod}/pom.xml`, mod === "storefront-api" ? 212 : 131, true]]
      : [[a.name, "jar", "pom.xml", 158, true]];
    if (mods.length > 1) {
      L(150, "[INFO] ------------------------------------------------------------------------");
      L(60, "[INFO] Reactor Build Order:");
      L(40, "[INFO] ");
      for (const [n, p] of mods) L(40, `[INFO] ${n}${" ".repeat(Math.max(1, 67 - n.length))}[${p}]`);
    }
    L(80, "[INFO] ");
    mods.forEach(([n, p, src, files, slow], i) => module(n, p, i + 1, mods.length, src, files, slow));
    L(200, "[INFO] ------------------------------------------------------------------------");
    if (mods.length > 1) {
      L(60, `[INFO] Reactor Summary for shopfront ${ver}:`);
      L(40, "[INFO] ");
      const times = ["0.214", (rnd(380, 520) / 100).toFixed(3), (rnd(2600, 3400) / 100).toFixed(3)];
      mods.forEach(([n], i) => L(50, `[INFO] ${n} ${".".repeat(Math.max(3, 51 - n.length))} SUCCESS [${times[i].padStart(7)} s]`));
      L(50, "[INFO] ------------------------------------------------------------------------");
    }
    L(120, "[INFO] BUILD SUCCESS");
    L(40, "[INFO] ------------------------------------------------------------------------");
    L(40, `[INFO] Total time:  ${(rnd(3200, 4400) / 100).toFixed(3)} s`);
    L(40, `[INFO] Finished at: ${new Date().toISOString().replace(/\.\d+Z$/, "Z")}`);
    L(40, "[INFO] ------------------------------------------------------------------------");
    return lines;
  }

  function scriptDiff(a, oldJar, newJar) {
    const dep = a.deploy || {}, log = a.log || `${a.dir}/app.log`;
    if ((dep.edit || "duplicate") === "duplicate") return [
      "@@ -11,4 +11,5 @@", " export SPRING_PROFILES_ACTIVE=uat", ` cd ${a.dir}`,
      `-nohup java -Xms512m -Xmx1g -jar ${oldJar} > ${log} 2>&1 &`,
      `+#nohup java -Xms512m -Xmx1g -jar ${oldJar} > ${log} 2>&1 &`,
      `+nohup java -Xms512m -Xmx1g -jar ${newJar} > ${log} 2>&1 &`, " echo $! > app.pid"];
    return [
      "@@ -7,5 +7,5 @@", " nohup java -Xms256m -Xmx768m \\", "   -Dspring.profiles.active=uat \\",
      `-  -jar ${oldJar} \\`, `+  -jar ${newJar} \\`, `   >> ${log} 2>&1 &`];
  }

  async function prepare(op, v) {
    const { t } = cur(), a = findApp(t, op.app), L = liveOf(op.app), repo = REPOS[v.repo] || { branch: "main", commit: "0000000 Local build", dirty: 0, version: "1.0.0-SNAPSHOT" };
    op.mark("name", "done", op.name);
    const before = current(op.app);
    op.mark("build", "running");
    for (const [ms, line] of buildLines(v, a)) { await pause(op, ms); op.say("build", line, true); }
    const source = `${repo.branch} @ ${repo.commit}`;
    op.mark("build", "done", `${source}${repo.dirty ? `, ${repo.dirty} uncommitted file(s)` : ""}, in ${fmtSpan(Date.now() - op.st("build").t0)}`);
    op.mark("rename", "running");
    await pause(op, 700);
    const outDir = dirname(a.build.output), built = `${/-pl\s+(\S+)/.exec(v.build)?.[1] || a.name}-${repo.version}${v.ext}`;
    op.mark("rename", "done", `${built} -> ${op.name}`);
    op.mark("check", "running");
    const uploadDir = v.style === "custom" ? (a.deploy.upload_dir || a.dir) : a.dir;
    const checks = [
      ["PASS", `local file ${v.repoPath}/${outDir}/${op.name} (${SIZES[a.id] || "48M"})`],
      ["PASS", `app folder ${a.dir}`],
      scriptOf(a.start) && ["PASS", `start script ${scriptOf(a.start)}`],
      scriptOf(a.stop) && ["PASS", `stop script ${scriptOf(a.stop)}`],
      a.log && ["PASS", `log folder ${dirname(a.log)}`],
      ["PASS", `${op.name} is a new name in ${uploadDir}`],
      ["PASS", "disk 61% used, 19968 MB free"],
      L.running === "yes" ? ["INFO", `running now: ${L.file} (pid ${L.pid}, up ${etime(Math.round((Date.now() - L.startedAt) / 1000))})`]
        : ["WARN", `nothing is listening on port ${a.port} right now`],
    ].filter(Boolean).map(([s, text]) => ({ s, t: text }));
    for (const c of checks) { await pause(op, 280); op.say("check", `${c.s}  ${c.t}`); }
    await pause(op, 600);
    const warns = checks.filter(c => c.s === "WARN").length;
    op.mark("check", "done", `${checks.filter(c => c.s === "PASS").length} checks pass` + (warns ? `, ${warns} to read` : ""));
    const fill = c => c.replace(/\{new\}/g, op.name).replace(/\{dir\}/g, a.dir).replace(/\{upload_dir\}/g, uploadDir).replace(/\{stamp\}/g, stampOf(new Date()));
    const replaces = before.activeFile || before.runningFile || "";
    op.plan = {
      app: op.app, label: op.label, target: op.target, server: v.server, name: op.name, size: SIZES[a.id] || "48M", sha: hex(12), source, dirty: repo.dirty,
      style: v.style, replaces, running: before.running, uptime: before.uptime, checks,
      diff: v.style === "jar-start-script" ? scriptDiff(a, replaces, op.name) : [], editMode: v.style === "jar-start-script" ? (a.deploy.edit || "duplicate") : "",
      startScript: v.startScript, upload: v.style === "custom" ? `${op.name} -> ${uploadDir}/${op.name}` : "",
      steps: v.style === "custom" ? (a.deploy.steps || []).map(fill) : [], rollback: v.style === "custom" ? (a.deploy.rollback || []).map(fill) : [],
      ready: v.ready, route: op.stations.filter(s => s.zone !== "local" && !["check", "gate"].includes(s.key)).map(s => s.label), digest: hex(16),
    };
    op.state = "awaiting";
    op.mark("gate", "running");
  }

  async function change(op, v) {
    op.phase = "change";
    const { t } = cur(), a = findApp(t, op.app), L = liveOf(op.app);
    if (op.kind === "deploy") {
      op.mark("gate", "done", "approved");
      const s = startScript(a), stamp = stampOf(new Date()), repoPath = v.repoPath, outDir = dirname(a.build.output);
      if (v.style === "jar-start-script") {
        await runSteps(op, [
          { key: "copy", lines: [[1700, "copied, checksum matches"]] },
          { key: "unchanged", lines: [[500, "unchanged"]] },
          { key: "backup", lines: [[600, `backup: ${s}.bak-${stamp}`]] },
          { key: "switch", lines: [[800, `PUSH OK: ${op.name} is in ${a.dir} and ${s} now runs it (backup ${s}.bak-${stamp})`]] }]);
        op.mark("switch", "done", `the next start runs ${op.name}`);
        audit(op.app, "copy jar", `scp ${repoPath}/${outDir}/${op.name} -> ${a.dir}/${op.name}`, 0);
        audit(op.app, "back up start script", `cd ${a.dir} && cp -np ${s} ${s}.bak-${stamp} && test -f ${s}.bak-${stamp}`, 0);
        audit(op.app, "update start script", `scp ~/.cache/uat-deploy/templates/${cur().tid}/${op.app}/${s}.new -> ${a.dir}/${s}`, 0);
        L.backup = `${s}.bak-${stamp}`;
      } else {
        const up = a.deploy.upload_dir || a.dir, steps = op.plan.steps;
        const last = await runSteps(op, [{ key: "copy", lines: [[1700, "uploaded, checksum matches"]] },
          ...steps.map((c, i) => ({ key: `step${i + 1}`, lines: [[700, i === steps.length - 1 ? `PUSH OK: ${op.name} is in ${up} and ${steps.length} step(s) ran` : ""]] }))]);
        op.mark(last, "done");
        audit(op.app, "upload", `scp ${repoPath}/${outDir}/${op.name} -> ${up}/${op.name}`, 0);
        steps.forEach((c, i) => audit(op.app, `deploy step ${i + 1}`, `cd ${a.dir} && ${c}`, 0));
      }
      op.canRollback = v.hasRollback;
      op.facts = [["New file", "on the server"], ["Switch", "done: the next start runs the new file"]];
      L.prev = L.file; L.active = op.name; L.deployed = op.name; L.used = [...new Set([...(L.used || []), op.name])]; save();
    } else if (op.kind === "rollback") {
      const keys = op.stations.filter(s => !["gate", "stop", "start", "ready"].includes(s.key)).map(s => s.key);
      const src = op.source, prev = L.prev || L.file;
      if (v.style === "jar-start-script") {
        await runSteps(op, [{ key: "restore", lines: [[1200, `ROLLED BACK: ${v.startScript} restored from ${L.backup || v.startScript + ".bak"} (runs ${prev} again). ${src.name} stays in ${a.dir}. Restart to bring the previous jar up.`]] }]);
        audit(op.app, "restore start script", `cd ${a.dir} && cp -p ${L.backup} ${v.startScript}`, 0);
      } else {
        await runSteps(op, keys.map((k, i) => ({ key: k, lines: [[900, i === keys.length - 1 ? `ROLLED BACK: ${keys.length} step(s) ran. ${src.name} stays in ${a.deploy.upload_dir}. Restart to bring the previous version up.` : ""]] })));
        keys.forEach((k, i) => audit(op.app, `rollback step ${i + 1}`, `cd ${a.dir} && ${(a.deploy.rollback || [])[i] || ""}`, 0));
      }
      op.mark(keys[keys.length - 1], "done", op.lines.filter(l => l.t.startsWith("ROLLED BACK")).pop()?.t);
      L.active = prev; L.prev = ""; save();
    }
    if (await restartPart(op)) {
      const after = current(op.app);
      op.result.file = after.runningFile || after.activeFile || op.name;
      op.result.total = fmtSpan(Date.now() - op.started);
      op.facts = [];
      finish(op, "done");
    }
  }

  function startDeploy(body) {
    const { t, tid } = cur(), a = findApp(t, body.app), v = { ...appView(t, tid, a), tid };
    const name = body.name;
    if (v.style === "none") throw new ApiError(400, `${v.name} is restart only in the template.`);
    if (v.blocked) throw new ApiError(409, v.blocked);
    if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(name) || !name.endsWith(v.ext || "")) throw new ApiError(400, `Use letters, digits, . _ - and end the name in ${v.ext || "the file extension"}.`);
    const op = new Op("deploy", v.id, v, v.route, name);
    claim(v.id, v.repo, op);
    guarded(op, prepare, v);
    return { op: op.id };
  }

  function restartPlan(v, c) {
    return { app: v.id, label: v.name, target: v.target, server: v.server, stop: v.stop, start: v.start, ready: v.ready,
             running: c.running, uptime: c.uptime, file: c.runningFile || c.activeFile };
  }

  function startSimple(body, kind) {
    let src = null, appId = body.app;
    if (kind === "rollback") {
      src = OPS.get(body.op);
      if (!src || !src.canRollback || src.rolledBack || !["failed", "done"].includes(src.state)) throw new ApiError(409, "There is nothing to roll back here.");
      appId = src.app;
    }
    const { t, tid } = cur(), a = findApp(t, appId), v = { ...appView(t, tid, a), tid };
    const route = [{ key: "gate", zone: "gate", label: "Your approval", what: "" }, ...(kind === "rollback" ? rollbackRoute(a) : []), ...restartRoute(t, a)];
    const op = new Op(kind, v.id, v, route, src ? src.name : "");
    claim(v.id, "", op);
    op.source = src;
    const plan = restartPlan(v, current(v.id));
    if (kind === "rollback") Object.assign(plan, { undo: src.name, steps: v.style === "custom" ? rollbackRoute(a).map(s => s.what) : [], style: v.style, startScript: v.startScript });
    plan.digest = hex(16);
    op.plan = plan; op.state = "awaiting";
    op.mark("gate", "running");
    return { op: op.id };
  }

  async function approveSimple(op, v) {
    op.phase = "change";
    op.mark("gate", "done", "approved");
    if (op.kind === "rollback") {
      await change(op, v);
      if (op.state === "done" && op.source) op.source.rolledBack = true;
      return;
    }
    if (await restartPart(op)) {
      const after = current(op.app);
      op.result.file = after.runningFile || after.activeFile || "";
      op.result.total = fmtSpan(Date.now() - op.started);
      finish(op, "done");
    }
  }

  function approveAny(body) {
    const op = OPS.get(body.op);
    if (!op) throw new ApiError(404, "That operation is no longer here.");
    const { t, tid } = cur(), v = { ...appView(t, tid, findApp(t, op.app)), tid };
    if (op.state !== "awaiting" || !op.plan || body.digest !== op.plan.digest || (CONFIG_KINDS.includes(op.kind) && op.phase !== "prepare"))
      throw new ApiError(409, "The plan on this page is out of date. Reload it, read it again, then approve.");
    op.state = "running";
    audit(op.app, "approved on the console page", `${op.kind} ${op.kind === "config" ? `${op.cfg} ${op.plan.message || ""}` : op.name}`.trim(), null);
    if (op.kind === "config") guarded(op, configChange, v);
    else if (op.kind === "config-revert") guarded(op, configRevertRun, v);
    else if (op.kind === "restart" || op.kind === "rollback") guarded(op, approveSimple, v);
    else guarded(op, change, v);
    return { ok: true };
  }

  function cancel(body) {
    const op = OPS.get(body.op);
    if (!op) throw new ApiError(404, "That operation is no longer here.");
    if (op.phase !== "prepare") throw new ApiError(409, "This operation is already changing UAT; it runs to the end so the server is not left half way.");
    if (op.state === "awaiting" || op.state === "asking") {
      if (op.kind === "config") for (const k of ["edit", "diff"]) if (["running", "pending"].includes(op.st(k).status)) op.st(k).status = "skipped";
      op.mark("gate", "skipped", "cancelled");
      for (const s of op.stations) if (s.status === "pending") s.status = "skipped";
      op.dismissed = op.kind !== "deploy";
      finish(op, "cancelled");
      return { ok: true };
    }
    if (op.state === "running") op.cancelled = true;
    return { ok: true };
  }

  /* ---------------------------------------------------------------- config changes */

  const cfgKey = (appId, cfgId) => `${appId}/${cfgId}`;
  function cfgFile(appId, c) {
    const k = cfgKey(appId, c.id);
    if (!W.configs[k]) {
      const fmt = configFormat(c);
      W.configs[k] = { head: c.git_repo ? `${hex(7)} Initial UAT config` : "", text: fmt === "properties" ? "server.port=8080\napp.feature.new-checkout=false\napp.cache.ttl-seconds=300\n"
        : "server:\n  port: 8080\napp:\n  cache:\n    ttl-seconds: 300\n  feature:\n    new-checkout: false\n" };
    }
    return W.configs[k];
  }

  function leaves(text, fmt) {
    const out = [], lines = text.split("\n");
    if (fmt === "properties") {
      lines.forEach((l, i) => { const m = /^([A-Za-z0-9_.\-]+)\s*=\s*(.*)$/.exec(l); if (m) out.push({ i, indent: "", key: m[1], value: m[2], path: m[1] }); });
      return out;
    }
    const stack = [];
    lines.forEach((l, i) => {
      if (!l.trim() || /^\s*#/.test(l)) return;
      const m = /^(\s*)([A-Za-z0-9_.\-]+):\s*(.*)$/.exec(l);
      if (!m) return;
      const ind = m[1].length;
      while (stack.length && stack[stack.length - 1][0] >= ind) stack.pop();
      const path = [...stack.map(s => s[1]), m[2]].join(".");
      if (m[3] === "" || m[3].startsWith("#")) stack.push([ind, m[2], i]);
      else out.push({ i, indent: m[1], key: m[2], value: m[3].replace(/\s+#.*$/, ""), path });
    });
    return out;
  }
  function sections(text) {
    const out = [], stack = [];
    text.split("\n").forEach((l, i) => {
      if (!l.trim() || /^\s*#/.test(l)) return;
      const m = /^(\s*)([A-Za-z0-9_.\-]+):\s*(.*)$/.exec(l);
      if (!m) return;
      const ind = m[1].length;
      while (stack.length && stack[stack.length - 1][0] >= ind) stack.pop();
      if (m[3] === "") { stack.push([ind, m[2]]); out.push({ i, ind, path: stack.map(s => s[1]).join(".") }); }
    });
    return out;
  }

  function parseRequest(text) {
    const t = String(text || "").trim();
    const val = v => v.replace(/^["'`]|["'`]$/g, "").replace(/[.,;]$/, "");
    let m = /\b(?:set|change|update|make|raise|lower|increase|decrease|put)\s+(?:the\s+)?(?:key\s+|value\s+(?:of\s+)?)?`?([A-Za-z0-9_.\-]+)`?\s+(?:to|=|at)\s+`?("[^"]*"|'[^']*'|[^\s`,;]+)`?/i.exec(t)
      || /`?([A-Za-z0-9_\-]+(?:\.[A-Za-z0-9_\-]+)+)`?\s*(?:=|:|\bto\b)\s*`?("[^"]*"|'[^']*'|[^\s`,;]+)`?/i.exec(t)
      || /\badd\s+`?([A-Za-z0-9_.\-]+)`?\s*(?:=|:|with(?: value)?|as)\s*`?("[^"]*"|'[^']*'|[^\s`,;]+)`?/i.exec(t);
    if (m) return { key: m[1], value: val(m[2]), add: /\badd\b/i.test(t) };
    m = /\b(?:copy|take|use)\s+(?:the\s+)?(?:key\s+|value\s+(?:of\s+)?)?`?([A-Za-z0-9_.\-]+)`?.*\blocal\b/i.exec(t);
    if (m) return { key: m[1], copy: true };
    m = /`?([A-Za-z0-9_\-]+(?:\.[A-Za-z0-9_\-]+)+)`?/.exec(t);
    if (m) return { key: m[1] };
    m = /\b(?:to|=)\s+`?([^\s`,;]+)`?\s*$/i.exec(t) || /^\s*`?([^\s`]+)`?\s*$/.exec(t);
    if (m) return { value: val(m[1]) };
    return {};
  }

  function hunk(lines, at, removed, added) {
    const lo = Math.max(0, at - 3), hi = Math.min(lines.length, at + removed + 3);
    const before = lines.slice(lo, at), after = lines.slice(at + removed, hi);
    const old = lines.slice(at, at + removed);
    const oldN = before.length + old.length + after.length, newN = before.length + added.length + after.length;
    return [`@@ -${lo + 1},${oldN} +${lo + 1},${newN} @@`, ...before.map(l => " " + l), ...old.map(l => "-" + l), ...added.map(l => "+" + l), ...after.map(l => " " + l)]
      .filter((l, i, arr) => !(i === arr.length - 1 && l === " "));
  }

  /* what Claude would do with the request, done with a small parser: returns ready, question or nothing */
  function planEdit(op, reply) {
    const E = op.edit = op.edit || {}, file = op.info.file, fmt = op.info.format, text = op.info.text;
    const req = parseRequest(reply == null ? op.text : reply);
    if (reply != null) {
      if (E.pending === "add" && /^\s*(y|yes|ok|okay|sure|add|go|please|do it)\b/i.test(reply)) E.addOk = true;
      else if (E.pending === "add" && /^\s*(n|no|cancel|don't|do not)\b/i.test(reply)) return { status: "nothing", summary: `Nothing changed: ${E.key} was not added.` };
      if (E.pending === "which" && E.cands) {
        const want = String(reply).toLowerCase();
        const hit = E.cands.find(c => want.includes(c.path.toLowerCase())) || E.cands.find(c => want.includes(c.path.split(".").slice(-2).join(".").toLowerCase()));
        if (hit) E.key = hit.path;
      }
      if (req.key && E.pending !== "add") E.key = req.key;
      if (req.value != null && E.pending !== "add") E.value = req.value;
      else if (E.pending === "value" && !req.key) E.value = (/([^\s"'`]+)["'`]?\s*\.?\s*$/.exec(String(reply)) || [, String(reply).trim()])[1].replace(/[.,;]$/, "");
    } else {
      Object.assign(E, { key: req.key, value: req.value, copy: !!req.copy, add: !!req.add });
    }
    E.pending = "";
    const all = leaves(text, fmt);
    if (!E.key) {
      E.pending = "key";
      const some = all.slice(0, 40).map(l => l.path);
      return { status: "question", question: `Which key should change? ${file} has ${all.length} values, for example ${some.filter((_, i) => i % 5 === 1).slice(0, 4).join(", ")}. Name the key and the new value, like "Set ${some[2] || "key"} to ...".` };
    }
    if (E.copy && E.value == null) {
      const lk = Object.keys(LOCAL_CONFIG).find(k => k === E.key || k.endsWith("." + E.key));
      if (lk) { E.value = LOCAL_CONFIG[lk]; E.fromLocal = lk; }
      else return { status: "nothing", summary: `The local config folder has no key matching ${E.key}, so there is nothing to copy.` };
    }
    let cands = all.filter(l => l.path === E.key);
    if (!cands.length) cands = all.filter(l => l.path.endsWith("." + E.key) || l.key === E.key);
    if (!cands.length) cands = all.filter(l => l.path.endsWith(E.key.split(".").slice(-2).join(".")));
    if (cands.length > 1) {
      E.pending = "which"; E.cands = cands;
      return { status: "question", question: `${E.key} matches ${cands.length} keys: ${cands.map(c => `${c.path} (line ${c.i + 1}, now ${c.value})`).join(", ")}. Which one should change?` };
    }
    if (E.value == null) {
      E.pending = "value";
      return { status: "question", question: cands.length ? `${cands[0].path} is ${cands[0].value} now (line ${cands[0].i + 1}). What should the new value be?` : `What value should ${E.key} have?` };
    }
    const lines = text.replace(/\n$/, "").split("\n");
    if (!cands.length) {
      const parent = E.key.includes(".") ? E.key.split(".").slice(0, -1).join(".") : "";
      const sec = fmt === "properties" ? null : sections(text).find(s => s.path === parent);
      if (fmt !== "properties" && !sec) {
        const near = all.filter(l => l.key.includes(E.key.split(".").pop().split("-")[0])).slice(0, 3).map(l => l.path);
        E.pending = "key";
        return { status: "question", question: `${file} has no key ${E.key}${near.length ? `. The closest are ${near.join(", ")}` : ""}. Which key did you mean?` };
      }
      if (!E.addOk) {
        E.pending = "add";
        return { status: "question", question: fmt === "properties" ? `${E.key} is not in ${file}. Add it as a new line at the end of the file, set to ${E.value}?`
          : `${E.key} is not in ${file}. Add it under ${parent} (line ${sec.i + 1}), set to ${E.value}? Nothing else changes.` };
      }
      const leaf = E.key.split(".").pop();
      let at, line;
      if (fmt === "properties") { at = lines.length; line = `${E.key}=${E.value}`; }
      else {
        const ind = " ".repeat(sec.ind + 2);
        at = sec.i + 1;
        while (at < lines.length && (lines[at].startsWith(ind) || !lines[at].trim())) at++;
        line = `${ind}${leaf}: ${E.value}`;
      }
      const diff = hunk(lines, at, 0, [line]);
      lines.splice(at, 0, line);
      return { status: "ready", key: leaf, newText: lines.join("\n") + "\n", diff, summary: `Adds ${E.key}: ${E.value} to ${file}.`,
               notes: [`${E.key} was added; it was not in the file before.`], paths: [`+ ${fmt === "yaml" ? "doc 0: " : ""}${E.key}: (absent) -> ${E.value}`], steps: [["find", E.key], ["say", `${E.key} is not in the file; adding it under ${parent || "the end of the file"}.`]] };
    }
    const c = cands[0], strip = v => String(v).replace(/^["']|["']$/g, "");
    if (strip(c.value) === strip(E.value)) return { status: "nothing", summary: `${c.path} is already ${c.value} in ${file}; nothing to change.`, steps: [["find", c.key]] };
    const commented = fmt === "properties" ? `#${lines[c.i]}` : `${c.indent}#${lines[c.i].slice(c.indent.length)}`;
    const fresh = fmt === "properties" ? `${c.key}=${E.value}` : `${c.indent}${c.key}: ${E.value}`;
    const diff = hunk(lines, c.i, 1, [commented, fresh]);
    lines.splice(c.i, 1, commented, fresh);
    const notes = [];
    if (E.fromLocal) notes.push(`The value comes from ${E.fromLocal} in your local config folder.`);
    if (/gateway|url/i.test(c.path) && /live|prod/i.test(E.value)) notes.push("This points at a non-sandbox URL; the project instructions say UAT must use the payments sandbox only.");
    return { status: "ready", key: c.key, newText: lines.join("\n") + "\n", diff, notes,
             summary: `Changes ${c.path} from ${c.value} to ${E.value} in ${file}.`, paths: [`~ ${fmt === "yaml" ? "doc 0: " : ""}${c.path}: ${strip(c.value)} -> ${strip(E.value)}`],
             steps: [["find", c.key], ["say", `${c.path} is on line ${c.i + 1}, set to ${c.value}. Commenting that line out and adding the new value below it.`]] };
  }

  function configRoute(t, a, c, gitName) {
    const served = c.served_by || "", others = (c.restart || []).filter(x => x !== served);
    const nameOf = id => (t.apps.find(x => x.id === id) || {}).name || id;
    const rs = (id, prefix) => { const x = t.apps.find(y => y.id === id) || {}; return [
      { key: prefix + "stop", zone: "change", label: `Stop ${nameOf(id)}`, what: x.stop || "" },
      { key: prefix + "start", zone: "change", label: `Start ${nameOf(id)}`, what: x.start || "" },
      { key: prefix + "ready", zone: "read", label: `Wait until ${nameOf(id)} is ready`, what: x.id ? readyText(t, x) : "" }]; };
    let out = [{ key: "request", zone: "local", label: "Describe the change", what: "" },
               { key: "pull", zone: "read", label: "Download the file from UAT", what: c.path || "" },
               { key: "edit", zone: "local", label: "Prepare the edit", what: "Claude finds the key and edits the local copy" },
               { key: "diff", zone: "local", label: "Check the edit", what: "syntax, duplicate keys, the exact diff" },
               { key: "gate", zone: "gate", label: "Your approval", what: "" }];
    out = out.concat(c.git_repo ? [{ key: "upload", zone: "change", label: "Upload the file", what: c.path }, { key: "commit", zone: "change", label: `Commit as ${gitName || "you"}`, what: c.git_repo }]
      : [{ key: "backup", zone: "change", label: "Back up the file", what: `${c.path}.bak-<time>` }, { key: "upload", zone: "change", label: "Upload the file", what: c.path }]);
    if (served) out = out.concat(rs(served, "sv-"));
    if (c.verify_url && configFormat(c) === "yaml") out.push({ key: "verify", zone: "read", label: "Confirm the new values are served", what: c.verify_url });
    if (others.length) { out.push({ key: "gate2", zone: "gate", label: "Restart now or later", what: "" }); others.forEach((x, i) => { out = out.concat(rs(x, `r${i}-`)); }); }
    return { route: out, nameOf };
  }

  function startConfig(body) {
    const { t, tid } = cur(), a = findApp(t, body.app), v = { ...appView(t, tid, a), tid };
    const c = (a.configs || []).find(x => x.id === body.cfg);
    if (!c) throw new ApiError(404, "This app has no such config file.");
    const text = body.text;
    if (typeof text !== "string" || !text.trim() || text.length > 2000) throw new ApiError(400, "Describe what should change.");
    if (c.git_repo && !(W.git.name && W.git.email)) throw new ApiError(409, "Config commits need your git name and email. Set them under Templates, This machine.");
    const { route, nameOf } = configRoute(t, a, c, W.git.name);
    const op = new Op("config", v.id, v, route);
    op.cfg = c.id; op.text = text.split(/\s+/).join(" ");
    const served = c.served_by || "";
    const others = (c.restart || []).filter(x => x !== served);
    op.info = { path: c.path, format: configFormat(c), git: !!c.git_repo, gitRepo: c.git_repo || "", gitName: W.git.name, served, servedName: served ? nameOf(served) : "",
                verify: !!c.verify_url && configFormat(c) === "yaml", others, otherNames: others.map(nameOf), file: basename(c.path), verifyUrl: c.verify_url || "" };
    claim(v.id, "", op);
    guarded(op, configPrepare, v, true);
    return { op: op.id };
  }

  async function configPrepare(op, v, first) {
    const info = op.info, copy = `~/.cache/uat-deploy/templates/${v.tid}/${op.app}/config-${op.cfg}/${info.file}`;
    if (first) {
      op.mark("request", "done", op.text.slice(0, 300));
      op.mark("pull", "running");
      await pause(op, 1400);
      const f = cfgFile(op.app, { id: op.cfg, path: info.path, format: info.format, git_repo: info.gitRepo });
      info.text = f.text; info.head = f.head;
      op.mark("pull", "done", `${info.file}, ${info.format}${f.head ? `, last commit ${f.head}` : ""}`);
    }
    op.mark("edit", "running", "");
    await pause(op, 900);
    const res = planEdit(op, first ? null : op.reply);
    for (const [kind, x] of res.steps || [["find", (op.edit && op.edit.key) || ""]]) {
      if (kind === "find") op.say("edit", info.format === "yaml" ? `$ uat yaml-find ${copy} ${x}` : `$ Read ${copy}`, true);
      else op.say("edit", x);
      await pause(op, 1100);
    }
    if (res.status === "question") {
      op.state = "asking"; op.question = res.question;
      op.mark("edit", "running", "Claude needs an answer");
      return;
    }
    if (res.status === "nothing") {
      op.mark("edit", "done", res.summary);
      for (const s of op.stations) if (s.status === "pending") s.status = "skipped";
      op.result = { nothing: res.summary };
      return finish(op, "done");
    }
    op.say("edit", `$ Edit ${copy}`, true);
    await pause(op, 900);
    op.say("edit", `$ uat config-diff ${op.app} ${op.cfg}`, true);
    await pause(op, 800);
    op.mark("edit", "done", res.summary);
    op.mark("diff", "running");
    await pause(op, 900);
    op.mark("diff", "done", `${res.paths.length} value(s) change, syntax ok`);
    info.newText = res.newText;
    op.plan = { app: op.app, label: op.label, target: op.target, server: v.server, path: info.path, format: info.format, summary: res.summary, notes: res.notes || [],
                diff: res.diff, paths: res.paths, git: info.git, gitName: info.gitName, message: `${op.label} config: update ${res.key}`, served: info.servedName,
                verify: info.verify, others: info.otherNames, digest: hex(16) };
    op.state = "awaiting"; op.question = "";
    op.mark("gate", "running");
  }

  function configReply(body) {
    const op = OPS.get(body.op), text = body.text;
    if (!op || op.kind !== "config") throw new ApiError(404, "That operation is no longer here.");
    if (typeof text !== "string" || !text.trim()) throw new ApiError(400, "Type a reply.");
    if (op.phase !== "prepare" || !["asking", "awaiting"].includes(op.state)) throw new ApiError(409, "The edit can no longer be changed.");
    const { t, tid } = cur(), v = { ...appView(t, tid, findApp(t, op.app)), tid };
    op.reply = text.split(/\s+/).join(" ");
    if (op.state === "awaiting") { op.edit = {}; op.text = op.reply; op.reply = null; }
    Object.assign(op, { state: "running", plan: null, question: "" });
    for (const k of ["diff", "gate"]) Object.assign(op.st(k), { status: "pending", note: "", t0: null, t1: null });
    op.say("edit", "> " + text.split(/\s+/).join(" "));
    guarded(op, configPrepare, v, false);
    return { ok: true };
  }

  async function configChange(op, v) {
    op.phase = "change";
    const info = op.info, f = cfgFile(op.app, { id: op.cfg, path: info.path, format: info.format, git_repo: info.gitRepo });
    op.mark("gate", "done", "approved");
    const stamp = stampOf(new Date()), commit = hex(7);
    if (info.git) {
      await runSteps(op, [{ key: "upload", lines: [[1300, "uploaded, checksum matches"]] }, { key: "commit", lines: [[900, `COMMIT=${commit} ${op.plan.message}`]] }]);
      op.mark("commit", "done", `${commit} ${op.plan.message}`);
      audit(op.app, "upload config", `scp ~/.cache/uat-deploy/templates/${v.tid}/${op.app}/config-${op.cfg}/${info.file} -> ${info.path}`, 0);
      audit(op.app, "commit config", `cd ${info.gitRepo} && git add -- ${info.path.slice(info.gitRepo.length + 1)} && git -c user.name='${info.gitName}' -c user.email=**** commit -q -m '${op.plan.message}'`, 0);
      op.result.commit = `${commit} ${op.plan.message}`;
      op.facts = [["File", `uploaded and committed (${commit} ${op.plan.message})`]];
    } else {
      await runSteps(op, [{ key: "backup", lines: [[800, `backup: ${info.file}.bak-${stamp}`]] }, { key: "upload", lines: [[1200, "uploaded, checksum matches"]] }]);
      op.mark("upload", "done", "uploaded, checksum matches");
      audit(op.app, "back up config", `cp -p ${info.path} ${info.path}.bak-${stamp}`, 0);
      audit(op.app, "upload config", `scp ~/.cache/uat-deploy/templates/${v.tid}/${op.app}/config-${op.cfg}/${info.file} -> ${info.path}`, 0);
      op.facts = [["File", "uploaded"]];
      info.backup = `${info.file}.bak-${stamp}`;
    }
    info.prevText = f.text; info.prevHead = f.head;
    f.text = info.newText; if (info.git) f.head = `${commit} ${op.plan.message}`;
    save();
    op.canRevert = true;
    if (info.served) {
      if (!(await restartPart(op, info.served, "sv-"))) return;
      op.restarted.push(info.served);
    }
    if (info.verify) {
      op.mark("verify", "running");
      await pause(op, 1100);
      const ok = op.plan.paths.map(p => p.replace(/^[~+] /, "").replace(/: ([^:]*) -> (.*)$/, " = $2"));
      for (const l of ok) { op.say("verify", `OK    ${l}`); await pause(op, 250); }
      op.say("verify", "SERVED=yes");
      op.mark("verify", "done", `${ok.length} value(s) served as edited`);
      op.result.served = `yes, ${ok.length} value(s) match`;
    }
    if (info.others.length) {
      op.plan2 = { apps: info.otherNames };
      op.state = "awaiting";
      op.mark("gate2", "running");
      return;
    }
    configResult(op, { restarted: op.restarted.map(x => nameOfOp(op, x)) });
    op.facts = [];
    finish(op, "done");
  }
  const nameOfOp = (op, id) => id === op.info.served ? op.info.servedName || id : op.info.others.includes(id) ? op.info.otherNames[op.info.others.indexOf(id)] : id;
  function configResult(op, extra) {
    const p = op.plan || {};
    Object.assign(op.result, { summary: p.summary, path: p.path, total: fmtSpan(Date.now() - op.started), ...extra });
  }

  function configRestart(body) {
    const op = OPS.get(body.op);
    if (!op || op.kind !== "config") throw new ApiError(404, "That operation is no longer here.");
    if (op.state !== "awaiting" || !op.plan2) throw new ApiError(409, "There is nothing to decide here any more.");
    op.plan2 = null;
    if (body.go !== true) {
      op.mark("gate2", "done", "not now");
      for (const s of op.stations) if (s.status === "pending") s.status = "skipped";
      configResult(op, { restarted: op.restarted.map(x => nameOfOp(op, x)), notRestarted: op.info.otherNames });
      op.facts = [];
      finish(op, "done");
      return { ok: true };
    }
    op.state = "running";
    audit(op.app, "approved on the console page", `restart after config change: ${op.info.others.join(", ")}`, null);
    guarded(op, async o => {
      o.mark("gate2", "done", "restart now");
      for (const [i, x] of o.info.others.entries()) { if (!(await restartPart(o, x, `r${i}-`))) return; o.restarted.push(x); }
      configResult(o, { restarted: o.restarted.map(x => nameOfOp(o, x)) });
      o.facts = [];
      finish(o, "done");
    });
    return { ok: true };
  }

  function startConfigRevert(body) {
    const src = OPS.get(body.op);
    if (!src || src.kind !== "config" || !src.canRevert || src.reverted || !["failed", "done"].includes(src.state)) throw new ApiError(409, "There is nothing to revert here.");
    const { t, tid } = cur(), a = findApp(t, src.app), v = { ...appView(t, tid, a), tid }, info = src.info;
    const again = src.restarted.filter(x => x !== info.served);
    const nameOf = id => (t.apps.find(x => x.id === id) || {}).name || id;
    const rs = (id, prefix) => { const x = t.apps.find(y => y.id === id) || {}; return [
      { key: prefix + "stop", zone: "change", label: `Stop ${nameOf(id)}`, what: x.stop || "" },
      { key: prefix + "start", zone: "change", label: `Start ${nameOf(id)}`, what: x.start || "" },
      { key: prefix + "ready", zone: "read", label: `Wait until ${nameOf(id)} is ready`, what: x.id ? readyText(t, x) : "" }]; };
    let route = [{ key: "gate", zone: "gate", label: "Your approval", what: "" },
                 { key: "revert", zone: "change", label: "Revert the change", what: info.git ? `git revert ${(src.result.commit || "").split(" ")[0]}` : "restore the backup made before the upload" }];
    if (info.served) route = route.concat(rs(info.served, "sv-"));
    again.forEach((x, i) => { route = route.concat(rs(x, `r${i}-`)); });
    const op = new Op("config-revert", v.id, v, route);
    Object.assign(op, { cfg: src.cfg, text: src.text, info: { ...info, others: again, otherNames: again.map(nameOf) }, source: src });
    claim(v.id, "", op);
    op.plan = { app: op.app, label: op.label, target: op.target, server: v.server, path: info.path, git: info.git, undo: (src.plan || {}).summary || src.text,
                commit: src.result.commit || "", served: info.servedName, others: op.info.otherNames, message: "", digest: hex(16) };
    op.state = "awaiting";
    op.mark("gate", "running");
    return { op: op.id };
  }

  async function configRevertRun(op) {
    op.phase = "change";
    op.mark("gate", "done", "approved");
    const info = op.info, src = op.source, f = cfgFile(op.app, { id: op.cfg, path: info.path, format: info.format, git_repo: info.gitRepo });
    op.mark("revert", "running");
    await pause(op, 1300);
    const restart = [info.served, ...info.others].filter(Boolean).join(" ") || "the app that reads it";
    const line = info.git ? `REVERTED ${(src.result.commit || "").split(" ")[0]}. Restart: ${restart}` : `RESTORED ${info.file} from ${info.backup}. Restart: ${restart}`;
    op.say("revert", line);
    audit(op.app, info.git ? "revert config commit" : "restore config", info.git ? `cd ${info.gitRepo} && git revert --no-edit ${(src.result.commit || "").split(" ")[0]}` : `cp -p ${info.path}.bak ${info.path}`, 0);
    f.text = info.prevText; f.head = info.git ? `${hex(7)} Revert "${src.plan.message}"` : f.head;
    save();
    op.mark("revert", "done", line);
    if (info.served && !(await restartPart(op, info.served, "sv-"))) return;
    for (const [i, x] of info.others.entries()) if (!(await restartPart(op, x, `r${i}-`))) return;
    src.reverted = true;
    Object.assign(op.result, { summary: "Reverted: " + (op.plan.undo || ""), path: op.plan.path, total: fmtSpan(Date.now() - op.started) });
    finish(op, "done");
  }

  /* ---------------------------------------------------------------- logs, vitals, activity, settings */

  function appLog(q) {
    const { t } = cur(), a = findApp(t, q.get("app")), L = liveOf(a.id);
    const out = [], cls = mainClass(a), pkg = "c.e.s." + (a.id === "config" ? "config" : a.id);
    const ts = ms => { const d = new Date(ms); return `${ymd(d)} ${hms(d)}.${String(d.getMilliseconds()).padStart(3, "0")}`; };
    const line = (ms, lvl, thread, logger, msg) => out.push(`${ts(ms)} ${lvl.padStart(5)} ${L.pid || "0"} --- [${thread.padStart(15)}] ${logger.padEnd(40).slice(0, 40)} : ${msg}`);
    const start = L.brokenAt ? L.brokenAt - 16000 : L.startedAt;
    line(start, "INFO", "main", `${pkg}.${cls}`, `Starting ${cls} v${(REPOS[(a.build || {}).repo] || { version: "2.4.1" }).version.replace("-SNAPSHOT", "")} using Java 21.0.5 with PID ${L.pid}`);
    line(start + 40, "INFO", "main", `${pkg}.${cls}`, 'The following 1 profile is active: "uat"');
    if (a.port) line(start + 2900, "INFO", "main", "o.s.b.w.embedded.tomcat.TomcatWebServer", `Tomcat initialized with port ${a.port} (http)`);
    line(start + 6100, "INFO", "main", "com.zaxxer.hikari.HikariDataSource", "HikariPool-1 - Start completed.");
    if (L.brokenAt) {
      const k = brokenOf(a);
      line(start + 9800, "WARN", "main", "ConfigServletWebServerApplicationContext", `Exception encountered during context initialization - cancelling refresh attempt: org.springframework.beans.factory.BeanCreationException: Error creating bean with name '${k.bean}'`);
      line(start + 9900, "ERROR", "main", "o.s.b.d.LoggingFailureAnalysisReporter", "");
      out.push("", "***************************", "APPLICATION FAILED TO START", "***************************", "", "Description:", "",
               `Failed to bind properties under '${k.key}' to ${k.type}:`, "", `    Property: ${k.key}`, "    Value: \"\"",
               `    Reason: the new ${k.cls} requires ${k.key}, and ${cfgName(a)} does not set it`, "", "Action:", "",
               `Update your application's configuration: set ${k.key}`);
      return { lines: out, at: Date.now() };
    }
    if (a.port) line(start + 13200, "INFO", "main", "o.s.b.w.embedded.tomcat.TomcatWebServer", `Tomcat started on port ${a.port} (http) with context path '/'`);
    line(start + 13800, "INFO", "main", `${pkg}.${cls}`, `Started ${cls} in 13.84 seconds (process running for 15.2)`);
    const now = Date.now(), span = Math.min(now - start - 15000, 6 * 3600e3);
    const msgs = {
      api: [["INFO", "nio-8080-exec-3", "c.e.s.api.checkout.CheckoutController", () => `POST /v2/checkout/sessions 201 (${rnd(21, 64)} ms)`],
            ["INFO", "nio-8080-exec-7", "c.e.s.api.cart.CartController", () => `GET /v2/carts/${hex(8)} 200 (${rnd(4, 19)} ms)`],
            ["INFO", "nio-8080-exec-1", "c.e.s.api.payments.PaymentClient", () => `authorise ${hex(10)}: approved by sandbox (${rnd(180, 420)} ms)`],
            ["WARN", "nio-8080-exec-5", "c.e.s.api.payments.PaymentClient", () => `authorise ${hex(10)}: declined (insufficient_funds), retrying once`]],
      payments: [["INFO", "scheduling-1", "c.e.s.payments.SettlementJob", () => `settled batch of 25 payments in ${rnd(900, 2400)} ms`],
                 ["INFO", "worker-2", "c.e.s.payments.QueueListener", () => `payment ${hex(10)} captured`],
                 ["WARN", "worker-3", "c.e.s.payments.GatewayClient", () => "gateway timeout after 5000 ms for capture, retrying (attempt 2 of 2)"],
                 ["ERROR", "worker-3", "c.e.s.payments.GatewayClient", () => `capture ${hex(10)} failed after 2 attempts: 504 Gateway Timeout from sandbox; moved to payments-uat.dlq`]],
      admin: [["INFO", "nio-8090-exec-2", "c.e.s.admin.web.OrdersController", () => `GET /orders?page=${rnd(1, 9)} 200 (${rnd(30, 120)} ms)`],
              ["INFO", "nio-8090-exec-4", "c.e.s.admin.web.RefundsController", () => `refund ${hex(8)} approved by qa-${rnd(1, 4)}`]],
      config: [["INFO", "nio-8888-exec-1", "o.s.c.c.s.e.NativeEnvironmentRepository", () => `Adding property source: file:/opt/acme/config-repo/${pick(["storefront-api-uat.yml", "payments-worker-uat.yml"])}`]],
    }[a.id] || [["INFO", "main", `${pkg}.Worker`, () => "heartbeat ok"]];
    const n = 40;
    for (let i = 0; i < n; i++) {
      const at = start + 15000 + span * (i + 1) / (n + 1);
      const m = msgs[i % 7 === 3 && msgs.length > 2 ? 2 : i % 11 === 9 && msgs.length > 3 ? 3 : i % Math.min(2, msgs.length)];
      line(at, m[0], m[1], m[2], m[3]());
    }
    return { lines: out, at: now };
  }

  function vitals() {
    const { t } = cur(), out = {};
    const boot = daysAgo(41, 6, 12, 44);
    for (const sid of usedServers(t)) out[sid] = { ok: true, error: "", at: Date.now(), disk: { size: 53687091200, free: 20937965568, usedPct: 61 },
      mem: { total: 15990 * 2 ** 20, available: 5420 * 2 ** 20, usedPct: 66 }, load: [0.42, 0.55, 0.61], cores: 4, boot: `${ymd(boot)} ${hms(boot)}` };
    return { servers: out };
  }

  function activity() {
    const { tid } = cur();
    return { rows: W.activity.filter(r => (r.mine || "shopfront") === tid) };
  }

  function setup() {
    const { t, tid } = cur(), L = localOf(tid), out = { templates: templateList().map(x => ({ ...x, current: x.id === tid })), current: tid, git: W.git,
      repos: [], builds: [], servers: [], configDir: L.config_dir || "", engine: true, model: "sonnet", mode: W.mode };
    const seen = new Set();
    for (const a of t.apps || []) {
      const b = a.build || {};
      if (b.repo && !seen.has(b.repo)) { seen.add(b.repo); const path = L.repos[b.repo] || ""; out.repos.push({ name: b.repo, path, detect: b.detect || "", state: path ? "ok" : "not set" }); }
      if (b.command) out.builds.push({ app: a.id, name: a.name || a.id, command: b.command, override: L.builds[a.id] || "" });
    }
    for (const sid of usedServers(t)) { const s = t.servers[sid] || {}, au = W.auth[serverKey(s)] || { auth: "key", key_file: "" };
      out.servers.push({ id: sid, label: s.label || sid, target: serverKey(s), signIn: au.auth === "password" ? "password, saved" : `SSH key ${au.key_file || "(default keys or agent)"}`, ready: true }); }
    return out;
  }

  function saveSetting(body) {
    const { tid } = cur(), L = localOf(tid), key = String(body.key || ""), value = String(body.value || "").trim();
    if (key === "mode") { if (!["ui", "terminal"].includes(value)) throw new ApiError(400, "mode is ui or terminal"); W.mode = value; }
    else if (/^repo\./.test(key)) { if (value && !/^[~/]/.test(value)) throw new ApiError(400, `${value} is not a folder on this machine.`); if (value) L.repos[key.slice(5)] = value; else delete L.repos[key.slice(5)]; }
    else if (/^build\./.test(key)) { if (value) L.builds[key.slice(6)] = value; else delete L.builds[key.slice(6)]; }
    else if (key === "git.name" || key === "git.email") W.git[key.slice(4)] = value;
    else if (key === "config-dir") L.config_dir = value;
    else throw new ApiError(400, "Not a setting.");
    save();
    return setup();
  }

  /* ---------------------------------------------------------------- Ask UAT */

  function askView(q) {
    const tid = q.get("thread") || "", { tid: curT } = cur();
    const mine = W.ask.threads.filter(t => t.template === curT);
    return { threads: mine.map(t => ({ id: t.id, title: t.title, updated: t.updated || t.created, count: t.items.length, running: t.items.some(i => i.state === "running") })),
             thread: mine.find(t => t.id === tid) || null, saved: W.ask.saved, engine: true, model: "sonnet" };
  }

  const fence = s => "```\n" + s + "\n```";
  function answerFor(q, appId) {
    const { t } = cur(), text = q.toLowerCase(), app = id => t.apps.find(a => a.id === id);
    const named = t.apps.find(a => text.includes(a.name.toLowerCase())) || (appId && app(appId));
    const live = id => liveOf(id);
    const fmtUp = id => { const L = live(id); if (L.running !== "yes") return "not running"; const s = Math.round((Date.now() - L.startedAt) / 1000); return etime(s); };
    const ps = () => t.apps.map(a => `${live(a.id).pid.padStart(5)} deploy   ${fmtUp(a.id).padStart(11)}  java -jar ${live(a.id).file}`).join("\n");

    if (/^why did the (deploy|restart|rollback|config change|config revert) of/.test(text)) {
      const a = named || app("api"), L = live(a.id), k = brokenOf(a), broken = !!L.brokenAt, file = cfgName(a), c = (a.configs || [])[0];
      const leaf = k.key.split(".").pop();
      return {
        steps: [{ say: `Reading the end of the ${a.name} log to see why it did not come up.` },
                { cmd: `uat log ${a.id} 80`, out: appLog(new URLSearchParams({ app: a.id })).lines.slice(-22).join("\n"), ms: 1800 },
                { say: "Checking what the start script names and whether anything runs." },
                { cmd: `uat current ${a.id}`, out: `START_SCRIPT=${a.dir}/${startScript(a) || "start.sh"}\nACTIVE_JAR=${L.active || L.file} (line ${L.line || 12})\nRUNNING=no${a.port ? " PORT=" + a.port : ""}`, ms: 1300 },
                ...(broken && c ? [{ say: `Looking for the key in ${file} on the server.` },
                  { cmd: `uat read --server ${a.server} 'grep -n -- "${leaf}" ${c.path}'`, out: "(no output)", ok: false, ms: 1500 }] : [])],
        answer: broken
          ? `**The new build needs a config key UAT does not have yet: \`${k.key}\`.** Spring Boot stopped at startup, so ${a.port ? `nothing listens on port ${a.port} and ` : ""}${a.name} is down.\n\n${fence(["APPLICATION FAILED TO START", `Failed to bind properties under '${k.key}' to ${k.type}:`, `    Reason: the new ${k.cls} requires ${k.key}, and ${file} does not set it`].join("\n"))}\n\n${c ? `${file} on the server has no \`${leaf}\` key.` : "The template names no config file for this app."} Two ways forward:\n\n1. **Roll back** from the deploy tab: ${(a.deploy || {}).style === "jar-start-script" ? `the start script goes back to \`${L.prev || "the previous jar"}\`` : "the rollback steps put the previous release back"} and the app restarts as it was.\n2. Add \`${k.key}\` to ${file} from the Config tab, then restart ${a.name}.\n\nNot checked: whether other new keys are missing; the log stops at the first failure.`
          : `**The step failed, but the log shows no startup error.** ${a.name} is ${L.running === "yes" ? "running" : "not running"} now.\n\nNot checked: anything outside the app's log.`,
        followups: broken ? [`Which other keys does the new ${a.name} build read that ${file} lacks?`, a.port ? `Is anything else on the server using port ${a.port}?` : `Is ${a.name} running at all now?`] : [],
        actions: broken ? [...(c ? [{ kind: "config", app: a.id, label: "Add the key in Config", request: `Add ${k.key}: ${k.value}` }] : []), { kind: "log", app: a.id, label: `Open the ${a.name} log` }] : [],
      };
    }
    if (/disk|space|storage|full/.test(text)) return {
      steps: [{ say: "Checking how full the root filesystem is." }, { cmd: `uat read --server uat 'df -h /'`, out: "Filesystem      Size  Used Avail Use% Mounted on\n/dev/nvme0n1p1   50G   31G   20G  61% /", ms: 1200 },
              { say: "Measuring the app folders and the logs, largest first." },
              { cmd: `uat read --server uat 'du -xsh /opt/acme/* /var/log 2>/dev/null | sort -rh | head'`, out: "4.1G\t/opt/acme/storefront-api\n3.2G\t/opt/acme/payments-worker\n2.6G\t/opt/acme/logs\n1.9G\t/opt/acme/admin-portal\n1.1G\t/var/log\n412M\t/opt/acme/config-server\n38M\t/opt/acme/config-repo", ms: 2100 },
              { say: "Counting the old jars kept beside each app." },
              { cmd: `uat read --server uat 'find /opt/acme -maxdepth 2 -name "*.jar" -mtime +30 | wc -l'`, out: "71", ms: 1300 }],
      answer: "**The disk is 61% full: 31 GB used of 50 GB, 20 GB free.** Most of it is old builds kept beside the apps.\n\n| Folder | Size |\n|---|---|\n| /opt/acme/storefront-api | 4.1 GB |\n| /opt/acme/payments-worker | 3.2 GB |\n| /opt/acme/logs | 2.6 GB |\n| /opt/acme/admin-portal | 1.9 GB |\n| /var/log | 1.1 GB |\n\n71 jars in the app folders are older than 30 days. Each deploy leaves the previous jar in place on purpose, so a rollback never needs a rebuild.\n\nNot checked: Docker images and /tmp.",
      followups: ["Which jars older than 30 days are not named by any start script?", "How fast is /opt/acme/logs growing per day?"], actions: [] };
    if (/memory|ram|heap|oom|swap/.test(text)) return {
      steps: [{ say: "Reading the memory totals." }, { cmd: `uat read --server uat 'free -m'`, out: "               total        used        free      shared  buff/cache   available\nMem:           15990       10102         611          41        5277        5420\nSwap:              0           0           0", ms: 1100 },
              { say: "Listing the processes by resident memory." }, { cmd: `uat read --server uat 'ps -eo pid,rss,etime,args --sort=-rss | head -n 7'`, out: `  PID   RSS     ELAPSED COMMAND\n${live("api").pid} 1468212 ${fmtUp("api").padStart(11)} java -Xms512m -Xmx1g -jar ${live("api").file}\n${live("payments").pid}  934104 ${fmtUp("payments").padStart(11)} java -Xms256m -Xmx768m -jar ${live("payments").file}\n${live("admin").pid}  655360 ${fmtUp("admin").padStart(11)} java -jar current.jar\n${live("config").pid}  419840 ${fmtUp("config").padStart(11)} java -jar ${live("config").file}\n  912   88412 41-02:13:09 /usr/bin/node_exporter\n  744   20360 41-02:13:11 nginx: master process /usr/sbin/nginx`, ms: 1700 }],
      answer: `**storefront-api uses the most memory: 1.4 GB resident.** The server has 5.3 GB available of 15.6 GB, and no swap.\n\n| App | Resident | Up |\n|---|---|---|\n| storefront-api | 1.4 GB | ${fmtUp("api")} |\n| payments-worker | 912 MB | ${fmtUp("payments")} |\n| admin-portal | 640 MB | ${fmtUp("admin")} |\n| config-server | 410 MB | ${fmtUp("config")} |\n\nEach JVM stays inside the -Xmx its start script sets; storefront-api is at its 1 GB heap plus metaspace.\n\nNot checked: heap usage inside the JVMs (that needs jcmd on the server).`,
      followups: ["Has storefront-api been killed for memory (OOM) in the last week?", "What -Xmx does each start script set?"], actions: [] };
    if (/port|listen/.test(text)) return {
      steps: [{ say: "Listing the listening TCP ports and their processes." }, { cmd: `uat read --server uat 'ss -ltnpH'`, out: `LISTEN 0 511   0.0.0.0:80     0.0.0.0:* users:(("nginx",pid=744,fd=6))\nLISTEN 0 511   0.0.0.0:443    0.0.0.0:* users:(("nginx",pid=744,fd=7))\nLISTEN 0 128   0.0.0.0:22     0.0.0.0:* users:(("sshd",pid=701,fd=3))\nLISTEN 0 100         *:8080         *:* users:(("java",pid=${live("api").pid},fd=41))\nLISTEN 0 100         *:8082         *:* users:(("java",pid=${live("payments").pid},fd=38))\nLISTEN 0 100         *:8090         *:* users:(("java",pid=${live("admin").pid},fd=35))\nLISTEN 0 100         *:8888         *:* users:(("java",pid=${live("config").pid},fd=29))\nLISTEN 0 4096        *:9100         *:* users:(("node_exporter",pid=912,fd=3))`, ms: 1500 }],
      answer: `**Eight ports are listening; every app of the template is on its own port.**\n\n| Port | Process | What |\n|---|---|---|\n| 22 | sshd | ssh |\n| 80, 443 | nginx (744) | reverse proxy |\n| 8080 | java (${live("api").pid}) | storefront-api |\n| 8082 | java (${live("payments").pid}) | payments-worker |\n| 8090 | java (${live("admin").pid}) | admin-portal |\n| 8888 | java (${live("config").pid}) | config-server |\n| 9100 | node_exporter (912) | metrics |\n\nNot checked: UDP ports and the firewall rules.`,
      followups: ["Which nginx locations proxy to port 8080?", "Is port 8888 reachable from outside the server?"], actions: [] };
    if (/cpu|load/.test(text)) return {
      steps: [{ say: "Reading the load average and the busiest processes." }, { cmd: `uat read --server uat 'cat /proc/loadavg; nproc'`, out: "0.42 0.55 0.61 2/389 51822\n4", ms: 900 },
              { cmd: `uat read --server uat 'ps -eo pid,pcpu,args --sort=-pcpu | head -n 5'`, out: `  PID %CPU COMMAND\n${live("payments").pid}  6.1 java -Xms256m -Xmx768m -jar ${live("payments").file}\n${live("api").pid}  3.4 java -Xms512m -Xmx1g -jar ${live("api").file}\n  744  0.3 nginx: worker process\n  912  0.2 /usr/bin/node_exporter`, ms: 1300 }],
      answer: `**The server is mostly idle: load 0.42 on 4 cores (about 10%).** payments-worker is the busiest process at 6% CPU, from its settlement job that runs every few seconds.\n\nNot checked: CPU use over time; this is a snapshot.`,
      followups: ["How often does the payments-worker settlement job run?"], actions: [] };
    if (/restart|crash|went down|uptime|24 hours|last day/.test(text)) {
      const rows = t.apps.map(a => { const L = live(a.id), up = L.running === "yes" ? (Date.now() - L.startedAt) / 1000 : null; return { a, L, up }; });
      const recent = rows.filter(r => r.up == null || r.up < 86400);
      return {
        steps: [...t.apps.slice(0, 4).map(a => ({ cmd: `uat current ${a.id}`, out: `RUNNING=${live(a.id).running}${a.port ? " PORT=" + a.port : ""}${live(a.id).running === "yes" ? ` PID=${live(a.id).pid} UPTIME=${fmtUp(a.id)}` : ""}\nRUNNING_JAR=${live(a.id).file}`, ms: 700 })),
                { say: "Looking for crashes and out-of-memory kills in the kernel log." }, { cmd: `uat read --server uat 'journalctl -k --since -24h | grep -i -m 5 -E "oom|killed process"'`, out: "(no output)", ms: 1400 }],
        answer: `**${recent.length ? `${recent.length} app${recent.length > 1 ? "s" : ""} restarted in the last 24 hours, and nothing crashed.` : "Nothing restarted or crashed in the last 24 hours."}**\n\n| App | Running | Up for |\n|---|---|---|\n${rows.map(r => `| ${r.a.name} | ${r.L.running === "yes" ? r.L.file : "**not running**"} | ${r.up == null ? "-" : etime(Math.round(r.up))} |`).join("\n")}\n\n${recent.length ? "The restarts match the audit log under Activity (deploys and config changes made from this console)." : ""} The kernel log has no out-of-memory kills.\n\nNot checked: restarts by anything other than the start scripts.`,
        followups: ["What did the last config change on payments-worker change?"], actions: rows.filter(r => r.L.running !== "yes").slice(0, 1).map(r => ({ kind: "restart", app: r.a.id, label: `Restart ${r.a.name}` })) };
    }
    const find = /find (.+?) in every app'?s log/i.exec(q);
    if (find) {
      const term = find[1].replace(/^["'`]|["'`]$/g, "").trim(), re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const per = t.apps.map(a => ({ a, lines: appLog(new URLSearchParams({ app: a.id })).lines.filter(l => re.test(l)).slice(-4) }));
      const hits = per.filter(p => p.lines.length), merged = per.flatMap(p => p.lines.map(l => `${l.slice(0, 23)}  ${p.a.name}  ${l.slice(24).replace(/^\s*\w+\s+\d+ --- \[[^\]]*\]\s*/, "").slice(0, 150)}`)).sort();
      return {
        steps: [{ say: `Searching each app's current log for "${term}".` }, ...per.map(p => ({ cmd: `uat read --server ${p.a.server} 'grep -i -m 20 -- "${term}" ${p.a.log || p.a.dir + "/app.log"}'`, out: p.lines.join("\n") || "(no output)", ok: p.lines.length > 0, ms: 800 }))],
        answer: hits.length ? `**"${term}" appears ${merged.length} time${merged.length > 1 ? "s" : ""} in ${hits.length} of ${t.apps.length} logs: ${hits.map(p => p.a.name).join(", ")}.** The matching lines, in time order:\n\n${fence(merged.join("\n"))}\n\nNot checked: rotated logs (*.log.1, *.gz).`
          : `**"${term}" is not in any app's current log.** All ${t.apps.length} logs were searched.\n\nNot checked: rotated logs (*.log.1, *.gz).`,
        followups: hits.length ? [`When did "${term}" first appear in the ${hits[0].a.name} log?`] : [], actions: hits.slice(0, 2).map(p => ({ kind: "log", app: p.a.id, label: `Open the ${p.a.name} log` })) };
    }
    if (/what (is )?running|which version|what runs|deployed/.test(text)) return {
      steps: t.apps.map(a => ({ cmd: `uat current ${a.id}`, out: `ACTIVE_JAR=${live(a.id).active || live(a.id).file}\nRUNNING=${live(a.id).running}${live(a.id).running === "yes" ? ` PID=${live(a.id).pid} UPTIME=${fmtUp(a.id)}` : ""}`, ms: 700 })),
      answer: `**All ${t.apps.length} apps are listed below with the file each one runs.**\n\n| App | File | Up for |\n|---|---|---|\n${t.apps.map(a => `| ${a.name} | ${live(a.id).file} | ${live(a.id).running === "yes" ? fmtUp(a.id) : "not running"} |`).join("\n")}`, followups: ["Did anything restart or crash in the last 24 hours?"], actions: [] };
    if (/error|exception|warn|fail|log/.test(text)) {
      const a = named || app("payments"), L = live(a.id);
      const logLines = appLog(new URLSearchParams({ app: a.id })).lines;
      const compact = l => l.replace(/^(\S+ \S+)\s+(\w+) \d+ --- \[\s*([^\]]+)\] \S+\s+: /, "$1 $2 [$3] ");
      const errs = logLines.filter(l => / ERROR /.test(l)), warns = logLines.filter(l => / WARN /.test(l));
      const bad = [...errs.slice(-1), ...warns.slice(-2)].sort().map(compact);
      const isPay = a.id === "payments";
      return {
        steps: [{ say: `Reading the last 500 lines of the ${a.name} log.` }, { cmd: `uat log ${a.id} 500`, out: logLines.slice(-14).join("\n"), ms: 1700 },
                { say: "Counting errors and warnings since the last start." }, { cmd: `uat read --server uat 'grep -c -E " (ERROR|WARN) " ${a.log}'`, out: String(errs.length + warns.length), ms: 1000 }],
        answer: bad.length
          ? `**${isPay ? "Captures time out against the payments sandbox: the gateway answers 504 after 5 s, and payments that fail twice go to the dead-letter queue." : `${bad.length} warnings since the last start, no errors that stop the app.`}**\n\n${fence(bad.join("\n"))}\n\n${isPay ? "The worker gives the gateway `gateway.timeout: 5s` with `max-attempts: 2` (payments-worker-uat.yml). The sandbox is slow at the moment, so a longer timeout would let most captures succeed." : "These are declined test cards being retried, which is expected in UAT."}\n\nNot checked: the sandbox's own status page.`
          : `**No errors or warnings in the last 500 lines of the ${a.name} log.**`,
        followups: isPay ? ["How many payments are in the dead-letter queue?", "When did the 504s from the sandbox start?"] : [],
        actions: isPay ? [{ kind: "config", app: "payments", label: "Raise gateway.timeout in Config", request: "Set gateway.timeout to 10s" }, { kind: "log", app: "payments", label: "Open the payments-worker log" }] : [{ kind: "log", app: a.id, label: `Open the ${a.name} log` }],
      };
    }
    return {
      steps: [{ say: "This is the live demo: Claude Code is not connected here, so only a few questions have recorded answers." }, { cmd: "uat apps", out: t.apps.map(a => `${a.id.padEnd(14)} ${a.name.padEnd(24)} server: ${a.server}  deploy: ${(a.deploy || {}).style || "none"}`).join("\n"), ms: 900 }],
      answer: "**This demo answers a handful of recorded questions, so it has no answer for this one.**\n\nIn the real console, Claude Code answers any read-only question about the UAT server: it runs allow-listed commands through the `uat` helper (logs, disk, memory, processes, ports, nginx), shows each command with its output, and cannot change anything.\n\nTry one of these instead, or the saved questions on the left:",
      followups: ["What is using the disk, largest first?", "What are the latest errors in the payments-worker log?", "Did anything restart or crash in the last 24 hours?"], actions: [] };
  }

  function askStart(body) {
    const text = body.text, appId = body.app || "";
    if (typeof text !== "string" || !text.trim()) throw new ApiError(400, "Type a question.");
    const { tid } = cur();
    if (W.ask.threads.some(t => t.items.some(i => i.state === "running"))) throw new ApiError(409, "Claude is still answering another question. Wait for it, or stop it.");
    let thread = W.ask.threads.find(t => t.id === body.thread && t.template === tid);
    if (!thread) thread = { id: hex(8), title: text.trim().split("\n")[0].slice(0, 90), template: tid, session: "demo", created: Date.now(), items: [] };
    else W.ask.threads.splice(W.ask.threads.indexOf(thread), 1);
    W.ask.threads.unshift(thread);
    W.ask.threads.length = Math.min(W.ask.threads.length, 30);
    const item = { id: thread.items.length + 1, q: text.trim(), app: appId, at: Date.now(), state: "running", steps: [], answer: "", followups: [], actions: [], error: "", ended: null };
    thread.items.push(item); thread.updated = Date.now();
    save();
    (async () => {
      const plan = answerFor(item.q, appId);
      await sleep(1100);
      for (const s of plan.steps) {
        if (item.state !== "running") return;
        if (s.say) { item.steps.push({ say: s.say, at: Date.now() }); await sleep(900); continue; }
        const st = { ref: hex(8), cmd: s.cmd, out: null, ok: true, at: Date.now(), took: null };
        item.steps.push(st); save();
        await sleep(s.ms || 1000);
        if (item.state !== "running") return;
        Object.assign(st, { out: s.out, ok: s.ok !== false, took: Date.now() - st.at });
        save();
      }
      await sleep(1300);
      if (item.state !== "running") return;
      while (item.steps.length && "say" in item.steps[item.steps.length - 1]) item.steps.pop();
      Object.assign(item, { answer: plan.answer, followups: plan.followups || [], actions: plan.actions || [], state: "done", ended: Date.now() });
      thread.updated = Date.now();
      save();
    })();
    return { thread: thread.id };
  }

  /* ---------------------------------------------------------------- configurator (scripts/uat-ui) */

  const tplRec = id => { if (!ID_RE.test(id || "")) throw new ApiError(400, "That is not a template id."); const r = W.templates[id]; if (!r) throw new ApiError(404, `There is no template '${id}'.`); return r; };
  const authView = t => Object.fromEntries(Object.values(t.servers || {}).filter(s => s && s.host && s.user).map(s => [serverKey(s), W.auth[serverKey(s)] || { auth: "key", key_file: "", password_saved: false }]));
  const localView = tid => { const L = localOf(tid); return { repos: L.repos, builds: L.builds, config_dir: L.config_dir || "" }; };

  function bootstrap() {
    return { templates: templateList(), current: W.current, git: W.git, ssh_keys: ["~/.ssh/id_ed25519", "~/.ssh/id_rsa"], templates_dir: "~/.claude/skills/uat-deploy/templates",
             in_git: true, placeholders: FX.placeholders, spring_ready: FX.spring_ready, styles: FX.styles, formats: FX.formats, default_timeouts: FX.default_timeouts, home: "/home/you" };
  }
  function getTemplate(q) {
    const id = q.get("id"), r = tplRec(id), t = normalize(r.t);
    return { template: t, file_text: r.text, file: `~/.claude/skills/uat-deploy/templates/${id}.yml`, local: localView(id), auth: authView(t) };
  }
  function preview(body) {
    if (!body.template || typeof body.template !== "object") throw new ApiError(400, "Send the template.");
    const t = normalize(body.template), original = body.original_id || null;
    const [errors, warnings] = validate(t, original);
    if (!original && ID_RE.test(t.id || "") && W.templates[t.id]) errors.unshift({ path: ["id"], label: "id", message: `a template '${t.id}' already exists; pick another id` });
    return { yaml: render(t), errors, warnings, auth: authView(t) };
  }
  function saveTemplate(body) {
    const t = normalize(body.template || {}), original = body.original_id || null, res = preview(body);
    if (res.errors.length) throw new ApiError(400, `Fix ${res.errors.length} problem(s) before saving.`, { errors: res.errors });
    if (original && t.id !== original) throw new ApiError(400, "A template's id cannot change after it is saved.");
    const existed = !!W.templates[t.id];
    W.templates[t.id] = { t, text: res.yaml, modified: Date.now() };
    const d = new Date();
    W.activity.unshift({ time: `${ymd(d)} ${hms(d)}`, user: "demo", app: "", action: "settings", detail: `template ${t.id} ${existed ? "updated" : "created"} from the configurator`, exit: null, mine: t.id });
    save();
    return { id: t.id, file: `~/.claude/skills/uat-deploy/templates/${t.id}.yml`, yaml: res.yaml, git: existed ? `M templates/${t.id}.yml` : `?? templates/${t.id}.yml`, templates: templateList() };
  }
  function saveLocal(body) {
    const tid = body.template_id;
    if (!ID_RE.test(tid || "")) throw new ApiError(400, "That is not a template id.");
    const L = localOf(tid), kind = body.kind, name = String(body.name || ""), value = String(body.value || "").trim();
    if (kind === "repo") { if (!ID_RE.test(name)) throw new ApiError(400, "Name the repo in the build section first."); if (value && !/^[~/]/.test(value)) throw new ApiError(400, `${value} is not a folder on this machine.`); if (value) L.repos[name] = value; else delete L.repos[name]; }
    else if (kind === "build") { if (value) L.builds[name] = value; else delete L.builds[name]; }
    else if (kind === "config_dir") L.config_dir = value;
    else if (kind === "git") W.git[name] = value;
    else throw new ApiError(400, "Unknown setting.");
    save();
    return { ok: true, hint: "", local: localView(tid) };
  }
  function saveAuth(body) {
    const host = String(body.host || ""), user = String(body.user || "");
    if (!HOST_RE.test(host) || !USER_RE.test(user)) throw new ApiError(400, "Fill in the server's host and user first.");
    const key = `${user}@${host}`;
    if (body.auth === "key") W.auth[key] = { auth: "key", key_file: String(body.key_file || ""), password_saved: false };
    else if (body.auth === "password") { if (!body.password && !(W.auth[key] || {}).password_saved) throw new ApiError(400, "Type the password to save it."); W.auth[key] = { auth: "password", key_file: "", password_saved: true }; }
    else throw new ApiError(400, "Choose an SSH key or a password.");
    save();
    return { key, auth: W.auth[key] };
  }
  const KNOWN = new Set();
  for (const a of FX.template.apps) {
    KNOWN.add(a.dir); if (a.log) KNOWN.add(dirname(a.log));
    for (const c of [a.start, a.stop]) if (scriptOf(c)) KNOWN.add(`${a.dir}/${scriptOf(c)}`);
    if ((a.deploy || {}).upload_dir) KNOWN.add(a.deploy.upload_dir);
    for (const c of a.configs || []) { KNOWN.add(c.path); if (c.git_repo) KNOWN.add(c.git_repo); }
  }
  async function check(body) {
    const t = normalize(body.template || {});
    await sleep(2200);
    const groups = [];
    for (const sid of usedServers(t)) {
      const s = (t.servers || {})[sid] || {}, g = { server: sid, target: serverKey(s), items: [] };
      for (const a of t.apps || []) {
        if (a.server !== sid) continue;
        const d = String(a.dir || "").replace(/\/$/, ""), items = [["dir", d]];
        for (const c of [a.start, a.stop]) if (scriptOf(c)) items.push(["exec", `${d}/${scriptOf(c)}`]);
        if ((a.deploy || {}).style === "custom" && a.deploy.upload_dir) items.push(["dir", a.deploy.upload_dir]);
        if (a.log) items.push(["logdir", dirname(a.log)]);
        for (const c of a.configs || []) { if (c.git_repo) items.push(["gitrepo", c.git_repo]); if (c.path) items.push(["file", c.path]); }
        const seen = new Set();
        for (const [kind, p] of items) {
          if (!p || seen.has(kind + p)) continue;
          seen.add(kind + p);
          const ok = KNOWN.has(p) || (s.host !== "203.0.113.10");
          const what = { dir: "folder", exec: "script", logdir: "log folder", gitrepo: "git repo", file: "file" }[kind];
          g.items.push({ status: ok ? "PASS" : "FAIL", app: a.id, text: ok ? `${what} ${p}` : kind === "exec" ? `script ${p} is missing` : kind === "gitrepo" ? `${p} is not a git repo` : `${what} ${p} is missing` });
        }
      }
      groups.push(g);
    }
    return { ok: !groups.some(g => g.items.some(i => i.status === "FAIL")), groups, error: "" };
  }
  async function detect(body) {
    const d = String(body.dir || "").replace(/\/$/, "");
    if (!ID_RE.test(body.server || "")) throw new ApiError(400, "Pick the app's server first.");
    if (!PATH_RE.test(d)) throw new ApiError(400, "Enter the app's folder as an absolute path first.");
    await sleep(1600);
    const known = FX.template.apps.find(a => a.dir === d), L = known ? liveOf(known.id) : null;
    const base = basename(d), port = known ? known.port : 8095 + (hashStr(d).charCodeAt(0) % 5);
    const jar = known ? (L.active || L.file) : `${base}-1.4.2.jar`;
    const start = known ? (scriptOf(known.start) || "start.sh") : "start.sh";
    const log = known ? known.log : `/opt/${base}/logs/${base}.log`;
    const scripts = [
      { name: start, exec: true, jars: known && (known.deploy || {}).style === "custom" ? [{ line: 5, jar: "current.jar" }] : [{ line: known ? +(L.line || 12) : 12, jar }], logs: [{ path: log, append: known?.id !== "api" }], ports: [port], multiline: known?.id === "payments", stops: false, starts: true },
      { name: "stop.sh", exec: true, jars: [], logs: [], ports: [port], multiline: false, stops: true, starts: false },
    ];
    if (known?.id === "api" || !known) scripts.push({ name: "restart.sh", exec: false, jars: [], logs: [], ports: [], multiline: false, stops: true, starts: true });
    return { dir: d, missing: false, scripts, artifacts: known ? [jar, L.prev || `${base}-old.jar`].filter(Boolean) : [jar, `${base}-1.4.1.jar`],
             procs: [{ pid: known ? L.pid : String(rnd(30000, 49999)), uptime: known ? etime(Math.round((Date.now() - L.startedAt) / 1000)) : "3-07:21:55", args: `java -jar ${jar}`, ports: [port], jar }] };
  }
  async function ping(body) {
    const t = normalize(body.template || {}), s = (t.servers || {})[body.server] || {};
    if (!ID_RE.test(body.server || "")) throw new ApiError(400, "Give the server an id first.");
    await sleep(1200);
    return { ok: true, text: `connected as ${s.user || "deploy"}@${(s.aliases || [])[0] || body.server}; openjdk version "21.0.5" 2024-10-15; git 2.34.1; login shell: ok` };
  }

  /* ---------------------------------------------------------------- routing */

  async function opView(q) {
    const op = OPS.get(q.get("id"));
    if (!op) throw new ApiError(404, "That operation is no longer here.");
    const since = +q.get("since") || 0, seen = q.get("v") || "", deadline = Date.now() + 20000;
    while (op.stamp() === seen && Date.now() < deadline) {
      await new Promise(r => { const tm = setTimeout(r, Math.max(0, deadline - Date.now())); op.waiters.push(() => { clearTimeout(tm); r(); }); });
    }
    const out = op.view(since);
    out.v = op.stamp();
    return out;
  }

  const prefs = (method, body) => {
    if (method === "POST") { W.theme = ["light", "dark"].includes(body.theme) ? body.theme : ""; save(); return { ok: true }; }
    return { theme: W.theme || "light" };
  };

  const CONSOLE_GET = {
    "/api/state": state, "/api/overview": overview, "/api/log": appLog, "/api/activity": activity, "/api/op": opView,
    "/api/ask": askView, "/api/setup": setup, "/api/vitals": vitals, "/api/wait": () => ({ items: [], closed: "", pid: 1 }),
  };
  const CONSOLE_POST = {
    "/api/deploy": startDeploy, "/api/approve": approveAny, "/api/cancel": cancel,
    "/api/dismiss": b => { const op = OPS.get(b.op); if (op && ["done", "failed", "cancelled"].includes(op.state)) op.dismissed = true; return { ok: true }; },
    "/api/restart": b => startSimple(b, "restart"), "/api/rollback": b => startSimple(b, "rollback"),
    "/api/use": b => { if (!W.templates[b.id]) throw new ApiError(404, "There is no such template."); if (Object.keys(busyApps).length) throw new ApiError(409, "Wait for the running operation to finish before switching the project."); W.current = b.id; save(); return state(); },
    "/api/done": () => { throw new ApiError(409, "This is the live demo, so the console stays open. In the real skill, this button stops the local server and closes the page."); },
    "/api/ask": askStart,
    "/api/ask/stop": () => { for (const t of W.ask.threads) for (const i of t.items) if (i.state === "running") Object.assign(i, { state: "cancelled", ended: Date.now() }); save(); return { ok: true }; },
    "/api/ask/delete": b => { const t = W.ask.threads.find(x => x.id === b.thread); if (t && t.items.some(i => i.state === "running")) throw new ApiError(409, "Stop the running question first."); if (t) W.ask.threads.splice(W.ask.threads.indexOf(t), 1); save(); return { ok: true }; },
    "/api/ask/save": b => { const text = String(b.text || "").split(/\s+/).join(" ").trim(); if (!text || text.length > 400) throw new ApiError(400, "That question cannot be saved."); W.ask.saved = b.remove ? W.ask.saved.filter(x => x !== text) : W.ask.saved.includes(text) ? W.ask.saved : [text, ...W.ask.saved].slice(0, 24); save(); return { saved: W.ask.saved }; },
    "/api/setting": saveSetting, "/api/config": startConfig, "/api/config/reply": configReply, "/api/config/restart": configRestart, "/api/config/revert": startConfigRevert,
  };
  const CFG_GET = { "/api/bootstrap": bootstrap, "/api/template": getTemplate };
  const CFG_POST = { "/api/preview": preview, "/api/save": saveTemplate, "/api/local": saveLocal, "/api/auth": saveAuth, "/api/check": check, "/api/detect": detect, "/api/ping": ping, "/api/done": () => ({ ok: true }) };

  async function route(path, method, q, body) {
    if (path === "/api/prefs") return prefs(method, body);
    if (path.startsWith("/configure/api/")) {
      const p = path.slice("/configure".length), h = (method === "POST" ? CFG_POST : CFG_GET)[p];
      if (!h) throw new ApiError(404, "Not found");
      return h(method === "POST" ? body : q);
    }
    const h = (method === "POST" ? CONSOLE_POST : CONSOLE_GET)[path];
    if (!h) throw new ApiError(404, "Not found");
    return h(method === "POST" ? body : q);
  }

  const json = (data, status) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    if (url.origin !== location.origin || !/^\/(configure\/)?api\//.test(url.pathname)) return realFetch(input, init);
    const method = (init.method || "GET").toUpperCase();
    let body = {};
    try { body = init.body ? JSON.parse(init.body) : {}; } catch { return json({ error: "The request was not valid." }, 400); }
    if (url.pathname !== "/api/op") await sleep(method === "POST" ? 160 : 90);
    try { return json(await route(url.pathname, method, url.searchParams, body && typeof body === "object" ? body : {}), 200); }
    catch (e) {
      if (e instanceof ApiError) return json({ error: e.message, ...e.extra }, e.status);
      console.error("[demo]", e);
      return json({ error: `The demo hit an error: ${e.message}` }, 500);
    }
  };

  /* ---------------------------------------------------------------- the demo chrome: what-to-try card and self-running walkthroughs */

  const params = new URLSearchParams(location.search);
  const console_ = (h) => `/?token=demo#/${h}`;
  const TRY = [
    ["Deploy", "app/api"],
    ["Change config", "app/api/config"],
    ["Ask the server", "ask"],
    ["Audit log", "activity"],
    ["Edit template", "cfg"],
  ];

  function tryCard() {
    if (document.querySelector(".demo-card")) return;
    const wrap = document.createElement("div");
    wrap.className = "demo-layer";
    wrap.innerHTML = `<div class="demo-scrim" data-demo="close"></div><section class="demo-card" role="dialog" aria-modal="true" aria-labelledby="demo-h">
      <button type="button" class="demo-x" data-demo="close" aria-label="Close">&times;</button>
      <p class="demo-eyebrow">Live demo · simulated data</p>
      <h2 id="demo-h">uat-deploy</h2>
      <p class="demo-lede">Claude Code deploys to UAT servers. Nothing changes until you approve the plan.</p>
      <button type="button" class="demo-play" data-demo="play"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z"/></svg>Watch demo</button>
      <p class="demo-or">or try it yourself</p>
      <div class="demo-try">${TRY.map(([h, to]) => `<button type="button" data-demo-go="${to}">${h}</button>`).join("")}</div>
      <button type="button" class="demo-reset" data-demo="reset">Reset demo</button></section>`;
    document.body.append(wrap);
    wrap.querySelector(".demo-play").focus();
  }
  const closeCard = () => document.querySelector(".demo-layer")?.remove();

  document.addEventListener("click", e => {
    const t = e.target.closest("[data-demo], [data-demo-go]");
    if (!t) return;
    e.preventDefault();
    const act = t.dataset.demo, to = t.dataset.demoGo;
    if (act === "try") return tryCard();
    if (act === "reset") { try { sessionStorage.removeItem(KEY); } catch {} W = null; if (IN_CFG) location.href = console_("apps"); else { history.replaceState(null, "", "#/apps"); location.reload(); } return; }
    if (act === "close") return closeCard();
    closeCard();
    if (act === "play") { if (IN_CFG) location.href = "/?token=demo&play=deploy-full#/apps"; else play("deploy-full"); return; }
    if (to === "cfg") { location.href = "/configure?token=demo#edit/shopfront"; return; }
    if (to === "app/api/config") { try { S.cfgDraft.api = S.cfgDraft.api || "Set checkout.session-timeout to 300"; } catch {} }
    if (IN_CFG) location.href = console_(to); else location.hash = "#/" + to;
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && document.querySelector(".demo-layer")) closeCard(); });

  const waitFor = async (fn, ms = 30000) => { const end = Date.now() + ms; for (;;) { let v; try { v = fn(); } catch { v = null; } if (v) return v; if (Date.now() > end) return null; await sleep(120); } };
  const say = text => { try { toast(text); } catch {} };

  const pin = (sel, above) => { const el = document.querySelector(sel); if (el) window.scrollTo({ top: el.getBoundingClientRect().top + scrollY - above, behavior: "instant" }); };

  async function play(kind) {
    await waitFor(() => typeof S !== "undefined" && S.state);
    if (kind.startsWith("deploy")) {
      location.hash = "#/app/api";
      const input = await waitFor(() => document.querySelector("#newname"));
      if (!input) return;
      // bring the deploy line to the middle of the screen; from here the page follows each step as it runs
      input.closest("li")?.scrollIntoView({ block: "center", behavior: "smooth" });
      await sleep(900);
      const name = current("api").suggested;
      for (let i = 1; i <= name.length; i += 3) { input.value = name.slice(0, i); input.dispatchEvent(new Event("input", { bubbles: true })); await sleep(40); }
      input.value = name; input.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(500);
      input.form.requestSubmit();
      if (kind === "deploy") return;
      const approve = await waitFor(() => document.querySelector('[data-act="approve"]'), 120000);
      if (!approve) return;
      if (kind === "deploy-gate") { await sleep(1500); pin(".st.gate", 170); return; }
      say("The written plan is shown before anything on UAT changes. Approving it…");
      await sleep(4500);
      approve.click();
    } else if (kind === "ask") {
      location.hash = "#/ask";
      const box = await waitFor(() => document.querySelector("#asktext"));
      await sleep(800);
      box.value = "What are the latest errors in the payments-worker log?";
      box.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(300);
      box.form.requestSubmit();
    } else if (kind === "config") {
      location.hash = "#/app/payments/config";
      const box = await waitFor(() => document.querySelector("#cfgtext"));
      await sleep(600);
      box.value = "Set gateway.timeout to 10s";
      box.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(300);
      box.form.requestSubmit();
    }
  }

  addEventListener("error", e => { const el = document.getElementById("demo-errors") || Object.assign(document.createElement("pre"), { id: "demo-errors", hidden: true }); el.textContent += `${e.message} @ ${e.filename}:${e.lineno}\n`; document.body?.append(el); });
  addEventListener("unhandledrejection", e => { const el = document.getElementById("demo-errors") || Object.assign(document.createElement("pre"), { id: "demo-errors", hidden: true }); el.textContent += `unhandled: ${e.reason && e.reason.message || e.reason}\n`; document.body?.append(el); });

  if (window.__UAT_TEST) window.__UAT_INTERNALS = { render, normalize, validate, parseRequest, leaves, route, answerFor, W, OPS };

  document.addEventListener("DOMContentLoaded", () => {
    const p = params.get("play");
    // the card opens on every load of the console; closing it (✕, Esc or the backdrop) leaves the page to explore
    if (p) play(p);
    else if (!IN_CFG && params.get("tour") !== "0") setTimeout(tryCard, 500);
  });
})();
