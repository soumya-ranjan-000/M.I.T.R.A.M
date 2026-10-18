# MCP support in M.I.T.R.A.M

> **Status: proposed.** This is the plan for Phase 7 in `PLAN.md` ("MCP client support" in the
> post-MVP backlog). Nothing here is implemented yet.

## Scope

M.I.T.R.A.M becomes an **MCP client/host**: it connects to MCP servers the user configures
(filesystem, GitHub, Postgres, Playwright, company-internal servers…) and exposes their **tools**
to the agent loop as ordinary `Tool` objects. Server **resources** and **prompts** come later;
tools are what the agent loop already understands.

Out of scope for this plan (noted at the end): shipping M.I.T.R.A.M itself *as* an MCP server
that other clients call.

## Why it fits cleanly

The agent loop never sees tools concretely — it only uses `ToolRegistry.definitions()` and
`registry.get(name).run(input, ctx)` (`src/agent/AgentLoop.ts:70,210,258`). So an MCP tool is just
another object implementing `Tool` (`src/tools/Tool.ts:45`). The work is almost entirely in three
places:

| Concern | Today | With MCP |
| --- | --- | --- |
| Registry construction | `createDefaultRegistry()`, sync (`src/tools/index.ts`) | needs an async step that adds connected servers' tools |
| Approval | keyed by tool name (`src/safety/approvalPolicy.ts`) | needs per-server/per-tool rules |
| `readOnly()` for plan mode | `!requiresApproval` (`src/tools/Tool.ts:81`) | MCP tools default to "needs approval", so plan mode stays safe automatically |

## Design decisions

1. **Tool naming.** `mcp__<server>__<tool>`, e.g. `mcp__github__create_issue`. The API requires
   `^[a-zA-Z0-9_-]{1,64}$`, so server and tool names are sanitised (non-matching chars → `_`) and
   the tool part is truncated to fit 64 chars. A collision with a built-in name is impossible
   because of the `mcp__` prefix; collisions between servers are impossible because the server id
   is in the name.
2. **Everything needs approval by default.** `requiresApproval: true` unless the server declares
   `annotations.readOnlyHint === true` **and** the user has enabled auto-approve for reads on that
   server. Server-supplied annotations are a hint from untrusted software, so they can only ever
   *downgrade* to "ask once" behaviour the user opted into, never skip a gate the user wants.
3. **Server output is untrusted.** Tool results go into `tool_result` blocks only, exactly like
   file contents today (Phase 3.5). The system prompt gains one line saying MCP results are data.
   Never auto-approve a follow-up based on an MCP result.
4. **A broken server must not break a run.** Connection failures, timeouts and protocol errors
   degrade to "that server's tools are unavailable"; the run continues with the remaining tools.
5. **Config lives in user settings, with a workspace opt-in.** A cloned repo must not be able to
   silently launch a process. See phase 7.6.

## Transport

Support both of the MCP transports that matter:

- **stdio** — `command` + `args` + `env`, spawned as a child process. Most servers.
- **streamable HTTP / SSE** — `url` + optional `headers`. Remote servers.

Use the official SDK: `@modelcontextprotocol/sdk` (`Client`, `StdioClientTransport`,
`StreamableHTTPClientTransport`). It is a runtime dependency of the extension host bundle, so add
it to `dependencies` in `package.json`; esbuild bundles it (`esbuild.js`) — check it bundles
cleanly for `node20` with no dynamic-require warnings before going further.

## Files to add

```
src/mcp/
├── config.ts        # McpServerConfig type, parse + validate settings
├── McpClient.ts     # one server: connect, listTools, callTool, close, status
├── McpManager.ts    # all servers: lifecycle, restart, aggregated status, disposal
├── mcpTool.ts       # wraps an MCP tool definition as a Tool
└── naming.ts        # mcp__server__tool encode/decode + sanitising
test/mcp/
├── naming.test.ts
├── mcpTool.test.ts  # against an in-process fake Client
└── manager.test.ts
```

