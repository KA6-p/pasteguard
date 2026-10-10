import Parser from "web-tree-sitter";

export interface PythonParserOptions {
  /** Override where tree-sitter's own runtime wasm lives (needed once the extension is bundled). */
  runtimeWasm?: string;
  /** Override where the Python grammar wasm lives. */
  grammarWasm?: string;
}

/**
 * Loads tree-sitter + the Python grammar once. tree-sitter is error-tolerant, so half-broken
 * pasted snippets still produce a usable tree (which is why we use it instead of a strict parser).
 */
export class PythonParser {
  private constructor(private readonly parser: Parser) {}

  static async create(opts: PythonParserOptions = {}): Promise<PythonParser> {
    await Parser.init(opts.runtimeWasm ? { locateFile: () => opts.runtimeWasm as string } : undefined);
    const grammarPath = opts.grammarWasm ?? require.resolve("tree-sitter-wasms/out/tree-sitter-python.wasm");
    const language = await Parser.Language.load(grammarPath);
    const parser = new Parser();
    parser.setLanguage(language);
    return new PythonParser(parser);
  }

  /** The caller must call tree.delete() when done (the tree lives in wasm memory). */
  parse(code: string): Parser.Tree {
    const tree = this.parser.parse(code);
    if (!tree) {
      throw new Error("tree-sitter returned no tree");
    }
    return tree;
  }
}
