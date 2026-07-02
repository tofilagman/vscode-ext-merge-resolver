import * as vscode from "vscode";
import { ConflictsProvider, ConflictItem } from "./conflictsProvider";
import { MergePanel } from "./mergePanel";

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
        if (!item) {
          vscode.window.showWarningMessage(
            "Open a conflicted file from the Merge Resolver view."
          );
          return;
        }
        await MergePanel.show(context, item.repoRoot, item.file, () =>
          provider.refresh()
        );
      }
    )
  );

  // Keep the list current as the working tree changes.
  const watcher = vscode.workspace.createFileSystemWatcher("**/.git/index");
  watcher.onDidChange(() => provider.refresh());
  watcher.onDidCreate(() => provider.refresh());
  watcher.onDidDelete(() => provider.refresh());
  context.subscriptions.push(watcher);
}

export function deactivate(): void {
  // nothing to clean up
}
