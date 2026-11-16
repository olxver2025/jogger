import fs from 'node:fs';
import type { AppState, MessageOrigin, PendingApproval, Thread } from '../shared/protocol.js';
import type { Store } from './store.js';
import type { Hub } from './hub.js';
import type { ThreadManager, TurnResult } from './threads.js';

// Telegram bridge over long polling, so no public URL is needed. Only chats listed in
// settings.telegram.allowedChatIds can talk to agents; anyone else is told their chat id.

type Status = AppState['telegram'];

export class TelegramBridge {
  status: Status = { status: 'off', error: null, botName: null };
  private running = false;
  private abort: AbortController | null = null;
  private offset = 0;
  private current = new Map<number, string>(); // chatId -> threadId
  private announced = new Set<string>();
  private base = process.env.JOGGER_TELEGRAM_API ?? 'https://api.telegram.org';

  constructor(private store: Store, private hub: Hub, private threads: ThreadManager) {
    try {
      const saved = JSON.parse(store.getKv('telegram.current') ?? '{}');
      for (const [k, v] of Object.entries(saved)) this.current.set(Number(k), String(v));
    } catch {
      /* ignore */
    }
    threads.onTurnDone.push((t, origin, r) => void this.onTurnDone(t, origin, r).catch(() => {}));
    hub.onMessage((m) => {
      if (m.type === 'approvals') void this.forwardApprovals(m.pendingApprovals).catch(() => {});
    });
  }

  private get cfg() {
    return this.store.settings().telegram;
  }

  private setStatus(s: Partial<Status>) {
    this.status = { ...this.status, ...s };
    this.hub.broadcast({ type: 'telegram', telegram: this.status });
  }

  async start() {
    const c = this.cfg;
    if (!c.enabled || !c.botToken) {
      this.setStatus({ status: 'off', error: null });
      return;
    }
    if (this.running) return;
    this.running = true;
    this.setStatus({ status: 'connecting', error: null });
    void this.loop();
  }

