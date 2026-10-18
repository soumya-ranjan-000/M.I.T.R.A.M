# Changelog

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
