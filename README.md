# Merge Resolver

An **IntelliJ-style 3-way merge conflict resolver** for VS Code and Code OSS
forks (Kiro, Cursor, Windsurf, VSCodium).

When a merge, pull, or rebase leaves conflicts, Merge Resolver opens the file in
a three-pane view:

```
┌───────────────┬─────────────────────┬───────────────────┐
│ Yours (HEAD)  │  Result (editable)  │  Theirs (incoming)│
└───────────────┴─────────────────────┴───────────────────┘
```

- **Non-conflicting changes from both sides are merged automatically** (the
  "apply all non-conflicting changes" step is done up front via a diff3 merge).
- Each remaining conflict shows inline **Accept Yours / Accept Theirs / Accept
  Both** actions.
- Navigate conflicts with **Prev / Next**.
- **Save & Stage** writes the result to disk and runs `git add` to mark the file
  resolved.

## Usage

1. After a conflicting merge/pull/rebase, open the **Merge Resolver** view in the
   activity bar.
2. Click a conflicted file to open the 3-way merge.
3. Resolve each conflict, then **Save & Stage**.

## Development

```bash
npm install
npm run watch      # rebuild on change (extension + webview + Monaco worker)
npm run package    # produce a .vsix
```

Press `F5` in VS Code to launch an Extension Development Host.

## Notes

The three versions come from git's conflict stages — `:1` (base / common
ancestor), `:2` (ours / current), `:3` (theirs / incoming) — so it works for
any conflict git records, without parsing `<<<<<<<` markers from the file.