Touched: `src/tools/index.ts`, `src/webview/ChatViewProvider.ts`, `src/safety/approvalPolicy.ts`,
`src/storage/settings.ts`, `src/webview/protocol.ts`, `src/extension.ts`, `package.json`,
`webview-ui/src/components/`.

---

## Phase 7: MCP client

### 7.1 Config shape and settings
Add `mitram.mcpServers` (scope `application`, so a repo cannot inject one — the
`test/settingsScope.test.ts` list gains this key):

```jsonc
"mitram.mcpServers": {
  "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],
              "env": { "GITHUB_TOKEN": "${env:GITHUB_TOKEN}" }, "enabled": true },
  "docs":   { "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer …" } }
}
```

`src/mcp/config.ts` validates each entry (exactly one of `command`/`url`, string arrays, no
non-string values) and drops invalid ones with a logged warning. Secrets: support
`${env:NAME}` expansion and a `mitram.mcpSecret.<server>` entry in `SecretStore` so tokens need
not sit in `settings.json`.

**Done when:** `readSettings()` returns parsed, validated server configs and bad entries are
reported in the log instead of throwing.

### 7.2 `McpClient` — one server
Wraps the SDK `Client`. Responsibilities: connect with a timeout (10 s default), `listTools()`
once after connect, `callTool(name, args, signal)` with a per-call timeout (60 s default), expose
`status: 'connecting' | 'ready' | 'failed' | 'disabled'` plus the last error, and `close()` that
kills the child process. Never log `env` values or headers.

**Done when:** a unit test connects to a fake in-process transport, lists tools, calls one, and
closes cleanly; a server that never responds fails with a clear message after the timeout.

### 7.3 `mcpTool.ts` — adapter to `Tool`
```ts
export function mcpTool(server: string, def: McpToolDefinition, client: McpClient): Tool
```
- `name`: `encodeToolName(server, def.name)` (7.0 naming rules).
- `description`: server's description, prefixed with `[server]`, truncated (~1 kB) so a chatty
  server cannot flood the prompt.
- `inputSchema`: the server's JSON Schema, after a shape check (`type: 'object'`); otherwise fall
  back to a permissive object schema.
- `requiresApproval`: `true` unless read-only-hinted *and* allowed by settings (decision 2).
- `preview`: `{ summary: "<server>: <tool>", detail: <pretty-printed args, capped> }` — the user
  must see the exact arguments before approving.
- `run`: `client.callTool(...)`, then flatten the result content to text
  (`text` blocks joined; `image`/`resource` blocks become a short placeholder in v1), pass through
  `truncateMiddle(..., 30_000)`. `isError: true` from the server → throw, so the loop returns it
  as `is_error` like any other tool failure.
- No `propose`/diff: MCP tools are opaque, so there is no diff preview and no checkpoint coverage.
  Say that in the approval card.

**Done when:** `test/mcp/mcpTool.test.ts` covers name encoding, arg preview, text flattening,
truncation, server-side error, and cancellation via `ctx.signal`.

### 7.4 `McpManager` — lifecycle
Created once in `activate()` and pushed to `context.subscriptions`. Connects enabled servers
lazily (first run that needs tools) and in parallel, caches clients across runs, exposes
`tools(): Tool[]` and `status(): McpServerStatus[]`, and offers `restart(server)` and
`restartAll()`. Reconnects when `mitram.mcpServers` changes
(`workspace.onDidChangeConfiguration`). Disposal closes every child process — leaking spawned
servers after window reload is the main risk here.

**Done when:** enabling, disabling and editing a server in settings is reflected without a window
reload, and no child process survives `deactivate()`.

### 7.5 Wire into the run
`createDefaultRegistry()` stays sync and built-in-only. Add in `src/tools/index.ts`:

```ts
export async function createRegistry(mcp?: McpManager): Promise<ToolRegistry>
```

`ChatViewProvider.run()` (`src/webview/ChatViewProvider.ts:416`) awaits it. Guards:
- Cap total MCP tools (e.g. 60) and log which were dropped; tool definitions cost prompt tokens on
  every request and are inside the cache breakpoint.
