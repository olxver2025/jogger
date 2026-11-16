# Jogger

Run Claude Code, Codex and other coding agents side by side on your own subscriptions, and let them
message each other. Claude can ask Codex for an image, and the image lands back in Claude's
thread and project.

- **Your subscriptions, not API keys.** Jogger drives the `claude` and `codex` CLIs you are already
  logged into (Claude Agent SDK and `codex app-server`). API key variables are stripped from agent
  processes by default so usage bills to your plan.
- **Agents talk to each other.** Every agent gets Jogger's MCP tools: `ask_agent` (wait for an
  answer and any files), `send_message` (fire and forget, reply arrives later), `list_agents`,
  `share_file`, and shared project memory. Agents can message open threads or start a helper on
  another provider. Loops, deadlocks and runaway depth are refused.
- **Split panes.** Up to four threads at once, with ⌘K command palette, rebindable shortcuts,
  themes, accent colour and personas (Claude, Codex, Artist, Reviewer, or your own).
- **Per-thread approvals.** Ask, Auto (edits allowed) or Full. Helpers never get more autonomy than
  the agent that started them.
- **Optional git worktrees** per thread, so parallel agents don't overwrite each other.
- **Always on.** A background daemon keeps scheduled tasks (cron) and long turns running when the
  tab is closed. A Telegram bridge lets you message agents and answer approvals from your phone.

## Requirements

- Node 22.13 or newer (uses the built-in `node:sqlite`).
- At least one of:
  - [Claude Code](https://docs.claude.com/en/docs/claude-code), logged in (`claude` once).
  - [Codex CLI](https://github.com/openai/codex), logged in (`codex login`).

## Run it

```bash
npm install
```

```bash
npm run build
```

```bash
node bin/jogger.mjs start
```

The daemon prints a sign-in link like `http://127.0.0.1:4317/?token=…`. Open it once; it sets a
cookie and the plain address works after that. `node bin/jogger.mjs open` prints and opens the link again.

To start Jogger at login and keep it running (macOS):

```bash
node bin/jogger.mjs install-launchd
```

`uninstall-launchd` removes it; `status` shows what's running.

### Development

```bash
npm run dev
```

This runs the daemon with auto-restart and Vite with hot reload. Open
`http://127.0.0.1:5173/api/auth?token=<token>` (the token is in `~/.jogger/token`).

```bash
npm test
```

Tests use the built-in **mock** provider. It needs no model and spends nothing, and you can also
pick it in the UI to try things out. Mock understands `ask @handle …`, `send @handle …`, `image`,
`approve`, `sleep N` and `memory key=value`.

## How agents message each other

Each agent session connects to `http://127.0.0.1:4317/mcp` with a token unique to its thread, so
Jogger always knows who is calling. When Claude calls:

```
ask_agent({ to: "codex", message: "A flat red circle on white, 512px", save_to: "assets" })
```

1. Jogger finds the thread with handle `@codex`, or starts a helper if you named a provider or a
   persona such as `artist`.
2. The message is queued in that thread like any other message, marked as coming from `@claude`.
3. When Codex's turn ends, its final message and every file it produced (generated images are
   captured automatically) go back to Claude as the tool result. Images are inline so Claude can
   see them, and they are copied into `assets/` because of `save_to`.

Both threads show the exchange as linked cards. Requests that would deadlock (A waits on B while B
asks A) are refused, and chains deeper than *Settings → Agents → max depth* stop.

## Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) and paste its token in
   *Settings → Telegram*.
2. Message the bot. It replies with your chat id; add it to *Allowed chat ids*.
3. Talk to the current agent, or start a message with `@handle`. Commands: `/threads`,
   `/use <handle>`, `/new <persona> <prompt>`, `/stop`, `/approvals`. Approvals arrive with
   Allow / Deny buttons, and scheduled task results are posted to allowed chats.

Only allowed chat ids can reach your agents.

## Data and security

- Everything lives in `~/.jogger` (`JOGGER_HOME` to change): a SQLite database, attachments,
  worktrees and the access token.
- The daemon listens on 127.0.0.1 only. It checks the Host header (DNS rebinding), the Origin
  header on writes and WebSockets, and a token cookie on every request. The agent endpoint takes
  per-thread tokens and refuses browsers.
- Agents run with your user's permissions, within the approval mode you pick. "Full" means
  no prompts.

## Adding a provider

See [docs/ADAPTERS.md](docs/ADAPTERS.md). An adapter is one class that turns a CLI into Jogger
events.
