# Merge Resolver

An **IntelliJ-style 3-way merge conflict resolver** for VS Code and Code OSS
forks (Kiro, Cursor, Windsurf, VSCodium).

When a merge, pull, or rebase leaves conflicts, Merge Resolver opens the file in
a three-pane view:

```
┌────────────────────┬──────────────────────┬────────────────────────┐
│ Changes from main  │   Result (editable)  │   Changes from feature │
└────────────────────┴──────────────────────┴────────────────────────┘
```

The three versions come straight from git's conflict stages — `:1` (base /
common ancestor), `:2` (ours / current), `:3` (theirs / incoming) — so it works
for any conflict git records, without parsing `<<<<<<<` markers out of the file.

## Features

- **Result starts as the base**, and every difference from it is shown as an
  applicable change: **green** for non-conflicting (only one side changed),
  **red** for conflicts (both sides changed).
- **Accept a side** with the `»` / `«` gutter arrows. Accepting one side of a
  conflict *inserts* it and leaves the other side available — accept both and
  they stack in the order you click. `✕` ignores a side.
- **Apply non-conflicting changes** — Left / All / Right — in one click, with
  live counts on each button.
- **Aligned panes** with synchronized vertical + horizontal scrolling and
  **curved connecting ribbons** between the changes.
- **Word-level highlighting** of what changed within a line.
- **Navigate** unresolved changes with the ↑ / ↓ buttons; a progress readout
  shows how much is left.
- **Reset** discards every accept/ignore and returns to base.
- **Save & Stage** writes the result and runs `git add` — enabled only once
  every change is resolved, so a half-resolved file can't be staged.

## Usage

1. After a conflicting merge / pull / rebase, open the **Merge Resolver** view in
   the activity bar — conflicted files are listed there.
2. Click a file to open the 3-way merge.
3. Resolve each change with the gutter arrows (or the Apply buttons), then
   **Save & Stage**.

## Settings

| Setting | Default | Description |
|---|---|---|
| `mergeResolver.engine` | `monaco` | Rendering engine. `monaco` is the full-featured view; `codemirror` uses CodeMirror 5's built-in `MergeView` as a lighter alternative. |

## Development

```bash
npm install
npm run watch      # rebuild on change (extension + webview + Monaco worker)
npm run package    # produce a .vsix
```

Press `F5` in VS Code / Kiro to launch an Extension Development Host.

## License

MIT
