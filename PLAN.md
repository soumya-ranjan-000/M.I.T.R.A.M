# M.I.T.R.A.M Implementation Plan

Standalone VS Code coding agent with its own webview UI. Chat + agent only (no ghost text in MVP).
Work top to bottom. Don't start a step until the previous step's **Done when** is true.

## Stack

- TypeScript, VS Code Extension API
- Bundler: esbuild (extension host), Vite + React (webview)
- Model: Claude API via `@anthropic-ai/sdk` behind a `ModelProvider` interface
- Tests: vitest (unit), `@vscode/test-electron` (integration)
- Package: `@vscode/vsce`

## Target folder structure

```
M.I.T.R.A.M/
├── package.json              # extension manifest + contributes
├── esbuild.js
├── src/
│   ├── extension.ts          # activate(), register commands/views
│   ├── webview/
│   │   ├── ChatViewProvider.ts   # hosts the webview, message bridge
│   │   └── protocol.ts           # typed host<->webview messages
│   ├── agent/
│   │   ├── AgentLoop.ts          # plan -> tool -> observe loop
│   │   ├── SystemPrompt.ts
│   │   └── ContextBuilder.ts
│   ├── providers/
│   │   ├── ModelProvider.ts      # interface
│   │   └── AnthropicProvider.ts
│   ├── tools/
│   │   ├── Tool.ts               # interface + registry
│   │   ├── readFile.ts  listDir.ts  searchFiles.ts
│   │   ├── editFile.ts  createFile.ts
│   │   ├── runCommand.ts  getDiagnostics.ts
│   │   └── approval.ts
│   ├── safety/
│   │   ├── workspaceGuard.ts     # path boundary checks
│   │   ├── commandPolicy.ts      # denylist / allowlist
│   │   └── checkpoints.ts        # undo per agent turn
│   └── storage/  secrets.ts  sessions.ts  settings.ts
├── webview-ui/               # Vite + React app
│   └── src/ App.tsx  components/{Message,ToolCard,DiffCard,Composer}.tsx
└── test/
```

---

## Phase 0: Scaffold (days 1-3)

- [x] **0.1** Install Node 20+, run `npx yo code` (TypeScript, esbuild). Name: `mitram`.
- [x] **0.2** Set up git (`git init`), `.gitignore`, ESLint, Prettier.
- [x] **0.3** Register a sidebar view container in `package.json` (`viewsContainers.activitybar` + `views`, type `webview`).
- [x] **0.4** Create `ChatViewProvider` implementing `WebviewViewProvider`. Set a strict CSP with nonce; load the built webview bundle via `asWebviewUri`.
- [x] **0.5** Create `webview-ui/` with Vite + React. Build output to `webview-ui/dist`. Add npm scripts: `dev`, `build`, `watch`.
- [x] **0.6** Define `protocol.ts`: discriminated unions for `HostToWebview` and `WebviewToHost` messages (`sendMessage`, `streamDelta`, `streamEnd`, `toolCall`, `error`, ...). Add a tiny typed `postMessage` wrapper on both sides.
- [x] **0.7** Add F5 launch config; confirm the panel opens in the Extension Development Host.

**Done when:** typing in the webview round-trips to the host and echoes back.

## Phase 1: Chat MVP (week 1-2)

- [x] **1.1** `ModelProvider` interface: `stream(messages, tools, signal) -> AsyncIterable<Event>` where events are `text_delta | tool_use | stop | usage`.
- [x] **1.2** `AnthropicProvider`: implement with streaming; map SDK events to your event type. Read `claude-api` docs for current model IDs and params; make the model name a setting.
- [x] **1.3** API key: command `MITRAM: Set API Key` -> `context.secrets.store`. Never log keys.
- [x] **1.4** Wire the composer -> host -> provider -> `streamDelta` to the UI. Add a Stop button (AbortController).
- [x] **1.5** Render markdown with code highlighting (`react-markdown` + `shiki` or `highlight.js`). Code block actions: Copy, Insert at cursor.
- [x] **1.6** Context attachments: auto-attach active file path + selection; `@file` picker in composer (use `workspace.findFiles`).
- [x] **1.7** Session persistence: save messages to `globalStorageUri` JSON; sessions list, New chat, delete.
- [x] **1.8** Error states: no key, network failure, rate limit, with a retry button.

**Done when:** you can hold a streamed multi-turn conversation about the open file, stop mid-stream, reload the window, and see history.

## Phase 2: Agent core (week 3-5)

