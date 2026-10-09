/**
 * Pure paste-detection logic. No VS Code imports, so it is unit-testable with plain Node.
 *
 * VS Code has no "this was a paste" event that includes the final inserted range, so we
 * classify document changes: a single, reasonably large insertion is treated as a paste.
 * This also catches "insert at cursor" buttons in AI chat panels, which is desirable.
 */

export interface DetectorOptions {
  /** Ignore inserted text shorter than this many characters. */
  minChars: number;
  /** Inserts with at least this many lines count as pastes. */
  minLines: number;
  /** A single-line insert at least this long also counts (e.g. a long install command). */
  singleLineChars: number;
  /** Above this size we skip scanning entirely. */
  maxChars: number;
}

export const DEFAULT_OPTIONS: DetectorOptions = {
  minChars: 40,
  minLines: 2,
  singleLineChars: 60,
  maxChars: 200_000,
};

export interface ChangeInfo {
  /** The text that was inserted. */
  text: string;
  /** Length of the text that was replaced (0 for a pure insertion). */
  replacedLength: number;
}

export type Verdict =
  | { paste: true; lineCount: number }
  | { paste: false; reason: string };

export interface Position {
  line: number;
  character: number;
}

export function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

/** Number of lines, ignoring trailing newlines. Empty text is 0 lines. */
export function countLines(text: string): number {
  const t = normalizeNewlines(text).replace(/\n+$/, "");
  return t.length === 0 ? 0 : t.split("\n").length;
}

/** Decide whether a document change looks like a paste. */
export function classify(change: ChangeInfo, opts: DetectorOptions = DEFAULT_OPTIONS): Verdict {
  const { text, replacedLength } = change;

  if (text.trim().length === 0) {
    return { paste: false, reason: "whitespace only" };
  }
  if (text.length > opts.maxChars) {
    return { paste: false, reason: "too large" };
  }
  if (text.length < opts.minChars) {
    return { paste: false, reason: "too short" };
  }
  // A big replacement of similar size is almost always a formatter or refactor, not a paste.
  if (replacedLength >= opts.minChars && replacedLength > text.length * 0.5) {
    return { paste: false, reason: "looks like a rewrite (formatter/refactor)" };
  }

  const lineCount = countLines(text);
  if (lineCount < opts.minLines && text.length < opts.singleLineChars) {
    return { paste: false, reason: "short single line" };
  }
  return { paste: true, lineCount };
}

/** True if the inserted text equals the clipboard contents (ignoring newline style and edge whitespace). */
export function matchesClipboard(inserted: string, clipboard: string | undefined): boolean {
  if (clipboard === undefined) {
    return false;
  }
  return normalizeNewlines(inserted).trim() === normalizeNewlines(clipboard).trim();
}

/** Where the inserted text ends, given where it starts. Handles LF and CRLF. */
export function computeEndPosition(startLine: number, startCharacter: number, text: string): Position {
  const parts = normalizeNewlines(text).split("\n");
  if (parts.length === 1) {
    return { line: startLine, character: startCharacter + parts[0].length };
  }
  return { line: startLine + parts.length - 1, character: parts[parts.length - 1].length };
}