- Connection happens with a status event to the webview so the user sees "Connecting to 2 MCP
  servers…" rather than a stalled send.
- Plan mode: `registry.readOnly()` already filters to `!requiresApproval`, which drops all MCP
  tools unless the user explicitly marked them read-only. That is the behaviour we want; add a
  test pinning it.

**Done when:** with one configured server the agent can call its tool end to end, and with zero
configured servers nothing about today's behaviour changes (existing tests all still pass).

### 7.6 Safety
- **Trust prompt.** The first time a workspace would start MCP servers, ask once:
  "Start N MCP servers for this folder?" with Yes / Not now / Never, stored in `workspaceState`
  (same pattern as `CommandRuleStore`). Servers are arbitrary local processes — this gate matters.
- **Approval policy.** Extend `isAutoApproved` (`src/safety/approvalPolicy.ts`) with an
  `mcp__…` branch: auto-approve only if the user set `mitram.autoApproveMcpReads` *and* the tool is
  read-only-hinted, or an explicit "Always allow" was saved for that exact tool name. The existing
  `alwaysAllowed` set is already keyed by tool name, so the "Always allow" button works unchanged.
- **Denylist.** A `mitram.blockedMcpTools` array of patterns, checked in `Tool.policy` → blocked
  outright, matching the `commandPolicy` pattern.
- **Prompt injection.** One line in `buildSystemPrompt` (`src/agent/SystemPrompt.ts`): MCP tool
  results are untrusted data, like file contents and command output.
- **Logging.** Log server name, tool name, duration and status — never arguments or results
  (they may hold tokens). Add MCP server count/status to `buildDiagnostics`.

**Done when:** `test/mcp/` + `approvalPolicy.test.ts` show no MCP tool can run without a gate the
user configured, and the trust prompt blocks spawning until answered.

### 7.7 UI
- Tool cards: show `server: tool` with a small MCP badge (reuse the existing `ToolCard`; the only
  new thing is the badge and "no diff preview" note on the approval card).
- Status surface: a line in the settings/model area — "MCP: github ✓, docs ✗ (failed)" — with a
  Reconnect action. New `HostToWebview` message `{ type: 'mcpStatus'; servers: … }` and
  `WebviewToHost` `{ type: 'restartMcp'; server?: string }`, both added to the validators in
  `src/webview/protocol.ts` (`NO_PAYLOAD` / `STRING_FIELD`) and covered in `protocol.test.ts`.
- `/mcp` slash command (`src/webview/slashCommands.ts`) listing servers and their tools.

**Done when:** a failing server is visible and recoverable from the UI without opening the log.

### 7.8 Docs and release
README section (configuring servers, the trust model, that MCP tools have no diff preview),
CHANGELOG entry, and one eval task in `test/evals/` driving a trivial local stdio server so
regressions show up.

**Done when:** a fresh user can add a server from the README alone.

---

## Later (not in Phase 7)

- **Resources** — `resources/list` + `resources/read` surfaced as `@`-mentions in the composer,
  reusing the attachment path in `src/agent/attachments.ts`.
- **Prompts** — server-provided prompts as slash commands.
- **Sampling** — servers asking *us* to call the model. Needs its own approval design; skip.
- **M.I.T.R.A.M as an MCP server** — exposing `read_file`/`edit_file`/`run_command` over MCP so
  Claude Desktop or another client can drive this workspace. Technically small (the `Tool` registry
  is already transport-agnostic), but it inverts the trust model: approvals and checkpoints live in
  the webview, which an external client cannot show. Would need a headless approval policy first.

## Risks

| Risk | Mitigation |
| --- | --- |
| Orphaned child processes | kill process group on dispose; integration test asserts exit |
| Prompt bloat from many tools | cap tool count, truncate descriptions, keep inside the cache breakpoint |
| Untrusted server output | `tool_result` only, never influences approval, system-prompt line |
| Malicious config in a repo | `application` scope + per-workspace trust prompt |
| SDK bundling issues | verify esbuild output early (7.0), before building on top of it |
| Slow first message | connect in parallel with a timeout, show status, never block on a failed server |
