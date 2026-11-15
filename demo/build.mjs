// Builds the static live demo into dist/: the two pages from ui/ (unchanged), plus the in-browser mock of their
// servers, the demo banner and its stylesheet. Plain Node, no dependencies:  node demo/build.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const REPO = "https://github.com/renjithroy/uat-deploy";
const DESCRIPTION = "Live demo of uat-deploy, a Claude Code skill that deploys builds, changes config and answers questions on UAT servers, every change behind an approved plan. Simulated data.";

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, "configure"), { recursive: true });
fs.mkdirSync(path.join(dist, "demo"), { recursive: true });

const fixtures = JSON.parse(fs.readFileSync(path.join(root, "demo", "fixtures.json"), "utf8"));
fs.writeFileSync(path.join(dist, "demo", "fixtures.js"), `window.__UAT_FIXTURES = ${JSON.stringify(fixtures)};\n`);
for (const f of ["mock-api.js", "demo.css", "favicon.svg"]) fs.copyFileSync(path.join(root, "demo", f), path.join(dist, "demo", f));

const BANNER = `<div class="demo-banner" role="note"><span class="demo-dot" aria-hidden="true"></span><span class="demo-msg"><b>Live demo</b>, simulated data.<span class="demo-long"> No real servers are touched.</span></span>
<button type="button" data-demo="try">What to try</button><a href="${REPO}" target="_blank" rel="noopener">GitHub ↗</a></div>`;

function page(file, { title, inConsole }) {
  let html = fs.readFileSync(path.join(root, "ui", file), "utf8");
  const swap = (from, to) => {
    if (!html.includes(from)) throw new Error(`ui/${file}: cannot find ${from}`);
    html = html.replace(from, to);
  };
  // the mock must run before the page's own scripts, so it goes right after the charset
  swap('<meta charset="utf-8">', `<meta charset="utf-8">
<script>${inConsole ? "window.__console = true;" : ""}</script>
<script src="/demo/fixtures.js"></script>
<script src="/demo/mock-api.js"></script>`);
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>
<meta name="description" content="${DESCRIPTION}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${DESCRIPTION}">
<link rel="icon" href="/demo/favicon.svg" type="image/svg+xml">`);
  // after the page's own styles, so the demo's layout adjustments win
  swap("</head>", `<link rel="stylesheet" href="/demo/demo.css">\n</head>`);
  swap("<body>", `<body>\n${BANNER}`);
  return html;
}

fs.writeFileSync(path.join(dist, "index.html"), page("console.html", { title: "uat-deploy · live demo", inConsole: false }));
fs.writeFileSync(path.join(dist, "configure", "index.html"), page("index.html", { title: "uat-deploy · templates (live demo)", inConsole: true }));
console.log(`built ${path.relative(process.cwd(), dist) || "dist"}/: index.html (console), configure/index.html (configurator), demo/`);
