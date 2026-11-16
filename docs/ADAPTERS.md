# Writing a provider adapter

An adapter connects one agent CLI or SDK to Jogger. It turns the CLI's output into a stream of
`AdapterEvent`s and answers Jogger's calls to start turns, interrupt, and change mode. It never
touches the database, the UI or other threads; the thread manager does that.

The contract lives in [`src/server/providers/types.ts`](../src/server/providers/types.ts).
[`mock.ts`](../src/server/providers/mock.ts) is the smallest complete example;
[`claude.ts`](../src/server/providers/claude.ts) and [`codex.ts`](../src/server/providers/codex.ts) are the real ones.

## 1. Implement `ProviderAdapter`

```ts
export class GeminiAdapter implements ProviderAdapter {
  readonly id = 'gemini';
  readonly label = 'Gemini CLI';
  readonly defaultModel = 'gemini-2.5-pro';
  readonly capabilities = { imageInput: true, imageGeneration: false, webSearch: true, resume: true };
  models() { return [{ id: 'gemini-2.5-pro', label: '2.5 Pro' }]; }
  async check() { /* run `gemini --version`; never start a model turn here */ }
  createSession(opts: SessionOptions): AgentSession { return new GeminiSession(opts); }
}
```

## 2. Implement `AgentSession`

| Method | Must do |
| --- | --- |
| `send({text, images})` | Start a turn. Emit `turn.started`, stream `delta`s, emit `assistant.message` / `tool` / `attachment` events, then exactly one `turn.completed`. Resolve once the turn is accepted, not when it ends. |
| `interrupt()` | Stop the running turn; the turn must still end with `turn.completed` (`status: 'interrupted'`). |
| `setMode(mode)` | Apply `ask` / `auto` / `full` now or from the next turn. |
| `close()` | Release the process. Don't emit anything afterwards. |

Rules the thread manager relies on:

- **Emit `session`** with the provider's own session id as soon as you know it. Jogger stores it
  and passes it back as `opts.resumeId` after a restart.
- **Tool events are upserts.** Emit a `tool` event with `status: 'running'` when a tool starts and
  again with the same `itemId` when it ends. Fields you leave empty keep their earlier value.
- **Deltas use the same `itemId`** as the final `assistant.message`, so the UI can swap the live
  text for the stored message.
- **Approvals go through `opts.requestApproval()`.** Never auto-approve except for Jogger's own MCP
  tools (`jogger` server), which are always allowed.
- **Connect Jogger's MCP server** at `opts.mcp.url` with header
  `Authorization: Bearer ${opts.mcp.token}`. This is how the agent gets `ask_agent`,
  `send_message`, `share_file` and memory tools, and how Jogger knows which thread is calling.
  Set the CLI's MCP tool timeout to an hour or more: `ask_agent` blocks until the other agent
  finishes.
- **Append `opts.instructions`** to the agent's system prompt (it explains the Jogger tools).
- **Use `opts.env`** for child processes. It has API keys stripped when the user wants
  subscription billing.
- **Files the agent makes for others** (generated images and so on) go through
  `opts.saveAttachment()`, then emit an `attachment` event.
- If the underlying process dies, emit `turn.completed` (failed) for any running turn, then
  `closed`. The next message starts a new session with `resumeId`.

## 3. Register it

Add it in `ProviderRegistry`'s constructor in
[`registry.ts`](../src/server/providers/registry.ts):

```ts
this.register(new GeminiAdapter());
```

It then shows up in the new-thread form, can be used in personas and schedules, and other agents can
start it as a helper with `ask_agent({ to: 'gemini', … })`.

## 4. Test it

Copy a test from `test/daemon.test.ts` and swap `provider: 'mock'` for yours. Run it with a cheap
model first.
