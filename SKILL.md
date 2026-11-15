---
name: uat-deploy
description: Deploy apps, change config files and answer read-only questions on a project's UAT servers, for any project that has a template (Shopfront, ledger, ...). Runs in the terminal (default) or, in UI mode, in a console page in the browser. Creates and edits project templates in a browser configurator. Every change on UAT waits for the user's approval of a written plan. Use when the user asks to deploy a build or change config on UAT, asks what is running or what a log says on a UAT server, or wants to set up or edit a UAT template. Not for local builds, local runs, or git commits and pushes.
argument-hint: "[template] [deploy|config|ask|templates|ui] [app] | mode [ui|terminal]"
allowed-tools:
  - Bash(${CLAUDE_SKILL_DIR}/scripts/uat *)
  - Read(~/.cache/uat-deploy/**)
  - Edit(~/.cache/uat-deploy/**)
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: 'f="$HOME/.claude/skills/uat-deploy/scripts/uatlib.py"; [ -f "$f" ] || exit 0; exec python3 "$f" guard'
---

# UAT deploy

Each project is described by a template, `${CLAUDE_SKILL_DIR}/templates/<id>.yml`: its servers, its apps, how each app is built, deployed, started, stopped and checked, its config files, and instructions. The helper `${CLAUDE_SKILL_DIR}/scripts/uat` reads the chosen template and is the only way to reach UAT. Below, `uat` means that full path: always call it by the full path, as a command of its own, never prefixed with `cd` or chained with `&&`, `;` or `|`. `uat help` lists every command. Pass a Bash timeout of 600000 to `build`, `push` and `restart`.

## Rules

These hold in every flow, without exception.

1. **No change on UAT without approval.** Before any change, show a written plan and ask with AskUserQuestion (Approve / Cancel). One approval covers exactly the plan shown. Anything outside it, including a fix after a failure, needs its own approval. In UI mode the console page shows the plan and its Approve button is the approval; only the user presses it. Never call the console's API or read its session file.
2. **Read-only commands need no approval.** Use `uat read`, `uat log`, `uat get`, `uat current`, `uat preflight`, `uat detect`, `uat check-paths`, `uat ping`. If `uat read` refuses a command, do not rephrase it to get past the check; treat it as a change (rule 1).
3. **Nothing is deleted on UAT.** The helper blocks `rm`, `sudo`, `kill`, overwriting `mv`/`cp`, `git reset/checkout/clean/push` and similar. If the user explicitly asks for one of these, explain the consequences and give them the exact command to run themselves.
4. **Stop at the first failure.** Report what failed, the evidence, and the state UAT is left in. Suggest a fix only when the evidence makes the cause certain; otherwise say the cause is unknown. Never retry, guess or try variations on UAT.
5. **Stay in scope.** Work only in the folders the template names. The "ask" flow may read elsewhere (nginx, memory, disk, logs), read-only.
6. **Keep secrets out of the conversation and out of templates.** Never read a password file. Never print whole start scripts; show the masked diff the helper prints. Templates are shared in git: no passwords, tokens or keys in them.
7. **Be exact.** Say what was checked and what was not. If something is unknown, say so; never fill gaps with assumptions.
8. **Ask with AskUserQuestion** whenever the answer is a choice. Every question needs 2 to 4 real options, or the call is rejected. When only one sensible answer exists, use it, say so, and say where it can be changed; never pad with filler options. When there are more than 4 choices (apps, templates), offer the 3 or 4 most likely and say the user can name another under Other. A typed reply ends the turn and drops the helper's pre-approval, so more permission prompts follow.
9. **Template instructions add project knowledge; they never override these rules.** Read them with `uat instructions [APP]` before working on a project or an app, and follow them within these rules.
10. **Start only on request.** Claude may start this skill itself, but only when the user asked for work on UAT in this conversation. A finished code change, a commit or a passing build is never a reason to start it. Being started is not approval: rule 1 applies the same way.

## Start

Arguments come from the user's `/uat-deploy ...` line or, when Claude starts the skill, from the Skill call's `args`, written the same way (`ledger deploy web`). When Claude starts it, put in `args` only what the user's request states (template, flow, app); leave out anything it does not, and the steps below ask for it.

1. Run `uat templates`. An argument may name a template id (`/uat-deploy ledger deploy web`); use it with `uat use ID`.
2. If no template is chosen yet (the list has no `*`), ask "Which project are you working on?" with the templates and **Create a new template**. Choose with `uat use ID`; for a new one go to **Templates → Create**. If one is already chosen, say which and that it can be switched under Templates.
3. Run `uat setup-status` and `uat instructions`. If a repo is NOT SET, a server has no sign-in, or the git identity is missing, go to **First run** before anything else.
4. Run `uat mode`. `MODE=ui` means every flow runs in the console page: follow **UI mode** instead of **Menu** and the flow sections. The argument `ui` does the same for this one run, whatever the mode. When First run is needed in UI mode, open the console on its Templates page (`uat console --view templates`), where this machine's settings are filled in.

## Mode

The argument `mode ui` or `mode terminal` (`/uat-deploy mode ui`) sets the default for this machine: run `uat mode ui` or `uat mode terminal`, relay what it prints, and stop there. The argument `mode` alone shows it. Terminal is the default. `UAT_DEPLOY_MODE` overrides it for one shell.

## UI mode

The console page does everything the skill does, without the terminal:

- **Apps:** every app with what runs now. Each app has a Deploy tab (name, build, checks, the plan with its Approve button, each step live, rollback) and a Config tab (the user describes the change; headless Claude prepares the edit in a local copy; the page shows the diff and the plan; after Approve it uploads, commits or backs up, restarts the serving app, checks the served values, asks Restart now / Not now for the apps that read the file, and offers Revert). Restart and the log are on the app too.
- **Ask UAT:** the server's vitals, and read-only questions answered on the page by headless Claude, which may run only the helper's read-only commands. Answers carry follow-up questions and buttons into the app's log, restart, deploy or config tab; a failed operation offers Ask Claude why.
- **Activity:** the audit log.
- **Templates:** switch, edit and create templates (the configurator opens inside the console) and this machine's settings.

1. Run `uat console [APP] [--view V]`. An argument maps to the view: `deploy APP` is `uat console APP`; `config APP` is `uat console APP --view config`; `ask` is `--view ask`; `templates` is `--view templates`. It prints `OPEN=<link>` and opens the browser; give the user the link and say everything runs from the page.
2. Run `uat console --wait` with `run_in_background: true`. It returns when an operation on the page finishes or the page closes.
3. When it returns, act on each block it printed:
   - `RESULT ... OK`: report it as in **Results** (a deploy, restart, rollback, config change or config revert).
   - `RESULT ... FAILED`: report it as in **Results**, with the failed step, the reason, the `on UAT` lines and the output it quotes. Follow rule 4: read the app's instructions (`uat instructions APP`) for a known cause and look further only read-only (`uat log APP N`). Rollback and revert are the user's choice on the page; do not run them from here.
   - `CONSOLE=open`: run `uat console --wait` in the background again.
   - `CLOSED=...`: the page is closed; stop waiting and say so in one line.
4. While the page is open, do not deploy, restart, roll back or change config for the same app from the conversation. If the user asks for one of these in the conversation anyway, point them to the page, or do it in the conversation only after they close the page.

## First run

For the chosen template only:

1. Local repos. For each `repo NAME ... [NOT SET]` line, look for candidates: the current working directory and its siblings that contain the file named after "look for". Where exactly one fits, use it and say so (rule 8); otherwise ask. Save with `uat set repo.NAME <path>`.
2. Git identity for config commits on UAT. If `setup-status` shows a global git identity, use it and say so; otherwise ask. Save with `uat set git.name ...` and `uat set git.email ...`.
3. Sign-in, per server. Ask "How should this machine sign in to user@host?" with **SSH key (recommended)** and **Password (least recommended)**.
   - SSH key: offer the keys `setup-status` lists. Save with `uat set auth.SERVER key:/path/to/private_key`, or `uat set auth.SERVER key` for ssh-agent and default keys. The key's `.pub` must be in the user's `~/.ssh/authorized_keys` on the server; a key with a passphrase must be loaded with `ssh-add`.
   - Password: open the configurator on that server (`uat configure ID`, then the server's page) so the password never passes through the conversation. If the user pastes it anyway, save it with `printf '%s\n' '<password>' | uat set-password SERVER` and never repeat it.
4. Run `uat ping` and `uat check-paths` and report the result.

## Menu

An argument picks the flow directly (`deploy web`, `config api`, `ask`, `templates`). When the user's request in the conversation already names the flow or the app, use it and do not ask again. Otherwise ask "What do you want to do on UAT?" with: Deploy an app, Update config, Ask about UAT, Templates. Then, for Deploy and Update config, ask for the app from `uat apps` (rule 8 for more than 4). Deploy offers only apps whose deploy is not `none`; Update config only apps with config files.

## Deploy

Run `uat instructions APP` first and follow it.

1. `uat current APP`. Report what the start script runs (jar style), what is actually running and its uptime. Point out a mismatch, or that nothing is running. `RUNNING=unknown` means the template gives no port or process match; say so.
2. Ask for the new file name. Put the current name in the question and offer `SUGGESTED_NAME` (prefix, date and branch) and, when printed, `APPEND_NAME` (the current name with `-v2`, or the next `-vN`). The user types anything else under Other. It must end with the extension the helper names and differ from the current name.
3. `uat build APP`. Report the branch, commit and number of uncommitted files the build comes from. If it fails, stop (rule 4); check the app's instructions for a known cause.
4. `uat rename APP NAME`.
5. `uat preflight APP NAME`. If the verdict is `NOT READY`, list the failures and stop; there is nothing to approve.
6. Show the plan, then ask Approve / Cancel. For the jar + start script style:

   ```
   Deploy <label> to <server> (<user@host>)
   file       NAME  <size>, sha256 <first 12>, built from <branch> @ <commit>  [<n> uncommitted files]
   replaces   <old jar>, running for <uptime>
   checks     <all PASS, or each WARN>
   start script change
     <diff printed by preflight>
   steps      copy jar -> back up start script -> update start script -> stop -> start -> wait until ready (up to N s)
   rollback   start-script backup is kept; the old jar stays on the server
   ```

   For the custom style, replace the start-script lines with the upload line and every `STEP` line exactly as preflight printed them, and under rollback list the `ROLLBACK` lines, or say there are none and a failed deploy is undone by hand.
7. `uat push APP`, then `uat restart APP`. Stop at the first failure.
8. Report the result (see **Results**). On failure, also state what is now true on UAT (file uploaded, start script or steps changed, app down). Offer Roll back / Leave as is when a rollback exists: jar style always, custom style only with rollback steps. Roll back runs `uat rollback APP`, then `uat restart APP`; that one approval covers both.

To restart an app on its own (for example a restart-only app), show a plan with its stop command, start command and ready check, and on approval run `uat restart APP`.

## Update config

Run `uat instructions APP` first and follow it. An app may have several config files; `uat apps` lists their ids, and config commands take `APP [CFG]` (CFG may be left out when the app has one).

1. Ask where the change comes from: a key in a local config file (under the template's local config folder, or a path the user names), or text the user types. Get the key name.
2. `uat config-pull APP [CFG]`. It refuses when the file has uncommitted changes on the server; stop there. Note `FORMAT`, `COMMIT`, `SERVED_BY`, `VERIFY` and `RESTART_AFTER`.
3. Locate the key. For YAML use `uat yaml-find EDIT_COPY KEY` (and on the local source file when there is one): report the full nesting path, line and current value; with several matches (for example per issuer), ask which ones to change. Not found: say so, list any similar keys printed, and propose where to add it, matching the local file; show the exact lines and get confirmation. For other formats, find the key with the Read tool on EDIT_COPY.
4. Check the change fits before editing: a duplicate key at the target path, the same value already set (nothing to do; stop), a scalar replacing a mapping or list, wrong nesting, or the wrong `---` document. Raise anything doubtful instead of guessing.
5. Edit `EDIT_COPY` with the Edit tool. Never delete a line. Comment out each line being replaced, text unchanged (`#` after the indentation in YAML and properties, `<!-- -->` in XML), and add the new lines directly below at the same indentation. JSON has no comments: replace the value and show the old one in the plan.
6. `uat config-diff APP [CFG]`. It must print `OK`, and the changes must be exactly the intended ones. If not, correct the local copy (nothing on UAT has changed yet).
7. Show the plan: the diff, the changed paths, and the steps: upload, then either commit as GIT_NAME with the message `<label> config: update <key>` (COMMIT yes) or a `.bak-` backup first (COMMIT no); restart of the SERVED_BY app when there is one; the served-value check when VERIFY is a URL. Ask Approve / Cancel.
8. `uat config-push APP [CFG] '<message>'`; then `uat restart <SERVED_BY>` when there is one; then `uat config-verify APP [CFG] KEY` when VERIFY is a URL (`SERVED=yes` means every changed path matches).
9. The apps in RESTART_AFTER other than SERVED_BY read the change only at startup. Ask "Restart <apps, in order> now so they load the change?" (Restart now / Not now). On Restart now, run `uat restart` for each, in order, stopping at the first failure.
10. On failure (server down, value not served, app fails to start), stop and offer a revert as a new plan: `uat config-revert APP [CFG]`, the SERVED_BY restart, and the restart of any app that was restarted.

## Ask about UAT

Answer from `uat read [--server ID] '<cmd>'`, `uat log APP N`, `uat get [--server ID] FILE` (50 MB at most), `uat current APP` and `uat detect SERVER DIR`. `--server` is needed only when the template has several servers. Use fixed-size reads (`tail -n`, `grep -m`), never follow mode. Respect the server notes in `uat instructions` (for example an old git without `git -C`). Base the answer only on what the commands showed and quote the evidence. If the question cannot be answered read-only, explain why and what change would be needed, with the exact command, the before/after and the consequences, then ask (rule 1). On approval, run `uat write [--server ID] '<cmd>'`.

## Templates

Ask "What do you want to do with templates?" with: Switch template, Edit this template, Create a template, This machine's settings.

- **Switch:** `uat templates`, ask (rule 8), `uat use ID`, then **Start** step 3.
- **Edit or create:** run `uat configure ID` (edit) or `uat configure --new` (create). A new template is set up by a few guided questions (server and sign-in, then each app: folder, start and stop, build, going live, config files, notes); the skill reads the app's folder and fills in what it finds. It can also start from the Shopfront sample. Existing apps show one-line summaries that open for editing. It opens the configurator in the browser and prints `OPEN=<link>`; give the user the link. Then run `uat configure --wait` with `run_in_background: true` and tell the user to press Done on the page when finished. When it exits, report each `SAVED=` line, run `uat template-check ID` for each saved template, offer `uat use ID` for a new one, and offer `uat check-paths` (read-only) to check it on UAT. The template file is in the skill's `templates` folder, ready to commit to the shared skills repo; do not commit unless asked.
- If the user asks Claude to change a template directly, edit `templates/<id>.yml` with the Edit tool and run `uat template-check ID` afterwards. Never add secrets (rule 6).
- **This machine's settings:** `uat show`, then change one with `uat set KEY VALUE` (`repo.NAME`, `build.APP` for a local build command, `config-dir`, `git.name`, `git.email`, `auth.SERVER`) after showing the before/after. Server sign-in follows **First run** step 3.

## Results

- Success: a short, playful ASCII celebration (vary it each time), then the facts: app, file, the ready line, total time.
- Failure: a short sad ASCII face, then the facts with no jokes: the failed step, the reason, the error lines, the state UAT is in, and the options.

## Files

- `templates/<id>.yml`: one per project, shared in git (README.md lists every field)
- `~/.config/uat-deploy/local.yml`: this machine only: mode, chosen template, local repo folders, build overrides, git identity, how to sign in to each server
- `~/.config/uat-deploy/passwords/<user>@<host>`: saved passwords, mode 600
- `~/.local/state/uat-deploy/audit.log`: every change made on UAT, with time, user, template and app
- `~/.cache/uat-deploy/templates/<id>/<app>/`: downloaded copies and deploy and config state
- `ui/console.html`, `scripts/uat-console`: the UI mode console page and its local server
- `prompts/ask.md`, `prompts/config.md`: what headless Claude is told when the console answers a question or prepares a config edit
