# Publishing

The same `.vsix` publishes to both registries. Build it first:

```bash
npm run package        # produces merge-resolver-<version>.vsix
```

Bump `version` in `package.json` before each release.

---

## Open VSX (Kiro, Cursor, Windsurf, VSCodium)

Code OSS forks install from Open VSX, not the Microsoft Marketplace.

1. Sign in with GitHub: https://open-vsx.org
2. Sign the **Eclipse Publisher Agreement**: avatar → *Settings* → *Publisher Agreement*
3. Create an access token: https://open-vsx.org/user-settings/tokens
4. Claim the namespace once (must match the `publisher` field, `tofilagman`):

   ```bash
   npx ovsx create-namespace tofilagman -p <TOKEN>
   ```

5. Publish:

   ```bash
   npx ovsx publish merge-resolver-<version>.vsix -p <TOKEN>
   ```

Or drag-and-drop the `.vsix` in the web UI. Prefer `export OVSX_PAT=<TOKEN>`
(ovsx reads it automatically) over passing the token on the command line.

---

## VS Code Marketplace

1. Publisher page (drag-and-drop the `.vsix` here, no CLI needed):
   https://marketplace.visualstudio.com/manage/publishers/tofilagman
2. To use the CLI instead, create an Azure DevOps Personal Access Token:
   - https://dev.azure.com → User settings → *Personal Access Tokens*
   - Scope: **Marketplace → Manage**, organization: **All accessible organizations**
   - PAT guide: https://aka.ms/vscodepat
3. Publish:

   ```bash
   npx vsce login tofilagman     # paste the PAT once
   npx vsce publish
   ```

Docs: https://code.visualstudio.com/api/working-with-extensions/publishing-extension

---

## Notes

- The Marketplace only requires the extension **id** (`tofilagman.merge-resolver`)
  to be unique, which it is.
- `dist/webview.js` is large (~3.8 MB) because it bundles the Monaco editor;
  both registries accept this (it may print a size warning).
- Keep the two registries in sync — publish the same version to both.
