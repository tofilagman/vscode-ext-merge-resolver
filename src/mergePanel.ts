import * as vscode from "vscode";
import * as fs from "fs/promises";
import { buildMergeModel } from "./merge";
import { readThreeWay, stageResolved, getMergeBranches } from "./git";
import type { ConflictFile } from "./git";
import type { HostMessage, WebviewMessage } from "./protocol";

/**
 * Opens and manages a single 3-way merge webview panel. One panel per
 * conflicted file, keyed by absolute path so re-opening focuses the existing
 * one instead of stacking duplicates.
 */
export class MergePanel {
  private static readonly viewType = "mergeResolver.merge";
  private static readonly open = new Map<string, MergePanel>();

  static async show(
    context: vscode.ExtensionContext,
    repoRoot: string,
    file: ConflictFile,
    onResolved: () => void
  ): Promise<void> {
    const existing = MergePanel.open.get(file.absolutePath);
    if (existing) {
      existing.panel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      MergePanel.viewType,
      `Merge: ${file.relativePath}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")],
      }
    );

    const instance = new MergePanel(
      context,
      panel,
      repoRoot,
      file,
      onResolved
    );
    MergePanel.open.set(file.absolutePath, instance);
    await instance.init();
  }

  private disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly panel: vscode.WebviewPanel,
    private readonly repoRoot: string,
    private readonly file: ConflictFile,
    private readonly onResolved: () => void
  ) {
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => this.handleMessage(msg),
      null,
      this.disposables
    );
  }

  private async init(): Promise<void> {
    const { ours, base, theirs } = await readThreeWay(
      this.repoRoot,
      this.file.relativePath
    );
    const model = buildMergeModel(ours, base, theirs);
    const branches = await getMergeBranches(this.repoRoot);

    const webview = this.panel.webview;
    const asWebviewUri = (file: string) =>
      webview
        .asWebviewUri(
          vscode.Uri.joinPath(this.context.extensionUri, "dist", file)
        )
        .toString();

    this.initMessage = {
      type: "init",
      relativePath: this.file.relativePath,
      ours,
      base,
      theirs,
      oursLabel: branches.ours,
      theirsLabel: branches.theirs,
      model,
      workerUri: asWebviewUri("editor.worker.js"),
    };

    this.panel.webview.html = this.getHtml(webview);
  }

  private initMessage: HostMessage | undefined;

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        if (this.initMessage) {
          this.panel.webview.postMessage(this.initMessage);
        }
        return;
      case "save":
        await this.save(msg.content);
        return;
      case "info":
        vscode.window.showInformationMessage(msg.text);
        return;
    }
  }

  private async save(content: string): Promise<void> {
    await fs.writeFile(this.file.absolutePath, content, "utf8");
    await stageResolved(this.repoRoot, this.file.relativePath);
    vscode.window.showInformationMessage(
      `Resolved and staged ${this.file.relativePath}`
    );
    this.onResolved();
    this.panel.dispose();
  }

  private getHtml(webview: vscode.Webview): string {
    const engine = vscode.workspace
      .getConfiguration("mergeResolver")
      .get<string>("engine", "monaco");
    return engine === "codemirror"
      ? this.getCodeMirrorHtml(webview)
      : this.getMonacoHtml(webview);
  }

  private csp(webview: vscode.Webview, nonce: string): string {
    return [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
      `worker-src ${webview.cspSource} blob:`,
    ].join("; ");
  }

  private asset(webview: vscode.Webview, file: string): string {
    return webview
      .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", file))
      .toString();
  }

  private getCodeMirrorHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${this.csp(webview, nonce)}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${this.asset(webview, "webview-cm.css")}" rel="stylesheet" />
  <title>Merge Resolver (CodeMirror)</title>
</head>
<body>
  <div id="toolbar">
    <span id="title"></span>
    <span class="tb-label">Yours ◂ Result ▸ Theirs — use the ◂ ▸ arrows to apply a side</span>
    <span class="spacer"></span>
    <button id="save" class="primary" title="Save & stage">Save &amp; Stage</button>
  </div>
  <div id="mergeview"></div>
  <script nonce="${nonce}" src="${this.asset(webview, "webview-cm.js")}"></script>
</body>
</html>`;
  }

  private getMonacoHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = this.asset(webview, "webview.js");
    const styleUri = this.asset(webview, "webview.css");
    const csp = this.csp(webview, nonce);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Merge Resolver</title>
</head>
<body>
  <div id="toolbar">
    <button id="prev" class="icon" title="Previous change">↑</button>
    <button id="next" class="icon" title="Next change">↓</button>
    <span class="sep"></span>
    <span class="tb-label">Apply non-conflicting changes:</span>
    <button id="apply-left" title="Apply non-conflicting changes from the left">» Left</button>
    <button id="apply-all" title="Apply all non-conflicting changes">«» All</button>
    <button id="apply-right" title="Apply non-conflicting changes from the right">« Right</button>
    <span class="spacer"></span>
    <span id="status"></span>
    <button id="save" class="primary" title="Save & stage">Save &amp; Stage</button>
  </div>
  <div id="headers">
    <div class="header" id="ours-title">Changes</div>
    <div class="header center"><span id="result-title">Result</span></div>
    <div class="header" id="theirs-title">Changes</div>
  </div>
  <div id="panes">
    <div class="pane"><div id="ours" class="editor"></div></div>
    <div class="gutter"><svg id="svg-l" preserveAspectRatio="none"></svg></div>
    <div class="pane"><div id="result" class="editor"></div></div>
    <div class="gutter"><svg id="svg-r" preserveAspectRatio="none"></svg></div>
    <div class="pane"><div id="theirs" class="editor"></div></div>
  </div>
  <div id="done-toast" class="toast hidden">
    <span class="toast-check">✓</span>
    <span class="toast-text">All changes processed.</span>
    <button id="toast-save">Save &amp; Stage</button>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    MergePanel.open.delete(this.file.absolutePath);
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function getNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
