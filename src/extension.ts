import * as path from "node:path";
import * as vscode from "vscode";
import { DiskCache } from "./cache";
import { extractFromPython, toAbsolute } from "./extractor";
import { PackageIntelligence } from "./packageIntel";
import { PasteEvent, PasteInterceptor } from "./pasteInterceptor";
import { PythonParser } from "./pythonParser";
import { formatVerdictLine } from "./verdictLog";
import { collectLocalModuleNames } from "./workspaceModules";

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("PasteGuard");
  const interceptor = new PasteInterceptor(log);

  // Module 3: registry lookups, cached on disk so repeat checks are instant and work offline.
  const cache = new DiskCache(path.join(context.globalStorageUri.fsPath, "pypi-cache.json"));
  const intel = new PackageIntelligence({ cache });

  // Load tree-sitter once, in the background. Pastes wait on this promise if they arrive early.
  const parserPromise = PythonParser.create().catch((err) => {
    log.appendLine(`[error] could not load the Python parser: ${String(err)}`);
    return undefined;
  });

  const handlePaste = async (p: PasteEvent): Promise<void> => {
    const file = vscode.workspace.asRelativePath(p.uri);
    const where = `${p.range.start.line + 1}:${p.range.start.character + 1}-${p.range.end.line + 1}:${p.range.end.character + 1}`;
    log.appendLine(`[paste] ${p.source} | ${p.lineCount} line(s), ${p.text.length} chars | ${file} ${where}`);
    vscode.window.setStatusBarMessage(`PasteGuard: detected a ${p.lineCount}-line paste`, 2500);

    const parser = await parserPromise;
    if (!parser) {
      return;
    }

    // Module 2: extract package candidates from the pasted text.
    const result = extractFromPython(p.text, parser);
    const start = { line: p.range.start.line, character: p.range.start.character };
    for (const c of result.packages) {
      const s = toAbsolute(c.span, start);
      const spec = c.versionSpec ? ` ${c.versionSpec}` : "";
      const mapped = c.name === c.distribution ? "" : ` -> ${c.distribution}`;
      log.appendLine(
        `  [package] ${c.origin} ${c.name}${spec}${mapped} (${c.mappingConfidence}) at ${s.line + 1}:${s.startCharacter + 1}`,
      );
    }
    for (const n of result.notes) {
      const s = toAbsolute(n.span, start);
      log.appendLine(`  [note] ${n.kind}: ${n.detail} at ${s.line + 1}:${s.startCharacter + 1}`);
    }
    const st = result.stats;
    log.appendLine(
      `  [summary] ${result.packages.length} candidate(s); skipped stdlib: ${st.stdlibSkipped.join(", ") || "none"}; relative imports: ${st.relativeImportsSkipped}; parse errors: ${st.parseHadErrors}`,
    );

    // Module 3: check the packages against PyPI (only package names leave this machine).
    const enabled = vscode.workspace.getConfiguration("pasteguard").get<boolean>("packageChecks.enabled", true);
    if (!enabled || result.packages.length === 0) {
      return;
    }
    const local = await collectLocalModuleNames(p.uri);
    const verdicts = await intel.assessAll(result.packages, { isLocalModule: (n) => local.has(n.toLowerCase()) });
    for (const v of verdicts) {
      log.appendLine(formatVerdictLine(v));
    }
  };

  context.subscriptions.push(
    log,
    interceptor,
    { dispose: () => void cache.dispose() },
    vscode.commands.registerCommand("pasteguard.showLog", () => log.show(true)),
    interceptor.onPaste((p) => {
      void handlePaste(p).catch((err) => log.appendLine(`[error] ${String(err)}`));
    }),
  );

  log.appendLine("PasteGuard active (Module 1: paste interceptor, Module 2: extractor, Module 3: package checks).");
}

export function deactivate(): void {}