- [x] **2.1** `Tool` interface: `{ name, description, inputSchema (JSON Schema), requiresApproval, run(input, ctx) -> result }`. Central `ToolRegistry`.
- [x] **2.2** `workspaceGuard`: resolve every path against workspace root, reject `..` escapes and symlinks leaving the root. **All tools must go through it.**
- [x] **2.3** Read-only tools: `read_file` (with line ranges, size cap), `list_dir`, `search_files` _(implemented as a Node directory walk, not ripgrep)_, `get_diagnostics` (`languages.getDiagnostics`).
- [x] **2.4** `AgentLoop`:
  1. send messages + tool defs
  2. collect `tool_use` blocks
  3. run tools (parallel if independent)
  4. append `tool_result`s
  5. repeat until `stop` with no tool calls
     Guards: max 25 iterations, abort signal, per-tool timeout, catch tool errors and return them as `is_error` results (don't crash the loop).
- [x] **2.5** UI `ToolCard`: name, input summary, status (running/ok/error), expandable output.
- [x] **2.6** Write `SystemPrompt`: role, tool-use guidance (read before edit, small edits, verify with diagnostics), workspace info, OS, date.
- [x] **2.7** `edit_file` tool: `{ path, old_string, new_string }`, exact match, must be unique, else return an error telling the model to add context. `create_file` for new files. Apply edits via `WorkspaceEdit` so undo works in the editor.
- [x] **2.8** `run_command`: run via VS Code terminal shell integration (`onDidEndTerminalShellExecution`) or fallback to `child_process` with a timeout and output cap (truncate the middle).

**Done when:** "add a unit test for function X" works end to end: the agent searches, reads, edits, runs the tests, and fixes a failure.

## Phase 3: Safety and trust (week 5-6)

- [x] **3.1** Approval gate: reads auto-run; edits and commands pause the loop and show Approve / Reject / Always allow in the webview. Rejection is returned to the model as a tool result.
- [x] **3.2** Diff preview: for `edit_file`, open `vscode.diff` against a virtual document (`TextDocumentContentProvider`) before applying; apply only on approval.
- [x] **3.3** `commandPolicy`: denylist (`rm -rf /`, `sudo`, `curl | sh`, force push, etc.), always require approval for anything not on the allowlist; setting to configure.
- [x] **3.4** Checkpoints: before each agent turn that edits files, snapshot the touched files in memory/storage; add a "Revert this turn" button.
- [x] **3.5** Treat tool output as untrusted: file contents and command output can contain prompt injection. Keep them in `tool_result` blocks only, and never auto-approve based on their content.
- [x] **3.6** Settings: auto-approve reads (default on), auto-approve edits (default off), skip approval prompts for edits and commands (default off; blocked commands remain blocked), max iterations.

**Done when:** no file write or command executes without the approval your settings require; revert restores files exactly.

## Phase 4: Context quality and cost (week 7-8)

- [x] **4.1** Token budgeting: count tokens (SDK token counting endpoint or estimate); show usage in the UI.
- [x] **4.2** Context management: truncate large tool results, drop/summarise oldest turns when over ~70% of the window.
- [x] **4.3** Prompt caching: mark the system prompt + tool definitions as cacheable; confirm cache hits in usage stats.
- [x] **4.4** Project instructions: load `MITRAM.md` from the workspace root and append it to the system prompt.
- [x] **4.5** `ContextBuilder`: include open editor tabs, git branch + short `git diff --stat`, and recent diagnostics.
- [x] **4.6** Eval harness (`test/evals/`): 20-30 small tasks in fixture repos with pass/fail checks (tests pass, file contains X). Run before every release to catch regressions.
- [x] **4.7** Pre-analysis retrieval: a local keyword index (BM25, identifiers, word forms, synonyms) attaches likely-relevant files and excerpts to each message, with a gate for chatter, a "related files" card, and `npm run bench:retrieval`. Results and limits: [`docs/code-retrieval.md`](docs/code-retrieval.md). _(on independently written requests it is no better than one well-chosen search yet; measuring the agent effect is next)_

**Done when:** a 50-turn session on a mid-size repo doesn't overflow, and eval pass rate is recorded as a baseline.

## Phase 5: Polish and release (week 9-10)

- [x] **5.1** Model picker + settings UI (model, max tokens, temperature if applicable). _(model list is configured, not fetched: Foundry has no models endpoint; temperature skipped because current Claude models reject it)_
- [x] **5.2** Plan mode: agent proposes a plan, the user approves, and then it executes with edit tools enabled.
- [x] **5.3** Slash commands in composer (`/clear`, `/undo`, `/plan`, `/model`).
- [x] **5.4** Keyboard shortcuts, theme-aware styling (use VS Code CSS variables), accessibility pass.
- [x] **5.5** Opt-in telemetry and error reporting; privacy statement in README. _(done as local redacted logs, a diagnostics command and a privacy statement; there is no network telemetry because there is no endpoint to send it to)_
- [x] **5.6** Tests: unit tests for tools + `workspaceGuard` + `commandPolicy` (security-critical, aim for high coverage); integration test that drives the agent against a fake `ModelProvider`. _(safety modules ~98% line coverage, everything testable ~95%)_
- [x] **5.7** Package: icon, README with GIFs, CHANGELOG, `vsce package`, install the `.vsix` locally on a clean profile. _(packaged and the shipped bundle activates under a stubbed vscode; still to do: a real install on a clean profile, README screenshots/GIFs, LICENSE)_
- [ ] **5.8** Publish to the VS Code Marketplace and Open VSX.

**Done when:** a stranger can install the `.vsix`, add a key, and complete a task without help.

## Phase 6: Long-running tasks

- [x] **6.1** Plan board: `update_board` tool, per-chat board saved with the session, shown live in the UI, and appended to every request after the cache breakpoint so it survives trimming.
- [x] **6.2** Verify before done: a run tracker notices unverified edits and unfinished tasks and sends the agent back (max two reminders, skipped if the user refused a check).
- [x] **6.3** Budgets: step and time limits that pause with a Continue button; Continue keeps the revert point.
- [x] **6.4** Stuck detection: warn on the third identical result, stop on the fifth.
- [x] **6.5** Summaries instead of dropping old turns (rolling, falls back to dropping).
- [x] **6.6** Five longer eval tasks, including one that only passes if the agent runs the tests.
- [ ] **6.7** Run the eval set against the real deployment and save a baseline; try a real 50-step task.

**Done when:** the baseline shows the long tasks passing on your model.

## Phase 7: MCP client

Connect to user-configured MCP servers and expose their tools to the agent loop as ordinary
`Tool` objects. Full design, file layout and risks: **[`docs/mcp-plan.md`](docs/mcp-plan.md)**.

- [x] **7.0** Add `@modelcontextprotocol/sdk` to `dependencies`; confirm esbuild bundles it for `node20` with no dynamic-require warnings before building on it.
- [x] **7.1** `mitram.mcpServers` setting (scope `application`) + `src/mcp/config.ts`: validate entries, `${env:NAME}` expansion, secrets via `SecretStore`.
- [x] **7.2** `McpClient`: connect (stdio, streamable HTTP **and SSE**) with timeouts, `listTools`, `callTool`, status, `close()`.
- [x] **7.3** `mcpTool.ts`: wrap an MCP tool as a `Tool` (`mcp__<server>__<tool>`, args in the preview, text flattening, truncation, server errors → `is_error`).
- [x] **7.4** `McpManager`: lifecycle, parallel lazy connect, restart on settings change, dispose kills every child process.
- [x] **7.5** `createRegistry(mcp)` (async) used by `ChatViewProvider.run()`; cap total MCP tools; plan mode still filters them out.
- [x] **7.6** Safety: per-workspace trust prompt, `isAutoApproved` branch for `mcp__…`, `mitram.blockedMcpTools`, untrusted-output line in the system prompt, argument-free logging.
- [x] **7.7** UI: MCP badge on tool cards, server status + Reconnect, `/mcp` slash command, protocol validators and tests.
- [x] **7.8** README + CHANGELOG + smoke tests driving real spawned servers (`npm run smoke:mcp`, `npm run smoke:mcp:playwright`).
- [x] **7.9** _(added)_ **MCP servers panel** in the chat view — add, remove, enable, set an API key, reconnect — with the add wizard and key prompt in the extension host, plus a preset catalogue (Playwright, GitHub, Filesystem, Atlassian, PostgreSQL, Sentry).

**Done:** a configured server's tool runs end to end behind an approval gate, a failing server
never breaks a run, no child process survives `deactivate()`, and with zero servers configured
nothing about today's behaviour changes. Verified by 147 unit tests plus two smoke tests against
real spawned servers (a local stdio server and `@playwright/mcp`, 25 tools).

## Phase 8: Sub-agents

Hand a self-contained piece of work to a sub-agent with its own context, tools and brief, so a
long investigation does not fill the main conversation. Only the final report comes back.

- [x] **8.1** `delegate_task` tool: validated input, `explore` / `implement` modes, preview badge saying whether the sub-agent can change anything.
- [x] **8.2** `subagents.ts`: a `Slots` semaphore for parallelism (`mitram.maxParallelSubagents`, 3 by default), releasing its slot on failure and on abort.
- [x] **8.3** Tool scoping: `subagentTools()` gives `explore` read-only tools only, and never hands any sub-agent the plan board or `delegate_task` itself, so work cannot fan out without end.
- [x] **8.4** `buildSubagentPrompt()`: a brief-only history, no knowledge of the main conversation, and a report as the final reply.
- [x] **8.5** UI: nested tool cards indented under the delegation card, with a queued note while a sub-agent waits for a slot.
- [x] **8.6** Settings `mitram.subagents` and `mitram.maxParallelSubagents`; plan mode offers `explore` only.
- [x] **8.7** 34 unit tests covering concurrency, slot release on throw and abort, tool filtering, input validation and report assembly.

**Done:** sub-agents run in parallel behind the same approval gates as the main agent, cannot
recurse or touch the board, and are told to be verified rather than trusted.

## Post-MVP backlog (don't touch before Phase 5 is done)

- More providers (OpenAI-compatible, Ollama), via `ModelProvider`
- MCP resources and prompts; M.I.T.R.A.M **as** an MCP server (see `docs/mcp-plan.md`, "Later")
- Embedding-based code search
- Ghost-text inline completion (previously cut from MVP)

## Weekly rhythm

1. Pick the next unchecked step.
2. Write the test or manual-verification script first when the step is a tool.
3. Run the eval set at the end of every phase.
4. Commit per step with a message naming the step number (e.g. `feat(tools): 2.3 read-only tools`).
