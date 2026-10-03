import { mkdirSync } from 'node:fs';
import type { BrowserChannel } from '../../config.ts';
import { selectors, firstVisible } from './selectors.ts';

export interface TeamsWebClientOptions {
  url: string;
  userDataDir: string;
  headless: boolean;
  channel: BrowserChannel;
  timeoutMs?: number;
  /** Nome exibido do agente: usado para ignorar as próprias mensagens. */
  botDisplayName?: string;
}

export interface ChatSummary {
  name: string;
  unread: number;
  index: number;
}

export interface ChatMessage {
  id: string;
  author: string;
  text: string;
  direction: 'in' | 'out';
}

interface PlaywrightLike {
  chromium: {
    launchPersistentContext(dir: string, options: Record<string, unknown>): Promise<unknown>;
  };
}

/**
 * Cliente do Teams Web via Playwright. Nenhuma credencial passa por aqui:
 * a sessão vive no userDataDir (perfil persistente) e o login é manual,
 * uma única vez. Use TEAMS_WEB_HEADLESS=0 para a janela aparecer.
 */
export class TeamsWebClient {
  private readonly options: TeamsWebClientOptions;
  private context?: any;
  private page?: any;

  constructor(options: TeamsWebClientOptions) {
    this.options = options;
  }

  private get timeout(): number {
    return this.options.timeoutMs ?? 30_000;
  }

  private async loadPlaywright(): Promise<PlaywrightLike> {
    try {
      return (await import('playwright')) as unknown as PlaywrightLike;
    } catch (error) {
      throw new Error(
        `playwright não instalado (${(error as Error).message}). Rode: npm i -D playwright && npx playwright install chromium`,
      );
    }
  }

  async launch(): Promise<void> {
    if (this.context) return;
    mkdirSync(this.options.userDataDir, { recursive: true });
    const { chromium } = await this.loadPlaywright();
    this.context = await chromium.launchPersistentContext(this.options.userDataDir, {
      headless: this.options.headless,
      channel: this.options.channel,
      viewport: { width: 1440, height: 900 },
      locale: 'pt-BR',
      args: ['--disable-blink-features=AutomationControlled'],
    });
    const pages: any[] = this.context.pages();
    this.page = pages[0] ?? (await this.context.newPage());
    await this.page.goto(this.options.url, { waitUntil: 'domcontentloaded', timeout: this.timeout });
  }

  async close(): Promise<void> {
    await this.context?.close();
    this.context = undefined;
    this.page = undefined;
  }

  private async anyOf(key: keyof typeof selectors): Promise<any | undefined> {
    for (const candidate of selectors[key]) {
      const locator = this.page.locator(candidate).first();
      if (await locator.count().catch(() => 0)) return locator;
    }
    return undefined;
  }

  /** Logado = app carregado e nenhuma tela de login visível. */
  async isLoggedIn(): Promise<boolean> {
    if (!this.page) return false;
    const onLoginHost = /login\.(microsoftonline|live)\.com/.test(this.page.url());
    if (onLoginHost) return false;
    const wall = await this.anyOf('loginWall');
    if (wall && (await wall.isVisible().catch(() => false))) return false;
    const composer = await this.anyOf('composer');
    const chatList = await this.anyOf('chatList');
    const hasComposer = composer ? await composer.isVisible().catch(() => false) : false;
    const hasChatList = chatList ? await chatList.isVisible().catch(() => false) : false;
    return Boolean(hasComposer || hasChatList);
  }

  async waitForLogin(timeoutMs = 180_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isLoggedIn()) return true;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    return false;
  }

  async listChats(): Promise<ChatSummary[]> {
    const list = await this.anyOf('chatList');
    if (!list) return [];
    const items = list.locator(firstVisible(selectors.chatItem));
    const total = await items.count();
    const chats: ChatSummary[] = [];
    for (let index = 0; index < total; index += 1) {
      const item = items.nth(index);
      const badgeLocator = item.locator(firstVisible(selectors.unreadBadge)).first();
      const badge = await badgeLocator.innerText().catch(() => '');
      const unread = Number(badge.replace(/\D+/g, '')) || 0;

      // O título vem do nó dedicado; se o DOM mudou, cai para o texto do item
      // removendo o contador de não lidas que fica dentro dele.
      let title = (await item.locator(firstVisible(selectors.chatItemTitle)).first().innerText().catch(() => '')).trim();
      if (!title) {
        const raw = await item.innerText().catch(() => '');
        title = raw.split('\n').map((line) => line.trim()).filter(Boolean)[0] ?? `chat-${index}`;
      }
      if (badge.trim() && title.endsWith(badge.trim())) title = title.slice(0, -badge.trim().length).trim();
      if (unread > 0) title = title.replace(new RegExp(`\\s*${unread}$`), '').trim();
      chats.push({ name: title || `chat-${index}`, unread, index });
    }
    return chats;
  }

  async openChat(name: string): Promise<boolean> {
    const list = await this.anyOf('chatList');
    if (!list) return false;
    const items = list.locator(firstVisible(selectors.chatItem));
    const total = await items.count();
    for (let index = 0; index < total; index += 1) {
      const item = items.nth(index);
      const text = await item.innerText().catch(() => '');
      if (text.toLowerCase().includes(name.toLowerCase())) {
        await item.click({ timeout: this.timeout });
        await this.waitForMessages();
        return true;
      }
    }
    return false;
  }

  private async waitForMessages(): Promise<void> {
    const list = await this.anyOf('messageList');
    await list?.waitFor({ state: 'visible', timeout: this.timeout }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  /** Lê as últimas mensagens do chat aberto, na ordem cronológica. */
  async readMessages(limit = 20): Promise<ChatMessage[]> {
    const list = await this.anyOf('messageList');
    if (!list) return [];
    const items = list.locator(firstVisible(selectors.messageItem));
    const total = await items.count();
    const start = Math.max(0, total - limit);
    const messages: ChatMessage[] = [];
    for (let index = start; index < total; index += 1) {
      const item = items.nth(index);
      const author = (await item.locator(firstVisible(selectors.messageAuthor)).first().innerText().catch(() => '')).trim();
      const body = item.locator(firstVisible(selectors.messageBody)).first();
      const text = (await (await Promise.resolve(body)).innerText().catch(() => '')).trim();
      if (!text) continue;
      const id = await item.getAttribute('data-message-id').catch(() => null);
      const resolvedAuthor = author || (await item.getAttribute('data-author').catch(() => null)) || 'desconhecido';
      messages.push({
        id: id ?? `msg-${index}-${Buffer.from(`${resolvedAuthor}:${text}`).toString('base64url').slice(0, 24)}`,
        author: resolvedAuthor,
        text,
        direction: resolvedAuthor === (this.options.botDisplayName ?? '__agente__') ? 'out' : 'in',
      });
    }
    return messages;
  }

  /** Escreve no compositor e envia (Enter ou botão Enviar). */
  async sendMessage(text: string): Promise<void> {
    const composer = await this.anyOf('composer');
    if (!composer) throw new Error('compositor de mensagem não encontrado (DOM do Teams mudou?)');
    await composer.click({ timeout: this.timeout });
    await composer.fill(text);
    const sendButton = await this.anyOf('sendButton');
    if (sendButton && (await sendButton.isEnabled().catch(() => false))) {
      await sendButton.click({ timeout: this.timeout });
    } else {
      await composer.press('Enter');
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
  }

  /** Snapshot textual do chat aberto — usado no QA e em logs de erro. */
  async snapshot(): Promise<string> {
    if (!this.page) return '';
    return (await this.page.evaluate(() => document.body.innerText)).slice(0, 4_000);
  }
}
