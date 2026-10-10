/**
 * Finds `pip install ...` style commands in pasted text and extracts the package names.
 * Pure string logic (no VS Code, no tree-sitter) so it is easy to unit test.
 *
 * Handles: pip / pip3 / python -m pip / py -m pip / uv pip install / uv add / poetry add,
 * shell prefixes (!pip, %pip, $ pip, sudo), commands inside strings (os.system("pip install x")),
 * chained commands (a && b), quoted specs ("numpy>=1.2"), extras (uvicorn[standard]).
 *
 * Prose is deliberately ignored: "Run pip install first" must not produce a package called "first".
 */

/** A span on a single line. Line and character are 0-based, relative to the text that was parsed. */
export interface TextSpan {
  line: number;
  startCharacter: number;
  endCharacter: number;
}

export interface InstallPackage {
  /** Name as written (without extras or version spec). */
  name: string;
  extras: string[];
  versionSpec: string;
  /** Span of the name only. */
  span: TextSpan;
}

export type NoteKind =
  | "requirements-file"
  | "custom-index"
  | "url-requirement"
  | "local-path"
  | "editable"
  | "trusted-host";

/** Things that are not plain PyPI names but matter for security (Module 4 / 5 will use them). */
export interface InstallNote {
  kind: NoteKind;
  detail: string;
  span: TextSpan;
}

export interface InstallParseResult {
  packages: InstallPackage[];
  notes: InstallNote[];
}

const COMMAND_SOURCE = [
  String.raw`(?:python[0-9.]*|py)\s+-m\s+pip[0-9.]*\s+install`,
  String.raw`uv\s+pip\s+install`,
  String.raw`pip[0-9.]*\s+install`,
  String.raw`(?:uv|poetry)\s+add`,
].join("|");

const COMMAND_RE_SOURCE = String.raw`(?<![\w.-])(?:${COMMAND_SOURCE})(?![\w-])`;

const FLAGS_WITH_VALUE = new Set([
  "-r", "--requirement", "-c", "--constraint", "-e", "--editable",
  "-i", "--index-url", "--extra-index-url", "-f", "--find-links",
  "-t", "--target", "--prefix", "--root", "--trusted-host", "--proxy",
  "--python", "--platform", "--implementation", "--abi", "--python-version",
  "--only-binary", "--no-binary", "-C", "--config-settings", "--src",
  "--cache-dir", "--log", "--cert", "--client-cert", "--retries", "--timeout",
  "--exists-action", "--upgrade-strategy", "--progress-bar", "--root-user-action",
  "--report", "--global-option", "--install-option",
  // uv add / poetry add
  "--group", "-G", "--optional", "--source", "-E", "--extras", "--index",
]);

interface Token {
  value: string;
  /** Index of the first content character in the line (after any opening quote). */
  start: number;
}

