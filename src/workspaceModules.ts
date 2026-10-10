import * as vscode from "vscode";

const MAX_CLIMB = 6;

async function namesIn(dir: vscode.Uri, into: Set<string>): Promise<void> {
  try {
    for (const [name, type] of await vscode.workspace.fs.readDirectory(dir)) {
      if (type & vscode.FileType.Directory) {
        if (!name.startsWith(".")) {
          into.add(name.toLowerCase());
        }
      } else if (name.endsWith(".py") || name.endsWith(".pyi")) {
        into.add(name.replace(/\.pyi?$/, "").toLowerCase());
      }
    }
  } catch {
    // Unreadable or missing folder: ignore.
  }
}

/**
 * Names of modules that live in the user's own project near the edited file, so `import utils`
 * is not mistaken for a PyPI package. Looks at the file's folder, its parents up to the workspace
 * root, the workspace roots, and a top-level `src` folder.
 */
export async function collectLocalModuleNames(fileUri: vscode.Uri): Promise<Set<string>> {
  const names = new Set<string>();
  const dirs: vscode.Uri[] = [];
  const roots = vscode.workspace.workspaceFolders?.map((f) => f.uri) ?? [];

  if (fileUri.scheme === "file") {
    let dir = vscode.Uri.joinPath(fileUri, "..");
    for (let i = 0; i < MAX_CLIMB; i++) {
      dirs.push(dir);
      if (roots.some((r) => r.toString() === dir.toString())) {
        break;
      }
      const parent = vscode.Uri.joinPath(dir, "..");
      if (parent.toString() === dir.toString()) {
        break;
      }
      dir = parent;
    }
  }
  for (const r of roots) {
    dirs.push(r, vscode.Uri.joinPath(r, "src"));
  }
  await Promise.all(dirs.map((d) => namesIn(d, names)));
  return names;
}
