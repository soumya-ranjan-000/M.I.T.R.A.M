# M.I.T.R.A.M

An AI coding agent in your VS Code sidebar. It can read and search your project, edit files, run commands and fix its own mistakes, while you approve every change that matters.

It talks to **Claude on Azure AI Foundry** using your own endpoint and API key. Nothing goes through any other service.

## Getting started

1. Install the extension and open a **folder** (the agent needs one to work on files).
2. Open your user **Settings** and set `mitram.endpoint` to your Foundry endpoint, for example `https://<resource>.services.ai.azure.com/anthropic/`.
3. Set `mitram.model` to your **deployment name**.
4. Run **M.I.T.R.A.M: Set API Key** from the Command Palette.
5. Click the M.I.T.R.A.M icon in the activity bar (or press `Ctrl+Alt+M` / `Cmd+Alt+M`) and ask for something, such as _"add a unit test for the slugify function and run it"_.

## What it can do

|                 |                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------- |
| Understand code | Reads files, lists folders, searches by name and by regular expression, and reads editor errors                   |
| Change code     | Small exact-match edits and new files, applied through the editor so **Ctrl+Z** works                             |
| Run things      | Runs tests, builds and git commands, and reads the output                                                         |
| Plan first      | Turn on **Plan** (or type `/plan`) and it only investigates, then proposes a plan you approve                     |
| Keep track      | A **plan board** with task statuses that it updates as it works, so it always knows what is done and what is left |
| Split up work   | Hands self-contained pieces to **sub-agents** that work in parallel and report back                               |
| Use other tools | Connect **MCP servers** (a browser, GitHub, Jira) to give it tools beyond this workspace                          |

In the message box: type `@` to attach a file, `/` for commands (`/new`, `/undo`, `/plan`, `/model`, `/permissions`, `/mcp`). The current file or selection is attached automatically; untick the chip above the box to stop that.

To show it something, paste a screenshot (**Ctrl+V**), drop files on the box (hold **Shift** while dropping, as VS Code requires), or use **+** → **Attach files…**. Up to 5 images and 5 other files per message:

- **Images** are scaled to what the model can read (2576 px on the long edge, 3.75 megapixels), and re-encoding drops metadata such as a photo's location.
- **PDFs** (up to 15 MB) go to the model as they are, so it sees the pages, including tables and charts.
- **Word, Excel, PowerPoint and LibreOffice files** are sent as the text read from them: documents as paragraphs, spreadsheets as CSV for each sheet (with real dates), presentations slide by slide. Old `.doc`, `.xls` and `.ppt` files need saving in the newer format first.
- **Text files** of any kind (code, CSV, JSON, Markdown, logs) are sent as they are, up to about 200,000 characters each.

File types are recognised from their contents, not their names.

## Feature tour

### A chat that works on your project

Ask about your code or ask for a change. The current file is attached automatically, and the model's reasoning is shown while it works. When a long run of tool calls scrolls your message out of view, it stays pinned at the top of the chat (the request for whatever part you are reading); click it to jump back to the full message.

<p align="center"><img src="media/screenshots/01-welcome.png" alt="The welcome screen of the chat panel" width="360"></p>

### It reads before it answers