  async stop() {
    this.running = false;
    this.abort?.abort();
    this.setStatus({ status: 'off' });
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  /** Check a bot token (the one typed in the form, or the saved one). */
  async test(token?: string): Promise<{ ok: boolean; botName?: string; error?: string }> {
    try {
      const me = token
        ? await fetch(`${this.base}/bot${token}/getMe`, { method: 'POST' })
            .then((r) => r.json() as Promise<any>)
            .then((j) => {
              if (!j.ok) throw new Error(j.description ?? 'Telegram rejected the token');
              return j.result;
            })
        : await this.call('getMe', {});
      return { ok: true, botName: me.username };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  private async call(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    const res = await fetch(`${this.base}/bot${this.cfg.botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    const json: any = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
    if (!json.ok) throw new Error(json.description ?? `Telegram ${method} failed`);
    return json.result;
  }

  private async loop() {
    let backoff = 1000;
    try {
      const me = await this.call('getMe', {});
      this.setStatus({ status: 'online', botName: me.username ?? null, error: null });
    } catch (err) {
      this.running = false;
      this.setStatus({ status: 'error', error: (err as Error).message });
      return;
    }
    while (this.running) {
      this.abort = new AbortController();
      try {
        const updates: any[] = await this.call(
          'getUpdates',
          { offset: this.offset, timeout: 30, allowed_updates: ['message', 'callback_query'] },
          this.abort.signal,
        );
        backoff = 1000;
        if (this.status.status !== 'online') this.setStatus({ status: 'online', error: null });
        for (const u of updates) {
          this.offset = Math.max(this.offset, u.update_id + 1);
          await this.onUpdate(u).catch((err) => console.error('[jogger] telegram update failed:', err));
        }
      } catch (err) {
        if (!this.running) break;
        this.setStatus({ status: 'error', error: (err as Error).message });
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60000);
      }
    }
  }

  private allowed(chatId: number) {
    return this.cfg.allowedChatIds.includes(chatId);
  }

  async sendText(chatId: number, text: string, extra: Record<string, unknown> = {}) {
    const chunks = text.match(/[\s\S]{1,3900}/g) ?? [''];
    for (const chunk of chunks) await this.call('sendMessage', { chat_id: chatId, text: chunk || '(empty)', ...extra });
  }

  private async sendPhoto(chatId: number, filePath: string, caption?: string) {
    const form = new FormData();
    form.set('chat_id', String(chatId));
    if (caption) form.set('caption', caption.slice(0, 1000));
    form.set('photo', new Blob([fs.readFileSync(filePath)]), filePath.split('/').pop());
    await fetch(`${this.base}/bot${this.cfg.botToken}/sendPhoto`, { method: 'POST', body: form });
  }

  private visibleThreads(): Thread[] {
    return this.threads.threads().filter((t) => !t.archived).sort((a, b) => b.lastEventAt - a.lastEventAt);
  }

  private findThread(handle: string): Thread | undefined {
    const h = handle.replace(/^@/, '').toLowerCase();
    return this.visibleThreads().find((t) => t.handle.toLowerCase() === h);
  }

  private setCurrent(chatId: number, threadId: string) {
    this.current.set(chatId, threadId);
    this.store.setKv('telegram.current', JSON.stringify(Object.fromEntries(this.current)));
  }

  private async onUpdate(u: any) {
    if (u.callback_query) return this.onCallback(u.callback_query);
    const msg = u.message;
    if (!msg?.chat) return;
    const chatId: number = msg.chat.id;
    if (!this.allowed(chatId)) {
      await this.sendText(chatId, `This chat isn't allowed to use this Jogger yet. Its chat id is ${chatId}. Add it under Settings → Telegram in Jogger.`);
      return;
    }
    const from = msg.from?.username ? '@' + msg.from.username : msg.from?.first_name ?? 'telegram';
    const text: string = (msg.text ?? msg.caption ?? '').trim();

    if (text.startsWith('/')) return this.onCommand(chatId, text, from);

    let threadId = this.current.get(chatId) ?? this.cfg.defaultThreadId ?? this.visibleThreads()[0]?.id;
    let body = text;
    const mention = text.match(/^@([\w-]+)\s+([\s\S]*)$/);
    if (mention) {
      const t = this.findThread(mention[1]);
      if (!t) return this.sendText(chatId, `No agent called @${mention[1]}. Try /threads.`);
      threadId = t.id;
      body = mention[2];
      this.setCurrent(chatId, t.id);
    }
    if (!threadId || !this.threads.threads().some((t) => t.id === threadId))
      return this.sendText(chatId, 'No thread to send to. Start one with /new <persona or provider> <prompt>.');

    const attachmentIds: string[] = [];
    if (msg.photo?.length) {
      const best = msg.photo[msg.photo.length - 1];
      const file = await this.call('getFile', { file_id: best.file_id });
      const res = await fetch(`${this.base}/file/bot${this.cfg.botToken}/${file.file_path}`);
      const att = await this.threads.saveAttachment({ data: Buffer.from(await res.arrayBuffer()), name: file.file_path.split('/').pop() ?? 'photo.jpg' });
      attachmentIds.push(att.id);
    }
    if (!body && !attachmentIds.length) return;
    const origin: MessageOrigin = { kind: 'telegram', chatId, from };
    this.threads.sendUserMessage(threadId, body || 'See the attached image.', attachmentIds, origin);
    const t = this.threads.thread(threadId);
    await this.call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    if (this.threads.isBusy(threadId) && t.queued > 0) await this.sendText(chatId, `Queued for @${t.handle} (${t.queued} ahead).`);
  }

  private async onCommand(chatId: number, text: string, _from: string) {
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd.replace(/@.*$/, '')) {
      case '/start':
      case '/help':
        return this.sendText(
          chatId,
          [
            'Jogger bridge.',
            'Send text to talk to the current agent, or start with @handle to pick one.',
            '/threads — list agents',
            '/use <handle> — switch the current agent',
            '/new <persona|provider> <prompt> — start a new thread',
            '/stop — stop the current agent',
            '/approvals — show pending approvals',
          ].join('\n'),
        );
      case '/threads': {
        const cur = this.current.get(chatId);
        const lines = this.visibleThreads()
          .slice(0, 25)
          .map((t) => `${t.id === cur ? '▸ ' : ''}@${t.handle} · ${t.provider} · ${t.status}${t.title ? ' · ' + t.title.slice(0, 40) : ''}`);
        return this.sendText(chatId, lines.join('\n') || 'No threads yet.');
      }
      case '/use': {
        const t = this.findThread(arg);
        if (!t) return this.sendText(chatId, `No agent called ${arg}.`);
        this.setCurrent(chatId, t.id);
        return this.sendText(chatId, `Now talking to @${t.handle}.`);
      }
      case '/new': {
        const [who, ...p] = rest;
        const prompt = p.join(' ');
        const persona = this.store.personas().find((x) => x.handle === who?.toLowerCase());
        const project =
          this.store.project(this.threads.threads().find((t) => t.id === this.current.get(chatId))?.projectId ?? '') ?? this.store.projects()[0];
        if (!project) return this.sendText(chatId, 'Add a project in Jogger first.');
        try {
          const t = await this.threads.createThread({
            projectId: project.id,
            personaId: persona?.id ?? null,
            provider: persona ? undefined : who || undefined,
            kind: 'bridge',
            prompt: prompt || undefined,
            origin: { kind: 'telegram', chatId, from: 'telegram' },
          });
          this.setCurrent(chatId, t.id);
          return this.sendText(chatId, `Started @${t.handle} in ${project.name}.${prompt ? '' : ' Send a message to begin.'}`);
        } catch (err) {
          return this.sendText(chatId, (err as Error).message);
        }
      }
      case '/stop': {
        const id = this.current.get(chatId);
        if (id) await this.threads.interrupt(id);
        return this.sendText(chatId, 'Stopped.');
      }
      case '/approvals': {
        const list = this.threads.pendingApprovals();
        if (!list.length) return this.sendText(chatId, 'Nothing is waiting for approval.');
        for (const a of list) await this.sendApproval(chatId, a);
        return;
      }
      default:
        return this.sendText(chatId, 'Unknown command. Try /help.');
    }
  }

  private async sendApproval(chatId: number, a: PendingApproval) {
    const t = this.store.thread(a.threadId);
    const buttons = [{ text: 'Allow', callback_data: `ap:${a.requestId}:a` }];
    if (a.canAllowSession) buttons.push({ text: 'Allow for session', callback_data: `ap:${a.requestId}:s` });
    buttons.push({ text: 'Deny', callback_data: `ap:${a.requestId}:d` });
    await this.sendText(chatId, `@${t?.handle ?? '?'} wants to: ${a.title}\n\n${a.detail.slice(0, 1500)}`, {
      reply_markup: { inline_keyboard: [buttons] },
    });
  }

  private async forwardApprovals(list: PendingApproval[]) {
    if (this.status.status !== 'online' || !this.cfg.forwardApprovals) return;
    for (const a of list) {
      if (this.announced.has(a.requestId)) continue;
      this.announced.add(a.requestId);
      for (const chatId of this.cfg.allowedChatIds) await this.sendApproval(chatId, a);
    }
  }

  private async onCallback(q: any) {
    const chatId: number | undefined = q.message?.chat?.id;
    const m = String(q.data ?? '').match(/^ap:([\w]+):([asd])$/);
    if (!chatId || !this.allowed(chatId) || !m) return this.call('answerCallbackQuery', { callback_query_id: q.id });
    const decision = m[2] === 'a' ? 'allow' : m[2] === 's' ? 'allow_session' : 'deny';
    const done = this.threads.resolveApproval(m[1], decision, 'telegram');
    await this.call('answerCallbackQuery', { callback_query_id: q.id, text: done ? 'Done' : 'Already handled' });
    if (q.message?.message_id)
      await this.call('editMessageReplyMarkup', { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  }

  private async onTurnDone(t: Thread, origin: MessageOrigin, r: TurnResult) {
    if (this.status.status !== 'online') return;
    let chats: number[] = [];
    let prefix = '';
    if (origin.kind === 'telegram') chats = [origin.chatId];
    else if (origin.kind === 'schedule') {
      chats = this.cfg.allowedChatIds;
      prefix = `Scheduled "${origin.name}" (@${t.handle}) ${r.status === 'completed' ? 'finished' : r.status}:\n\n`;
    } else return;
    for (const chatId of chats) {
      const body = r.text || (r.status === 'completed' ? '(no text)' : `Turn ${r.status}${r.error ? ': ' + r.error : ''}`);
      await this.sendText(chatId, prefix + (origin.kind === 'telegram' ? `@${t.handle}: ` : '') + body);
      for (const a of r.attachments) if (a.mime.startsWith('image/')) await this.sendPhoto(chatId, a.path, a.name);
    }
  }
}
