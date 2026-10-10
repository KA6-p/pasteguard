# PasteGuard (work in progress)

Checks pasted Python code for hallucinated packages and risky patterns. Local-first, no account.

**Status:** Modules 1-3 done: paste interceptor, extractor, package intelligence (PyPI checks).
The extension detects pastes, extracts package candidates, checks them against PyPI, and writes verdicts to the log.
Rule scanning, warnings in the editor and explanations come in later modules.

## Run it
1. `npm test`  (expect: 102 tests, 0 failures). `npm install` is only needed after a fresh clone.
2. Open THIS folder in VS Code and press **F5** (or Fn+F5, or Run > Start Debugging).
3. In the new window, open `samples/sample.py`, clear it, and paste a snippet below.
4. Run **PasteGuard: Show Log** from the Command Palette.

## Test snippet
```python
import requests
import flask_gpt_helper
import utils

# pip install reqeusts flask-gpt-helper
```
Expected log (results come from the live PyPI, so details such as ages can differ):
```
[package] import requests (known) ...
[package] import flask_gpt_helper (assumed) ...
[verdict] import requests: OK (info) | exists: found, age: established ... | signals: popular-package
[verdict] import flask_gpt_helper: UNVERIFIED (warning) | exists: not-found ... | did you mean: flask
[verdict] pip-install reqeusts: DO-NOT-INSTALL (high) | exists: not-found ... | did you mean: requests, ...
[verdict] pip-install flask-gpt-helper: DO-NOT-INSTALL (high) | exists: not-found ... | did you mean: flask
```
If `utils.py` (or a `utils` folder) exists next to your file, `import utils` is treated as your own module and is not looked up.

Paste the same snippet again: the verdicts now say `cached`. Turn off your Wi-Fi and paste a package that was
checked earlier: it is answered from saved data and flagged `stale-cache`; a never-seen package becomes `unverified`.

## How verdicts work
Each package gets separate evidence dimensions (no single trust score), and one action:

| Action | Meaning |
|---|---|
| ok | Nothing suspicious found. This is NOT a guarantee of safety. |
| review | Weak provenance (very new, one release, no repo link, all yanked...). Look before installing. |
| unverified | We could not conclude (registry unreachable, namespace package, or only a guessed install name). |
| do-not-install | Do not install until you have verified it: not on PyPI under an explicit install name, or a new typo-lookalike of a popular package. |

PasteGuard never says a package is "malicious" and never installs or rewrites anything automatically.
"Did you mean" names are suggestions only.

Not on PyPI + only an *assumed* import name is `unverified`, not `do-not-install`, because the import name may simply differ
from the install name, or may be your own module.

## Privacy
- Only package **names** are sent to `pypi.org`, never your code. Turn this off with the setting `pasteguard.packageChecks.enabled`.
- Registry answers are cached in the extension's storage folder (24 h for found, 1 h for not found, so a name registered later is noticed).
- Only a handful of structured facts from PyPI are kept; free text such as descriptions is dropped.

## Popular package list
`src/popularPackages.ts` is a curated starter list (about 450 names), used only for lookalike detection and suggestions.
To replace it with real download rankings: `npm run update-popular` (needs internet; untested against the live dataset).

## Known limits (by design, for now)
- A repository link counts as present when it points at a known code host. That does not prove the link is genuine.
- Download counts, CVEs and package contents are not inspected yet.
- Unicode homoglyph names and private-index "dependency confusion" are not covered.
- `__import__("x")` and `importlib.import_module("x")` are not extracted yet.
- tree-sitter is loaded from `node_modules`, so the extension works under F5 but needs bundling before publishing.