The agent searches and reads your files (and your editor's error list) before it replies, and each step is shown as a card you can expand. To give it a head start, each message also carries the files a local keyword search matched to it, with short excerpts from the top two, so the agent can often go straight to the right code. A card under your message lists them; click one to open it.

<p align="center"><img src="media/screenshots/02-understand-code.png" alt="The agent reasoning, searching and reading files, then answering" width="360"></p>

### You approve every change

Edits and commands wait for you. **View diff** opens VS Code's diff editor on the exact change, and **Allow**, **Always allow** or **Reject** decide what happens next.

**Always allow** on a command saves a rule for this workspace, shown on the button before you click it: `npm run lint *` (the script with any arguments) for everyday tools, or just the exact command for interpreters, installs and anything that deletes, pushes or reaches the network. A command with pipes, chaining, redirects or wildcards is saved only exactly as written, character for character, and the card warns you to read all of it first. Type `/permissions` to review or remove saved rules.

<p align="center"><img src="media/screenshots/03-approval.png" alt="An edit waiting for approval with View diff, Allow, Always allow and Reject" width="360"></p>

### Plan mode

Turn on **Plan** (or type `/plan`) and the agent only investigates and proposes a plan. Nothing is changed until you press **Execute plan**.

<p align="center"><img src="media/screenshots/05-plan-mode.png" alt="A proposed plan with Execute plan and Keep planning buttons" width="360"></p>

### A plan board for long tasks

For big jobs the agent keeps a board of tasks (to do, in progress, done, blocked) and notes. It re-reads the board on every step, so it always knows what is finished and what is left.

<p align="center"><img src="media/screenshots/04-plan-board.png" alt="The plan board showing two tasks done, one in progress, one pending and one blocked" width="360"></p>

### Sub-agents for self-contained pieces

For a job with separable parts, the agent can hand a piece to a **sub-agent**: a fresh agent with its own context, its own tools and a written brief. Several run at the same time (three by default, `mitram.maxParallelSubagents`), and each reports back a summary the main agent reads before carrying on. This keeps a long investigation out of the main conversation, so the context lasts longer.

A sub-agent either **explores** (read-only: reading, searching and diagnostics) or **implements** (it can also edit files and run commands, each still asking you first). It cannot touch the plan board, and it cannot delegate again, so work can never fan out without end. In plan mode only exploring sub-agents are offered. Their steps appear indented under the delegation card, and the main agent is told to verify what they report rather than take it on trust. Turn the whole thing off with `mitram.subagents`.

### Tools from MCP servers

[MCP](https://modelcontextprotocol.io) servers give the agent tools this extension does not have: a real browser, your issue tracker, a database. Open the **MCP servers** panel from the plug icon in the chat header or type `/mcp`, then **+** to add one. Ready-made entries cover **Playwright** (browse pages, click, type, screenshot), **GitHub**, **Filesystem**, **Atlassian** (Jira and Confluence), **PostgreSQL** and **Sentry**; **Custom…** takes any command or `https` URL.

Servers are shared across your projects (user settings), so adding one once is enough. A server that needs an API key asks for it in a password box, and the key goes into VS Code's secret storage, never into `settings.json`. The panel shows each server's state, how many tools it offers, and buttons to set its key, disable, reconnect or remove it.

The agent sees these as `mcp__<server>__<tool>`. **Every one asks for your approval before it runs**, with the exact arguments on the card, and their results are treated as untrusted data the agent may act on but never take instructions from. See [MCP servers](#mcp-servers) below for how to add one by hand and for the settings.

### Continue and revert

A long run pauses after a step or time limit and shows **Continue**. A turn that changed files shows **Revert changes**, and the context bar shows how much of the model's window is used and how much came from cache.

<p align="center"><img src="media/screenshots/06-continue-revert.png" alt="A paused run with a Continue button and a Revert changes bar" width="360"></p>

### Live feedback while it works

The message box glows and a status line shows the current step, so you always know whether the agent is working or waiting for you. Press **Esc** or the stop button to cancel.

<p align="center"><img src="media/screenshots/10-working.png" alt="The message box glowing while the agent runs a command" width="360"></p>

### Slash commands and file attachments

Type `/` for commands and `@` to attach files.

<p align="center"><img src="media/screenshots/07-slash-commands.png" alt="The slash command menu" width="300">&nbsp;&nbsp;<img src="media/screenshots/08-attach-files.png" alt="The @ file picker" width="300"></p>

### Chat history

Every chat is saved on your machine. Use the history button to switch between them, or **+** to start a new one.

<p align="center"><img src="media/screenshots/09-history.png" alt="The chat history menu" width="360"></p>

## Long tasks

For work with many steps, the agent keeps a **plan board**, shown above the message box with each task marked to do, in progress, done or blocked. The board is shown to the agent again at the end of every request, outside the saved conversation, so it always sees the current plan even after old messages are trimmed. It also keeps short notes there (findings, decisions, the command that runs the tests). The board is saved with the chat. Use the **×** on the panel to clear it.

Things that keep a long run on track:

- **Check before finishing.** If the agent tries to stop with files it changed but never checked, or with tasks still pending, it is sent back to work. It is reminded at most twice, and if something is still open when it finishes you are told what. If you refuse to let a check run, it stops insisting. Turn this off with `mitram.verifyBeforeDone`.
- **Budgets and Continue.** A run pauses after `mitram.maxIterations` steps (default 60) or `mitram.maxRunMinutes` minutes (default 20), and shows a **Continue** button. Continuing keeps the earlier revert point, so the whole task can still be undone with **Revert changes**.
- **Going in circles.** If the same action keeps giving the same result, the agent is told to change approach, and the run stops if it carries on. You can press **Continue** to let it try again.
- **Long conversations.** Near the context limit, old tool output is cleared first. If that is not enough, the oldest part of the conversation is replaced by a short model-written summary (one extra request; turn off with `mitram.summarizeContext`, in which case old turns are dropped).

## You stay in control

- **Approval.** By default, every edit, new file and command asks first. Set `mitram.skipApprovalPrompts` to skip those prompts; commands blocked by the safety policy remain blocked. Edits show a **View diff** button when approval is requested.
- **Blocked outright.** Obviously destructive commands (`sudo`, `rm -rf /`, `curl … | sh`, force-push, and similar) are refused without asking. You can add your own patterns with `mitram.blockedCommandPatterns`. This is a safety net, not a sandbox: the approval prompt is your real protection.
- **Revert.** After a turn that changed files, **Revert changes** restores them. A file you edited yourself afterwards is left alone. Changes made by commands the agent ran are not tracked.
- **Workspace only.** File tools cannot read or write outside the open folder, including through symlinks.
- **Optional auto-approve**, all off by default: `mitram.skipApprovalPrompts` skips prompts for edits, file creation and commands; commands blocked by the safety policy remain blocked. For narrower control, use `mitram.autoApproveEdits`, `mitram.autoApproveSafeCommands` (`pwd`, `ls`, read-only `git`) and `mitram.autoApproveCommands` (a list of commands you trust in every workspace, each matched as a whole; anything chained with `;`, `&`, `|` or redirects always asks unless the master setting is on). These are read from your user settings only, so a repository's `.vscode/settings.json` cannot switch them on.
- **Per-project command rules.** **Always allow** on a command card saves a rule in VS Code's storage for this workspace, not in a file a repository could ship. Review them with `/permissions` or **M.I.T.R.A.M: Manage Always-Allowed Commands**.
- **MCP servers ask twice over.** Before any server starts in a project, you are asked once whether to run them there at all. After that every tool call still asks, because a server is software this extension cannot inspect. See below.

## MCP servers

An [MCP](https://modelcontextprotocol.io) server is a small program that offers tools. Connect one and the agent can do things this extension cannot: drive a browser, read your Jira issues, query a database.

**Adding one.** Click the plug icon in the chat header (or type `/mcp`) and press **+**. Pick a ready-made entry — Playwright, GitHub, Filesystem, Atlassian, PostgreSQL, Sentry — or **Custom…** for any command or `https` URL. You are asked for anything it needs, such as a directory or an API key. The panel then shows whether it connected and how many tools it offers.

**API keys** are typed into a password box and stored in VS Code's secret storage. They are never written to `settings.json` and never reach the chat view. Removing a server deletes its key too. A server can take its key as an HTTP header (`Authorization: Bearer …`, the usual choice for a hosted service such as Atlassian) or as an environment variable (`GITHUB_PERSONAL_ACCESS_TOKEN`, the usual choice for a local one).

**By hand.** The panel writes to `mitram.mcpServers` in your user settings, which you can also edit directly:

```jsonc
"mitram.mcpServers": {
  "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] },
  "atlassian":  {
    "url": "https://mcp.atlassian.com/v1/sse",
    "auth": { "kind": "header", "name": "Authorization", "format": "Bearer {key}" }
  },
  "github": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "auth": { "kind": "env", "name": "GITHUB_PERSONAL_ACCESS_TOKEN" }
  }
}
```

A `command` starts a local server; a `url` connects to a remote one, which must use `https` unless it points at `localhost`. The transport is worked out for you (a URL ending in `/sse` uses the older SSE protocol, anything else streamable HTTP) and can be set explicitly with `"transport"`. Use `${env:NAME}` anywhere in `url`, `args`, `env` or `headers` to take a value from your own environment. An entry with a mistake in it is skipped with the reason shown in the panel, so the rest still load.

**What it means for a run.** Servers start on the first message that needs them and stay connected while the window is open. One that fails to start costs you its tools and nothing else. Tools arrive as `mcp__<server>__<tool>`; the agent is told they reach outside the workspace, that their results are untrusted data it must never take instructions from, and to prefer a built-in tool where one would do. In plan mode they are not offered at all, since nothing may change there.

**Security.** These settings are read from your user settings only, so a cloned repository cannot add a server or switch one on. Running a server means running a program with your permissions, which is why the first start in a project asks for your agreement, and why `mitram.skipApprovalPrompts` — which covers this project's own edits and commands — deliberately does **not** cover MCP tools. Logs record the server, the tool and how long it took, never the arguments, the results or the key.

## Settings

| Setting                                                                              | What it does                                                                                                                                            |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mitram.endpoint`                                                                    | Your Azure AI Foundry endpoint (user settings only)                                                                                                     |
| `mitram.model` / `mitram.models`                                                     | Default model (deployment name) and extra names for the picker                                                                                          |
| `mitram.maxTokens`                                                                   | Maximum tokens per reply                                                                                                                                |
| `mitram.maxIterations` / `mitram.maxRunMinutes`                                      | Pause a run after this many steps (default 60) or minutes (default 20); a Continue button resumes it                                                    |
| `mitram.verifyBeforeDone`                                                            | Make the agent check its changes and finish its board before it stops (default on)                                                                      |
| `mitram.summarizeContext`                                                            | Summarise the oldest conversation near the context limit instead of dropping it (default on)                                                            |
| `mitram.showReasoning`                                                               | Show the model's reasoning summary while it works (default on; falls back automatically if your deployment does not support it)                         |
| `mitram.contextWindow`                                                               | Your deployment's context size. Older context is trimmed above about 70% of it                                                                          |
| `mitram.promptCaching`                                                               | Cache the prompt prefix to cut cost and latency. Turn off if your deployment rejects it                                                                 |
| `mitram.includeEnvironment`                                                          | Send open tabs, git branch and diff summary, and current errors with each message                                                                       |
| `mitram.retrieveContext`                                                             | Before each message, search the workspace locally and attach the best-matching files and short excerpts, only when the match is confident (default on)  |
| `mitram.subagents` / `mitram.maxParallelSubagents`                                   | Let the agent hand pieces of work to sub-agents (default on), and how many may run at once (default 3)                                                  |
| `mitram.mcpServers`                                                                  | The MCP servers to connect to (user settings only). Easiest edited from the MCP panel                                                                   |
| `mitram.mcpToolLimit`                                                                | Most MCP tools offered to the model at once (default 60). Tool definitions cost tokens on every request                                                 |
| `mitram.blockedMcpTools`                                                             | Patterns for MCP tools to refuse outright, e.g. `mcp__.*__delete_.*`                                                                                    |
| `mitram.autoApproveMcpReads`                                                         | Run MCP tools the server itself marks read-only without asking (default off; the hint comes from the server, so leave it off unless you trust them all) |
| `mitram.skipApprovalPrompts`, `mitram.autoApprove*`, `mitram.blockedCommandPatterns` | See above                                                                                                                                               |

## Project instructions

Run **M.I.T.R.A.M: Create Project Instructions (MITRAM.md)** to create a `MITRAM.md` in your project root. Its contents are added to the agent's instructions (build and test commands, conventions, things to avoid). They can never override the safety rules or the approval prompts. Read a `MITRAM.md` before trusting it in a project you did not write.

## Privacy

- **No telemetry.** This extension does not collect or send usage data.
- **Where your data goes.** The only network traffic is to the endpoint you configure. It is read from your user settings only, so a repository's `.vscode/settings.json` cannot redirect your requests or API key. Each request contains your message, files, selections and images you attach, the results of tools the agent ran (file contents, command output), the agent's plan board, and, unless you turn them off, the environment summary described above and the files and excerpts a local search matched to your message. The search index is built on your machine and kept in memory only. When a long conversation is summarised, the earlier part of it is sent to the same endpoint to be summarised.
- **Your API key** is kept in VS Code's secret storage and is never written to settings, logs or chat history.
- **Chats** are stored locally in VS Code's extension storage on your machine. To keep that small, saved chats keep the images and PDFs of only their last two messages with them, in your three most recent chats; older images show as "image (not kept)". Text read from attached files is kept like any other attached context.
- **Logs** (`M.I.T.R.A.M: Show Logs`) are local, contain no prompts, file contents or command output, and have anything resembling a credential redacted. **Copy Diagnostics for Bug Report** includes only versions, settings and the endpoint's host name.

## Troubleshooting

- _"No folder is open"_: use **File → Open Folder**. Without one the agent can only chat.
- _404 or "Not found"_: check the endpoint URL, and that `mitram.model` is your deployment name.
- _An error mentioning `cache_control`_: set `mitram.promptCaching` to `false`.
- _The agent says it has no tools_: it is running without a folder, or the model deployment does not support tool use.

## Development

```bash
npm run install:all   # install both packages
npm run build         # extension + webview
npm test              # unit tests (no network)
npm run test:coverage
npm run package       # build a .vsix
```

`npm run smoke:mcp` starts a small MCP server as a real child process and checks the whole path: connecting, listing tools, calling one, that the API key reaches the server but never the log, and that nothing is left running afterwards. `npm run smoke:mcp:playwright` does the same against the real `@playwright/mcp`, so it downloads that package the first time.

Press **F5** in this folder to launch a development window with the debugger (it opens `sandbox/` and disables your other extensions).

If the development window's extension host crashes on F5 (exit code 134 in VS Code's `main.log`), start it without the debugger instead: `npm run dev`, or the **Dev window (no debugger)** task. You lose breakpoints, nothing else.

`npm run eval -- --yes` runs 29 end-to-end tasks (including five longer multi-step ones, such as building a module plus a CLI against an existing test, and a change that only the tests reveal is broken) against **your** model and records a pass rate (set `MITRAM_ENDPOINT`, `MITRAM_API_KEY`, and optionally `MITRAM_MODEL`). It spends tokens, so it refuses to start without `--yes`.

## Known limitations

- Claude on Azure AI Foundry only.
- Commands run in a background process, not in a terminal tab.
- Summaries are written by the model, so details can be lost; the plan board and your project files are the reliable memory for long work.
- Not tested on real multi-hour tasks yet. Run `npm run eval` against your deployment to see how it does.
