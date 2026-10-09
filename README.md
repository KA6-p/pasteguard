# PasteGuard (work in progress)

Checks pasted Python code for hallucinated packages and risky patterns.

**Status:** Module 1 (paste interceptor) only. It detects pastes and logs them; scanning comes in later modules.

## Run it
1. `npm install`
2. `npm test` (unit tests for the detection logic)
3. Open this folder in VS Code and press **F5** (Run Extension).
4. In the new window, open `samples/sample.py` and paste the snippet below.
5. Run **PasteGuard: Show Log** from the Command Palette. You should see a `[paste]` line.

## Test snippet
```python
import requests
import flask_gpt_helper

def run(cmd):
    import subprocess
    return subprocess.run(cmd, shell=True)
```
Typing a few characters, or undo/redo, should NOT produce a `[paste]` line.
