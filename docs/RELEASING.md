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

## Azure Pipelines (CI)

`azure-pipelines.yml` installs, type-checks, tests (with coverage) and packages the extension on every push to
`main`/`master`, and publishes the `.vsix` as a pipeline artifact. It never calls a model (`npm run eval` is not run).

Set it up once:
1. Push `azure-pipelines.yml` to the repository's `main` (or `master`) branch.
2. In Azure DevOps: **Pipelines > New pipeline**, pick the repo, then **Existing Azure Pipelines YAML file** and choose `/azure-pipelines.yml`.
3. Run it. The packaged `.vsix` appears under the run's **Artifacts** as `vsix`.
4. To require a build before merging, add a branch policy on `main` that runs this pipeline (the file has `pr: none` because Azure Repos pull requests are validated by policy).

New Azure DevOps organizations sometimes have no free hosted build capacity until you request it. If the first run
waits with a message about hosted parallelism, request the free grant (https://aka.ms/azpipelines-parallelism-request)
or use a self-hosted agent.

Publishing from the pipeline (optional, off by default):
1. Create a pipeline variable `VSCE_PAT` marked **secret**, holding a personal access token with the **Marketplace > Manage** scope
   (create it for **All accessible organizations**).
2. Create an environment named `vscode-marketplace` (Pipelines > Environments) and add an **Approvals** check, so a person approves each release.
3. Run the pipeline manually from `main`/`master` and tick **Publish to the VS Code Marketplace**.

The `publisher` in `package.json` must be the ID of a publisher you own, or publishing fails.
