# Changelog

## 0.4.0

- **Tools from MCP servers:** connect [MCP](https://modelcontextprotocol.io) servers to give the agent tools this extension does not have — a real browser, your issue tracker, a database. Open the **MCP servers** panel from the plug icon in the chat header or type `/mcp`, press **+**, and pick a ready-made entry (Playwright, GitHub, Filesystem, Atlassian, PostgreSQL, Sentry) or **Custom…** for any command or `https` URL. The panel shows each server's state, how many tools it offers, and buttons to set its key, disable, reconnect or remove it. Servers start on the first message that needs them; one that fails to start costs you its tools and nothing else. The agent sees them as `mcp__<server>__<tool>`, and is told their results are untrusted data it may act on but never take instructions from.
- **API keys for MCP servers** are typed into a password box and kept in VS Code's secret storage, never in `settings.json`, and are deleted with the server. A key can be sent as an HTTP header (`Authorization: Bearer …`, as hosted services such as Atlassian expect) or as an environment variable (`GITHUB_PERSONAL_ACCESS_TOKEN`, as local servers expect).
- **Security for MCP:** `mitram.mcpServers` is read from user settings only, so a cloned repository cannot add a server or switch one on. Running a server means running a program with your permissions, so the first start in a project asks for your agreement, and **every MCP tool call asks for approval** with its exact arguments shown — `mitram.skipApprovalPrompts`, which covers this project's own edits and commands, deliberately does not extend to them. `mitram.autoApproveMcpReads` can relax that for tools a server marks read-only, and `mitram.blockedMcpTools` refuses matching tools outright. In plan mode MCP tools are not offered at all. Logs record the server, the tool and how long it took, never the arguments, the results or the key.
- **Sub-agents:** the agent can hand a self-contained piece of work to a sub-agent with its own context, tools and brief, and several run at the same time (`mitram.maxParallelSubagents`, three by default). Only the final report comes back, so a long investigation no longer fills the main conversation. A sub-agent either explores (read-only) or implements (it can also edit and run commands, each still asking you first); it cannot touch the plan board and cannot delegate again, so work never fans out without end. In plan mode only exploring sub-agents are offered. Their steps appear indented under the delegation card. Turn it off with `mitram.subagents`.

## 0.3.0

- **Related code up front:** each message now carries the files a local keyword search matched to it (paths, line ranges and short excerpts from the top two, about 650 tokens), so the agent can start from the right code instead of searching first. It understands identifiers (`autoApproveEdits`, `cache_control`), word forms and common developer synonyms ("revert" finds code that says "restore"). Messages that name no code, such as "looks good, go ahead", usually attach nothing. A collapsed **Attached N related files** card under your message shows what was sent; click a file to open it at those lines. The index respects `.gitignore`, lives in memory and updates as files change. It is a starting point, not always right: the agent is told to check the files before relying on them. Turn it off with `mitram.retrieveContext`.
- **Skip approval prompts:** the user-level `mitram.skipApprovalPrompts` setting skips approval prompts for file edits, file creation and commands. Commands blocked by the safety policy remain blocked. Off by default, and ignored in a workspace's `.vscode/settings.json`.

## 0.2.0

- Fixed: hiding the chat (switching side bar views, or closing and reopening it) during a run lost the "Writing…" status, timer, stop button and glow while the agent kept working. The reopened view now picks the run back up, along with the context bar and the **Revert changes** bar.
- **Files in chat:** **+** → **Attach files…**, or a drop or paste from a file manager, attaches PDFs and Word, Excel, PowerPoint, LibreOffice and text files (up to 5 per message, alongside 5 images). PDFs are sent as documents, so the model sees their pages; other files as the text read from them, with spreadsheets as CSV for each sheet and real dates. Old PDFs are trimmed, counted toward the request size limit and left out of saved chats just like images.
- **Pinned request:** once your message scrolls out of view, it stays pinned at the top of the chat as a "Your request" card, two lines at most, so you can see what the agent is working on without scrolling back. It follows the part of the chat you are reading, skips the automatic "Continue" and "plan approved" messages, and jumps to the full message when clicked.
- **Images in chat:** paste a screenshot, drop an image, or use **+** → **Attach files…** (up to 5 per message). Images are resized to the model's limit (2576 px, 3.75 MP) and sent as image blocks, counted by their pixels when trimming context, and removed from older turns when a chat gets long or close to the request size limit.
- **Always allow** for commands: the approval card offers a rule for this workspace, such as `npm run lint *` or the exact command, so you no longer have to edit settings by hand. Commands with pipes, chaining, redirects or wildcards can be always allowed too, exactly as written only, with a warning on the card. Review or remove rules with `/permissions` or **M.I.T.R.A.M: Manage Always-Allowed Commands**.
- **Security:** `mitram.endpoint`, `mitram.autoApproveEdits`, `mitram.autoApproveSafeCommands` and `mitram.autoApproveCommands` are now read from user settings only. Values in a workspace's `.vscode/settings.json` are ignored, so a cloned repository can no longer send your API key to its own server or turn on auto-approval. If you set any of these per workspace, move them to your user settings (or, for commands, use **Always allow**).
- A long or multi-line command now shows in full on its approval card, instead of being cut off after one line.
- "Always allow" on edits is now labelled **Always allow in this chat**, to make clear it lasts for the current chat only.

## 0.1.0

First release.

- Chat panel in the activity bar, with streaming replies, markdown and highlighted code blocks (copy / insert at cursor).
- Works with Claude on **Azure AI Foundry**: set your endpoint and API key (stored in VS Code's secret storage).
- Agent that can read, search and edit your workspace and run commands, step by step, with a card for every action.
- Approval before edits and commands, with a diff preview, "always allow" for edits, and a **Revert changes** button for the last turn.
- Safety net for commands: dangerous ones are blocked outright, plus optional auto-approve for read-only commands and commands you list.
- Attach the current file, a selection, or `@file` mentions. Open tabs, git branch, diff summary and current errors are sent with each message (can be turned off).
- Saved chats, model picker (`/model`), plan mode (`/plan`), and slash commands.
- Automatic context trimming, prompt caching, and a context-usage bar.
- `MITRAM.md` project instructions.
- Local, redacted logs and a "Copy Diagnostics" command. No telemetry.
- Plan board: the agent keeps a visible task list and notes, saved with the chat and shown to it before every request.
- Long-run support: check-before-finishing, step and time budgets with a Continue button, detection of repeated actions, and summaries of old context.
- Streamed reasoning summaries, with an automatic fallback if the deployment does not support them.
- 29 end-to-end eval tasks, including five longer ones.
