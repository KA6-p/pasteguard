import * as vscode from "vscode";
import {
  classify,
  computeEndPosition,
  DEFAULT_OPTIONS,
  DetectorOptions,
  matchesClipboard,
} from "./pasteDetector";

/** What Module 1 hands to the rest of the pipeline. */
export interface PasteEvent {
  uri: vscode.Uri;
  /** Exact range of the inserted text, in the document after the paste. */
  range: vscode.Range;
  text: string;
  /** "clipboard" = matches the clipboard (a real paste); "insert" = other insertion (e.g. chat button). */
  source: "clipboard" | "insert";
  lineCount: number;
  /** Document version right after the paste; later modules use it to drop stale results. */
  documentVersion: number;
}

export class PasteInterceptor implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<PasteEvent>();
  /** Subscribe to detected pastes. */
  readonly onPaste = this.emitter.event;

  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly log: vscode.OutputChannel) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        void this.handle(e).catch((err) => this.log.appendLine(`[error] ${String(err)}`));
      }),
    );
  }

  private readOptions(): DetectorOptions {
    const cfg = vscode.workspace.getConfiguration("pasteguard");
    return {
      minChars: cfg.get<number>("minChars", DEFAULT_OPTIONS.minChars),
      minLines: cfg.get<number>("minLines", DEFAULT_OPTIONS.minLines),
      singleLineChars: cfg.get<number>("singleLineChars", DEFAULT_OPTIONS.singleLineChars),
      maxChars: cfg.get<number>("maxChars", DEFAULT_OPTIONS.maxChars),
    };
  }

  private async handle(e: vscode.TextDocumentChangeEvent): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("pasteguard");
    if (!cfg.get<boolean>("enabled", true)) {
      return;
    }

    const doc = e.document;
    if (doc.languageId !== "python") {
      return;
    }
    if (doc.uri.scheme !== "file" && doc.uri.scheme !== "untitled") {
      return;
    }
    if (
      e.reason === vscode.TextDocumentChangeReason.Undo ||
      e.reason === vscode.TextDocumentChangeReason.Redo
    ) {
      return;
    }
    // Pastes are a single contiguous change; multi-change events are usually formatters or multi-cursor typing.
    if (e.contentChanges.length !== 1) {
      return;
    }

    const change = e.contentChanges[0];
    const verdict = classify({ text: change.text, replacedLength: change.rangeLength }, this.readOptions());
    if (!verdict.paste) {
      return;
    }

    // Only read the clipboard once we already think it's a paste (cheap path for normal typing).
    const clipboard = await vscode.env.clipboard.readText();
    const source = matchesClipboard(change.text, clipboard) ? "clipboard" : "insert";

    const start = change.range.start;
    const end = computeEndPosition(start.line, start.character, change.text);
    const event: PasteEvent = {
      uri: doc.uri,
      range: new vscode.Range(start, new vscode.Position(end.line, end.character)),
      text: change.text,
      source,
      lineCount: verdict.lineCount,
      documentVersion: doc.version,
    };
    this.emitter.fire(event);
  }

  dispose(): void {
    this.emitter.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
