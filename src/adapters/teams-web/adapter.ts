import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TeamsWebConfig } from '../../config.ts';
import type { Channel, ChannelStatus, InboundHandler, InboundMessage, OutboundMessage, SendResult } from '../types.ts';
import { TeamsWebClient } from './client.ts';

export interface TeamsWebChannelOptions {
  config: TeamsWebConfig;
  /** Nome exibido do agente: mensagens com esse autor são ignoradas. */
  botDisplayName: string;
  /** Arquivo com os ids já processados (evita responder duas vezes). */
  seenFile: string;
  client?: TeamsWebClient;
}

/**
 * Transport pragmático: dirige o Teams Web real num navegador (equivalente ao
 * whatsapp-web.js da lista de referências). Sessão persistente, dedupe por id
 * de mensagem e primeira passada só "priming" (não responde histórico).
 *
 * ATENÇÃO: automatizar o Teams Web contraria os termos da Microsoft para uso
 * não assistido/em massa. Use-o para uso pessoal, demo ou laboratório — em
 * produção use o adapter Bot Framework.
 */
export class TeamsWebChannel implements Channel {
  readonly name = 'teams-web' as const;
  private readonly options: TeamsWebChannelOptions;
  private readonly client: TeamsWebClient;
  private readonly seen = new Set<string>();
  private handler?: InboundHandler;
  private running = false;
  private primed = false;
  private timer?: NodeJS.Timeout;
  private activeChat = '';
  lastError?: string;
  private polls = 0;
  private replies = 0;

  constructor(options: TeamsWebChannelOptions) {
    this.options = options;
    this.client =
      options.client ??
      new TeamsWebClient({
        url: options.config.url,
        userDataDir: options.config.userDataDir,
        headless: options.config.headless,
        channel: options.config.channel,
        botDisplayName: options.botDisplayName,
      });
    try {
      const raw = JSON.parse(readFileSync(options.seenFile, 'utf8')) as string[];
      for (const id of raw) this.seen.add(id);
    } catch {
      /* primeira execução */
    }
  }

  channelIdFor(chatName: string): string {
    return `teams-web:${chatName}`;
  }

  private chatFromChannelId(channelId: string): string {
    return channelId.replace(/^teams-web:/, '');
  }

  status(): ChannelStatus {
    return {
      name: this.name,
      running: this.running,
      detail: this.running
        ? `${this.polls} varredura(s), ${this.replies} resposta(s), chat ativo "${this.activeChat}"${this.lastError ? ` · último erro: ${this.lastError}` : ''}`
        : 'parado',
    };
  }

  async start(handler: InboundHandler): Promise<void> {
    this.handler = handler;
    await this.client.launch();
    if (!(await this.client.isLoggedIn())) {
      if (this.options.config.headless) {
        throw new Error(
          'sessão do Teams não encontrada no perfil persistente. Rode uma vez com TEAMS_WEB_HEADLESS=0 e faça login manualmente.',
        );
      }
      const ok = await this.client.waitForLogin(300_000);
      if (!ok) throw new Error('login não concluído no tempo esperado');
    }
    this.running = true;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.persistSeen();
    await this.client.close();
  }

  /** Varredura única: útil para teste e para um cron externo. */
  async sweep(): Promise<InboundMessage[]> {
    if (!this.handler) return [];
    const delivered: InboundMessage[] = [];
    const targets = await this.resolveTargets();
    for (const target of targets) {
      const opened = await this.client.openChat(target.name);
      if (!opened) continue;
      this.activeChat = target.name;
      const messages = await this.client.readMessages(30);
      const lastAuthors = new Set(messages.filter((message) => message.direction === 'in').map((message) => message.author));
      for (const message of messages) {
        const key = `${target.name}|${message.id}`;
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        if (!this.primed) continue; // primeira passada: histórico não gera resposta
        if (message.direction === 'out') continue;
        const isGroup = lastAuthors.size > 1;
        const mentionsAgent = message.text.toLowerCase().includes(`@${this.options.botDisplayName.toLowerCase()}`);
        if (isGroup && this.options.config.mentionOnly && !mentionsAgent) continue;
        const inbound: InboundMessage = {
          id: message.id,
          channel: 'teams-web',
          conversationId: this.channelIdFor(target.name),
          userId: message.author,
          userName: message.author,
          text: message.text,
          timestamp: new Date().toISOString(),
          isGroup,
          mentionsAgent,
        };
        await this.handler(inbound);
        delivered.push(inbound);
      }
    }
    this.primed = true;
    this.polls += 1;
    this.persistSeen();
    return delivered;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    try {
      const chatName = this.chatFromChannelId(message.conversationId);
      if (this.activeChat !== chatName) {
        this.activeChat = chatName;
        await this.client.openChat(chatName);
      }
      await this.client.sendMessage(message.text);
      this.replies += 1;
      const echo = await this.client.readMessages(3);
      const id = echo.at(-1)?.id;
      return { ok: true, id };
    } catch (error) {
      this.lastError = (error as Error).message;
      return { ok: false, error: this.lastError };
    }
  }

  private async resolveTargets(): Promise<Array<{ name: string }>> {
    if (this.options.config.chats.length > 0) return this.options.config.chats.map((name) => ({ name }));
    const chats = await this.client.listChats();
    const withUnread = chats.filter((chat) => chat.unread > 0);
    return (withUnread.length > 0 ? withUnread : chats.slice(0, 5)).map((chat) => ({ name: chat.name }));
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.sweep()
        .catch((error: Error) => {
          this.lastError = error.message;
        })
        .finally(() => this.schedule());
    }, this.options.config.pollMs);
    this.timer.unref?.();
  }

  private persistSeen(): void {
    try {
      mkdirSync(dirname(this.options.seenFile), { recursive: true });
      writeFileSync(this.options.seenFile, JSON.stringify([...this.seen].slice(-2_000), null, 0));
    } catch {
      /* telemetria é best-effort */
    }
  }
}
