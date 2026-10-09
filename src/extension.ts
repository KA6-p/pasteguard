import * as vscode from "vscode";
import { PasteInterceptor } from "./pasteInterceptor";

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("PasteGuard");
  const interceptor = new PasteInterceptor(log);

  context.subscriptions.push(
    log,
    interceptor,
    vscode.commands.registerCommand("pasteguard.showLog", () => log.show(true)),

    // Module 1 output. Later modules (parser, package checks, rules) subscribe here.
    interceptor.onPaste((p) => {
      const where = `${p.range.start.line + 1}:${p.range.start.character + 1}-${p.range.end.line + 1}:${p.range.end.character + 1}`;
      log.appendLine(
        `[paste] ${p.source} | ${p.lineCount} line(s), ${p.text.length} chars | ${vscode.workspace.asRelativePath(p.uri)} ${where}`,
      );
      vscode.window.setStatusBarMessage(`PasteGuard: detected a ${p.lineCount}-line paste`, 2500);
    }),
  );

  log.appendLine("PasteGuard active (Module 1: paste interceptor).");
}

export function deactivate(): void {}
