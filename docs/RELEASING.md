# Releasing

One-time setup
1. Create a publisher at https://marketplace.visualstudio.com/manage and note its ID.
2. Create an Azure DevOps personal access token with the **Marketplace → Manage** scope.
3. In `package.json`, set `publisher` to your publisher ID (it is currently the placeholder `mitram`), and add `repository` and `license`.
4. Add a `LICENSE` file, then remove `--skip-license` and `--allow-missing-repository` from the `package` script.

Each release
1. Update `version` in `package.json` and add an entry to `CHANGELOG.md`.
2. `npm test` and `npm run test:coverage`.
3. `npm run eval -- --yes` and compare with the saved baseline (save a new one with `--save-baseline` if the change is intended).
4. `npm run package`, then install the `.vsix` into a clean profile and try the first-run flow:
   `code --user-data-dir /tmp/clean --extensions-dir /tmp/clean-ext --install-extension mitram-<version>.vsix`
5. `npx vsce login <publisher>` and `npx vsce publish`.
6. For Open VSX: `npx ovsx publish mitram-<version>.vsix -p <token>`.