/** Is the text before the command something that makes it a real command rather than prose? */
function prefixLooksLikeCommand(prefix: string): boolean {
  const t = prefix.trim();
  if (t === "") {
    return true;
  }
  // "# pip install x", "!pip install x", "%pip", "$ pip", "sudo pip", "RUN pip", "FOO=bar pip"
  if (/^(?:#+\s*)?(?:[!%$>]\s*|sudo\s+|RUN\s+|\w+=\S+\s+)*$/.test(prefix.trimStart())) {
    return true;
  }
  // chained: "cd x && pip install y", "a; pip install b"
  if (/(?:&&|\|\||;|\|)$/.test(t)) {
    return true;
  }
  // inside a string passed to a call: os.system("pip install x")
  if (/\(\s*[rRfFbB]{0,2}["'`]$/.test(t)) {
    return true;
  }
  return false;
}

/** Split the arguments after a command into tokens, stopping where the command ends. */
function tokenize(line: string, from: number): { tokens: Token[]; endIndex: number } {
  const tokens: Token[] = [];
  let i = from;
  const n = line.length;

  while (i < n) {
    while (i < n && /\s/.test(line[i])) {
      i++;
    }
    if (i >= n) {
      break;
    }
    const c = line[i];

    // The command ends here.
    if (c === ";" || c === "|" || c === "&" || c === ")" || c === "#" || c === ">" || c === "<") {
      return { tokens, endIndex: i };
    }

    // Quoted token: read to the matching quote.
    if (c === '"' || c === "'" || c === "`") {
      const close = line.indexOf(c, i + 1);
      const end = close === -1 ? n : close;
      tokens.push({ value: line.slice(i + 1, end), start: i + 1 });
      i = close === -1 ? n : close + 1;
      continue;
    }

    // Bare token.
    const start = i;
    while (i < n && !/\s/.test(line[i]) && !";|&)\"'`".includes(line[i])) {
      i++;
    }
    tokens.push({ value: line.slice(start, i), start });
    // A quote, ")" or operator glued to the token ends the command (e.g. the closing quote of os.system("...")).
    if (i < n && !/\s/.test(line[i])) {
      return { tokens, endIndex: i };
    }
  }
  return { tokens, endIndex: n };
}

const REQUIREMENT_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?(.*)$/;
const URL_RE = /:\/\/|^git\+|^hg\+|^svn\+|^bzr\+/i;
const LOCAL_PATH_RE = /^(?:\.{1,2}(?:[\\/]|$)|[\\/]|~|[A-Za-z]:[\\/])|\.(?:whl|tar\.gz|tgz|zip)$/i;

function parseArguments(tokens: Token[], lineNo: number, out: InstallParseResult): void {
  const span = (t: Token, len = t.value.length): TextSpan => ({
    line: lineNo,
    startCharacter: t.start,
    endCharacter: t.start + len,
  });

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    const v = t.value;
    if (v === "") {
      continue;
    }

    // Flags
    if (v.startsWith("-")) {
      const eq = v.indexOf("=");
      const flag = eq > 0 ? v.slice(0, eq) : v;
      let value: string | undefined = eq > 0 ? v.slice(eq + 1) : undefined;
      let valueToken: Token = t;
      if (value === undefined && FLAGS_WITH_VALUE.has(flag) && k + 1 < tokens.length) {
        valueToken = tokens[k + 1];
        value = valueToken.value;
        k++;
      }
      const detail = value ?? "";
      switch (flag) {
        case "-r":
        case "--requirement":
          out.notes.push({ kind: "requirements-file", detail, span: span(valueToken) });
          break;
        case "-e":
        case "--editable":
          out.notes.push({ kind: "editable", detail, span: span(valueToken) });
          break;
        case "-i":
        case "--index-url":
        case "--extra-index-url":
        case "--index":
        case "-f":
        case "--find-links":
          out.notes.push({ kind: "custom-index", detail, span: span(valueToken) });
          break;
        case "--trusted-host":
          out.notes.push({ kind: "trusted-host", detail, span: span(valueToken) });
          break;
        default:
          break;
      }
      continue;
    }

    // "name @ https://..." (PEP 508 direct reference)
    if (k + 1 < tokens.length && tokens[k + 1].value === "@") {
      const urlTok = tokens[k + 2];
      out.notes.push({
        kind: "url-requirement",
        detail: `${v} @ ${urlTok?.value ?? ""}`,
        span: span(t),
      });
      k += urlTok ? 2 : 1;
      continue;
    }

    // URL or VCS requirement
    if (URL_RE.test(v)) {
      out.notes.push({ kind: "url-requirement", detail: v, span: span(t) });
      continue;
    }

    // Local path or wheel/archive file
    if (v === "." || LOCAL_PATH_RE.test(v)) {
      out.notes.push({ kind: "local-path", detail: v, span: span(t) });
      continue;
    }

    // Normal requirement: name[extras]spec
    const m = REQUIREMENT_RE.exec(v);
    if (!m) {
      continue;
    }
    const name = m[1];
    const extras = m[2] ? m[2].slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean) : [];
    // Drop environment markers ("; python_version < '3.9'") from the version spec.
    const versionSpec = (m[3] ?? "").split(";")[0].trim();
    out.packages.push({ name, extras, versionSpec, span: span(t, name.length) });
  }
}

export function parsePipInstalls(text: string): InstallParseResult {
  const result: InstallParseResult = { packages: [], notes: [] };
  const lines = text.split(/\r\n|\r|\n/);

  lines.forEach((line, lineNo) => {
    const re = new RegExp(COMMAND_RE_SOURCE, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      if (!prefixLooksLikeCommand(line.slice(0, m.index))) {
        continue;
      }
      const argsStart = m.index + m[0].length;
      const { tokens, endIndex } = tokenize(line, argsStart);
      parseArguments(tokens, lineNo, result);
      re.lastIndex = Math.max(endIndex, argsStart);
    }
  });

  return result;
}
