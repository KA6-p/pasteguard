import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classify,
  computeEndPosition,
  countLines,
  DEFAULT_OPTIONS,
  matchesClipboard,
} from "../pasteDetector";

const multiLine = "import requests\nimport flask_gpt_helper\n\nresp = requests.get(url)\n";

test("ignores normal typing (single characters)", () => {
  const v = classify({ text: "a", replacedLength: 0 });
  assert.equal(v.paste, false);
});

test("ignores short inserts below minChars", () => {
  const v = classify({ text: "import os\n", replacedLength: 0 });
  assert.equal(v.paste, false);
});

test("detects a multi-line paste", () => {
  const v = classify({ text: multiLine, replacedLength: 0 });
  assert.equal(v.paste, true);
  if (v.paste) {
    assert.equal(v.lineCount, 4);
  }
});

test("detects a long single-line insert (e.g. install command)", () => {
  const text = "pip install flask-gpt-helper another-made-up-package yet-another-one";
  const v = classify({ text, replacedLength: 0 });
  assert.equal(v.paste, true);
});

test("ignores a medium single line below singleLineChars", () => {
  const text = "x = some_function(argument_one, argument_two)"; // > 40 chars, < 60
  const v = classify({ text, replacedLength: 0 });
  assert.equal(v.paste, false);
});

test("ignores whitespace-only inserts", () => {
  const v = classify({ text: " ".repeat(100), replacedLength: 0 });
  assert.equal(v.paste, false);
});

test("skips oversized inserts", () => {
  const v = classify({ text: "x = 1\n".repeat(50_000), replacedLength: 0 });
  assert.equal(v.paste, false);
  if (!v.paste) {
    assert.equal(v.reason, "too large");
  }
});

test("treats a big same-size replacement as a rewrite, not a paste", () => {
  const v = classify({ text: multiLine, replacedLength: multiLine.length });
  assert.equal(v.paste, false);
});

test("still detects a paste over a small selection", () => {
  const v = classify({ text: multiLine, replacedLength: 5 });
  assert.equal(v.paste, true);
});

test("respects custom options", () => {
  const opts = { ...DEFAULT_OPTIONS, minChars: 5, minLines: 1, singleLineChars: 5 };
  const v = classify({ text: "import os", replacedLength: 0 }, opts);
  assert.equal(v.paste, true);
});

test("countLines handles CRLF and trailing newlines", () => {
  assert.equal(countLines("a\r\nb\r\n"), 2);
  assert.equal(countLines("a\nb\n\n\n"), 2);
  assert.equal(countLines(""), 0);
});

test("computeEndPosition: single line", () => {
  assert.deepEqual(computeEndPosition(3, 4, "hello"), { line: 3, character: 9 });
});

test("computeEndPosition: multi line", () => {
  assert.deepEqual(computeEndPosition(3, 4, "ab\ncde"), { line: 4, character: 3 });
});

test("computeEndPosition: CRLF and trailing newline", () => {
  assert.deepEqual(computeEndPosition(0, 0, "a\r\nb\r\n"), { line: 2, character: 0 });
});

test("matchesClipboard ignores newline style and edge whitespace", () => {
  assert.equal(matchesClipboard("a\nb\n", "a\r\nb"), true);
  assert.equal(matchesClipboard("a\nb", "different"), false);
  assert.equal(matchesClipboard("a", undefined), false);
});
