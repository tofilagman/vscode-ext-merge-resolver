import * as vscode from "vscode";
import * as path from "path";
import { getRepoRoot, listConflicts } from "./git";
import type { ConflictFile } from "./git";

export class ConflictItem extends vscode.TreeItem {
  constructor(
    public readonly repoRoot: string,
    public readonly file: ConflictFile
  ) {
    super(path.basename(file.relativePath), vscode.TreeItemCollapsibleState.None);
    this.description = path.dirname(file.relativePath);
    this.resourceUri = vscode.Uri.file(file.absolutePath);
    this.contextValue = "conflict";
    this.iconPath = new vscode.ThemeIcon("git-merge");
    this.tooltip = file.relativePath;
    this.command = {
      command: "mergeResolver.resolve",
      title: "Open 3-Way Merge",
      arguments: [this],
    };
  }
}

export class ConflictsProvider
  implements vscode.TreeDataProvider<ConflictItem>
{
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(element: ConflictItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<ConflictItem[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const seenRoots = new Set<string>();
    const items: ConflictItem[] = [];
    for (const folder of folders) {
      try {
        const repoRoot = await getRepoRoot(folder.uri.fsPath);
        if (seenRoots.has(repoRoot)) {
          continue;
        }
        seenRoots.add(repoRoot);
        const conflicts = await listConflicts(repoRoot);
        items.push(...conflicts.map((c) => new ConflictItem(repoRoot, c)));
      } catch {
        // folder is not inside a git repository — skip it
      }
    }
    return items;
  }
}
