#!/usr/bin/env python3
"""Regenerate demo/fixtures.json from templates/shopfront.yml with the skill's own template code.

Run it after changing the sample template:  python3 demo/make-fixtures.py
The demo build (node demo/build.mjs) reads the JSON, so Vercel needs no Python.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import uattpl as T  # noqa: E402

f = T.template_path("shopfront")
text = f.read_text()
t = T.normalize(T.load_file(f))
errors, warnings = T.validate(t, "shopfront")
if errors:
    sys.exit(f"templates/shopfront.yml has {len(errors)} problem(s): " + "; ".join(e["message"] for e in errors))
if T.render(t) != text:
    sys.exit("templates/shopfront.yml is not in the configurator's canonical form; save it from the configurator or run it through uattpl.render")
fixtures = {"template": t, "file_text": text, "placeholders": list(T.PLACEHOLDERS), "spring_ready": T.SPRING_READY,
            "styles": list(T.STYLES), "formats": list(T.FORMATS),
            "default_timeouts": {"start": T.DEFAULT_START_TIMEOUT, "stop": T.DEFAULT_STOP_TIMEOUT}}
(ROOT / "demo" / "fixtures.json").write_text(json.dumps(fixtures, indent=1) + "\n")
print("demo/fixtures.json written")
