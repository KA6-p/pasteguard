import * as vscode from "vscode";
import { extractFromPython, toAbsolute } from "./extractor";
import { PasteEvent, PasteInterceptor } from "./pasteInterceptor";
import { PythonParser } from "./pythonParser";

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("PasteGuard");
  const interceptor = new PasteInterceptor(log);

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
    for (const c of result.packages) {
      const s = toAbsolute(c.span, { line: p.range.start.line, character: p.range.start.character });
      const spec = c.versionSpec ? ` ${c.versionSpec}` : "";
      const mapped = c.name === c.distribution ? "" : ` -> ${c.distribution}`;
      log.appendLine(
        `  [package] ${c.origin} ${c.name}${spec}${mapped} (${c.mappingConfidence}) at ${s.line + 1}:${s.startCharacter + 1}`,
      );
    }
    for (const n of result.notes) {
      const s = toAbsolute(n.span, { line: p.range.start.line, character: p.range.start.character });
      log.appendLine(`  [note] ${n.kind}: ${n.detail} at ${s.line + 1}:${s.startCharacter + 1}`);
    }
    const st = result.stats;
    log.appendLine(
      `  [summary] ${result.packages.length} candidate(s); skipped stdlib: ${st.stdlibSkipped.join(", ") || "none"}; relative imports: ${st.relativeImportsSkipped}; parse errors: ${st.parseHadErrors}`,
    );
  };

  context.subscriptions.push(
    log,
    interceptor,
    vscode.commands.registerCommand("pasteguard.showLog", () => log.show(true)),
    interceptor.onPaste((p) => {
      void handlePaste(p).catch((err) => log.appendLine(`[error] ${String(err)}`));
    }),
  );

  log.appendLine("PasteGuard active (Module 1: paste interceptor, Module 2: extractor).");
}

export function deactivate(): void {}
