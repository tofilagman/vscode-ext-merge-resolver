import * as vscode from "vscode";
import * as path from "path";
import { ConflictsProvider, ConflictItem } from "./conflictsProvider";
import { MergePanel } from "./mergePanel";
import { getRepoRoot, listConflicts } from "./git";
import type { ConflictFile } from "./git";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ConflictsProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(
      "mergeResolver.conflicts",
      provider
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mergeResolver.refresh", () =>
      provider.refresh()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "mergeResolver.resolve",
      async (item?: ConflictItem) => {
        const target = item ?? (await conflictFromActiveEditor());
        if (!target) {
          vscode.window.showWarningMessage(
            "No conflicted file selected. Open one from the Merge Resolver view, or focus a conflicted file first."
          );
          return;
        }
        await MergePanel.show(context, target.repoRoot, target.file, () =>
          provider.refresh()
        );
      }
    )
  );

  // Keep the list current as the working tree changes. Index updates come in
  // bursts (e.g. during a merge or rebase), so coalesce them into one refresh.
  let refreshTimer: NodeJS.Timeout | undefined;
  const refreshSoon = () => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => provider.refresh(), 250);
  };
  const watcher = vscode.workspace.createFileSystemWatcher("**/.git/index");
  watcher.onDidChange(refreshSoon);
  watcher.onDidCreate(refreshSoon);
  watcher.onDidDelete(refreshSoon);
  context.subscriptions.push(watcher, {
    dispose: () => refreshTimer && clearTimeout(refreshTimer),
  });
}

/** Resolve the active editor's file to a conflict entry, if it is one. */
async function conflictFromActiveEditor(): Promise<
  { repoRoot: string; file: ConflictFile } | undefined
> {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc || doc.uri.scheme !== "file") {
    return undefined;
  }
  try {
    const repoRoot = await getRepoRoot(path.dirname(doc.uri.fsPath));
    const conflicts = await listConflicts(repoRoot);
    const file = conflicts.find((c) => c.absolutePath === doc.uri.fsPath);
    return file ? { repoRoot, file } : undefined;
  } catch {
    return undefined;
  }
}

export function deactivate(): void {
  // nothing to clean up
}
