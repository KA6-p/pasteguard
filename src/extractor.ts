import type Parser from "web-tree-sitter";
import { mapImportToDistribution, MappingConfidence } from "./importMap";
import { InstallNote, parsePipInstalls, TextSpan } from "./installParser";
import { PythonParser } from "./pythonParser";
import { isStdlib } from "./stdlib";

export type { TextSpan, InstallNote } from "./installParser";

export interface PackageCandidate {
  origin: "import" | "pip-install";
  /** As written in the code (top-level import name, or the requirement name). */
  name: string;
  /** Best guess at the PyPI distribution name. */
  distribution: string;
  /** PEP 503 normalized distribution name, for lookups and de-duplication. */
  normalized: string;
  /**
   * known     = in our mapping table
   * assumed   = import name assumed equal to the PyPI name (a PyPI miss means "unverified", not "missing")
   * ambiguous = namespace package (google, azure...); must never be called "nonexistent"
   * explicit  = came from a pip install command, so the name is exactly what the user would install
   */
  mappingConfidence: MappingConfidence | "explicit";
  versionSpec?: string;
  /** Position relative to the start of the pasted text. Use toAbsolute() for document positions. */
  span: TextSpan;
}

export interface ExtractionResult {
  packages: PackageCandidate[];
  notes: InstallNote[];
  stats: {
    stdlibSkipped: string[];
    relativeImportsSkipped: number;
    parseHadErrors: boolean;
  };
}

/** PEP 503 name normalization. */
export function normalizeDistribution(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/**
 * Remove common leading whitespace so indented snippets (copied from inside a function) parse cleanly.
 * Returns the indent that was removed so columns can be mapped back.
 */
export function dedent(text: string): { code: string; indent: number } {
  const lines = text.split(/\r\n|\r|\n/);
  let min = Infinity;
  for (const l of lines) {
    if (l.trim() === "") {
      continue;
    }
    const lead = /^[ \t]*/.exec(l)![0].length;
    if (lead < min) {
      min = lead;
    }
  }
  if (!Number.isFinite(min) || min === 0) {
    return { code: lines.join("\n"), indent: 0 };
  }
  return { code: lines.map((l) => (l.trim() === "" ? l : l.slice(min))).join("\n"), indent: min };
}

/** Convert a span relative to the pasted text into an absolute document span. */
export function toAbsolute(span: TextSpan, pasteStart: { line: number; character: number }): TextSpan {
  const shift = span.line === 0 ? pasteStart.character : 0;
  return {
    line: span.line + pasteStart.line,
    startCharacter: span.startCharacter + shift,
    endCharacter: span.endCharacter + shift,
  };
}

function collectImports(
  tree: Parser.Tree,
  indent: number,
  stats: ExtractionResult["stats"],
): PackageCandidate[] {
  const found: PackageCandidate[] = [];

  const add = (dotted: Parser.SyntaxNode): void => {
    const first = dotted.namedChildren[0];
    const topLevel = (first?.text ?? dotted.text.split(".")[0]).trim();
    if (topLevel === "") {
      return;
    }
    if (isStdlib(topLevel)) {
      if (!stats.stdlibSkipped.includes(topLevel)) {
        stats.stdlibSkipped.push(topLevel);
      }
      return;
    }
    const anchor = first ?? dotted;
    const { distribution, confidence } = mapImportToDistribution(topLevel);
    found.push({
      origin: "import",
      name: topLevel,
      distribution,
      normalized: normalizeDistribution(distribution),
      mappingConfidence: confidence,
      span: {
        line: anchor.startPosition.row,
        startCharacter: anchor.startPosition.column + indent,
        endCharacter: anchor.startPosition.column + indent + topLevel.length,
      },
    });
  };

  for (const node of tree.rootNode.descendantsOfType(["import_statement", "import_from_statement"])) {
    if (node.type === "import_statement") {
      for (const child of node.namedChildren) {
        if (child.type === "dotted_name") {
          add(child);
        } else if (child.type === "aliased_import") {
          const name = child.childForFieldName("name");
          if (name) {
            add(name);
          }
        }
      }
    } else {
      const mod = node.childForFieldName("module_name");
      if (!mod) {
        continue;
      }
      if (mod.type === "relative_import") {
        stats.relativeImportsSkipped++;
      } else if (mod.type === "dotted_name") {
        add(mod);
      }
    }
  }
  return found;
}

/** Module 2 entry point: pull package candidates out of a pasted Python snippet. */
export function extractFromPython(text: string, parser: PythonParser): ExtractionResult {
  const stats: ExtractionResult["stats"] = { stdlibSkipped: [], relativeImportsSkipped: 0, parseHadErrors: false };

  // 1. imports (tree-sitter, error tolerant)
  const { code, indent } = dedent(text);
  const tree = parser.parse(code);
  let imports: PackageCandidate[] = [];
  try {
    stats.parseHadErrors = tree.rootNode.hasError;
    imports = collectImports(tree, indent, stats);
  } finally {
    tree.delete();
  }

  // 2. pip install commands (regex, works even inside comments and strings)
  const installs = parsePipInstalls(text);
  const installCandidates: PackageCandidate[] = installs.packages.map((p) => ({
    origin: "pip-install",
    name: p.name,
    distribution: p.name,
    normalized: normalizeDistribution(p.name),
    mappingConfidence: "explicit",
    versionSpec: p.versionSpec || undefined,
    span: p.span,
  }));

  // 3. de-duplicate: keep the first occurrence per origin + normalized name
  const seen = new Set<string>();
  const packages: PackageCandidate[] = [];
  for (const c of [...imports, ...installCandidates]) {
    const key = `${c.origin}:${c.normalized}`;
    if (!seen.has(key)) {
      seen.add(key);
      packages.push(c);
    }
  }
  packages.sort((a, b) => a.span.line - b.span.line || a.span.startCharacter - b.span.startCharacter);

  return { packages, notes: installs.notes, stats };
}
