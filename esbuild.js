const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** Extension host bundle (Node, vscode external). */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

/** Webview bundle (browser, includes Monaco). */
const webviewConfig = {
  entryPoints: ["webview/index.ts"],
  bundle: true,
  outfile: "dist/webview.js",
  platform: "browser",
  format: "iife",
  target: "es2020",
  sourcemap: !production,
  minify: production,
  loader: {
    ".ttf": "file",
  },
  logLevel: "info",
};

/** Monaco's editor worker, loaded by the webview at runtime. */
const workerConfig = {
  entryPoints: ["node_modules/monaco-editor/esm/vs/editor/editor.worker.js"],
  bundle: true,
  outfile: "dist/editor.worker.js",
  platform: "browser",
  format: "iife",
  target: "es2020",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

async function main() {
  const configs = [extensionConfig, webviewConfig, workerConfig];
  if (watch) {
    const ctxs = await Promise.all(configs.map((c) => esbuild.context(c)));
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log("[esbuild] watching...");
  } else {
    await Promise.all(configs.map((c) => esbuild.build(c)));
    console.log("[esbuild] build complete");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
