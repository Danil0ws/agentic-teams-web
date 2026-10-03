import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TeamsWebChannel } from '../src/adapters/teams-web/adapter.ts';
import { TeamsWebClient, type ChatMessage, type ChatSummary } from '../src/adapters/teams-web/client.ts';
import type { TeamsWebConfig } from '../src/config.ts';

const config = (overrides: Partial<TeamsWebConfig> = {}): TeamsWebConfig => ({
  enabled: true,
  url: 'about:blank',
  userDataDir: fileURLToPath(new URL('../.telemetry/test-teams-profile', import.meta.url)),
  headless: true,
  channel: 'chrome',
  pollMs: 60_000,
  chats: ['Comercial'],
  mentionOnly: true,
  ...overrides,
});

/** Cliente falso: exercita a lógica do adapter (priming, dedupe, menções) sem navegador. */
class FakeClient {
  sent: Array<{ chat: string; text: string }> = [];
  opened: string[] = [];
  private readonly inbox: Record<string, ChatMessage[]>;

  constructor(inbox: Record<string, ChatMessage[]>) {
    this.inbox = inbox;
  }
  async launch(): Promise<void> {}
  async close(): Promise<void> {}
  async isLoggedIn(): Promise<boolean> {
    return true;
  }
  async waitForLogin(): Promise<boolean> {
    return true;
  }
  async listChats(): Promise<ChatSummary[]> {
    return Object.keys(this.inbox).map((name, index) => ({ name, unread: 1, index }));
  }
  async openChat(name: string): Promise<boolean> {
    this.opened.push(name);
    return name in this.inbox;
  }
  async readMessages(): Promise<ChatMessage[]> {
    const chat = this.opened.at(-1) ?? '';
    return [...(this.inbox[chat] ?? []), ...this.sent.filter((entry) => entry.chat === chat).map((entry, index) => ({ id: `out-${index}`, author: 'Agente M365', text: entry.text, direction: 'out' as const }))];
  }
  async sendMessage(text: string): Promise<void> {
    this.sent.push({ chat: this.opened.at(-1) ?? '', text });
  }
  async snapshot(): Promise<string> {
    return '';
  }
}

/** Cada teste usa um arquivo de "já processados" próprio: o estado de dedupe persiste de propósito. */
function freshSeenFile(name: string): string {
  const path = fileURLToPath(new URL(`../.telemetry/test-teams-seen-${name}.json`, import.meta.url));
  rmSync(path, { force: true });
  return path;
}

test('adapter faz priming na primeira varredura e responde só o que é novo', async () => {
  const inbox = {
    Comercial: [{ id: 'h1', author: 'Ana', text: 'mensagem antiga', direction: 'in' as const }],
  };
  const client = new FakeClient(inbox);
  const channel = new TeamsWebChannel({ config: config(), botDisplayName: 'Agente M365', seenFile: freshSeenFile('priming'), client: client as unknown as TeamsWebClient });
  const handled: string[] = [];
  await channel.start(async (message) => {
    handled.push(message.text);
    await channel.send({ conversationId: message.conversationId, text: `eco: ${message.text}` });
  });

  const primeira = await channel.sweep();
  assert.deepEqual(primeira, [], 'histórico não deve gerar resposta');
  assert.deepEqual(handled, []);

  inbox.Comercial.push({ id: 'h2', author: 'Ana', text: 'nova dúvida sobre Copilot', direction: 'in' });
  const segunda = await channel.sweep();
  assert.equal(segunda.length, 1);
  assert.deepEqual(handled, ['nova dúvida sobre Copilot']);
  assert.deepEqual(client.sent, [{ chat: 'Comercial', text: 'eco: nova dúvida sobre Copilot' }]);

  const terceira = await channel.sweep();
  assert.equal(terceira.length, 0, 'dedupe por id de mensagem');
  assert.equal(channel.status().running, true);
  await channel.stop();
});

test('adapter ignora fala de grupo sem menção quando mentionOnly está ligado', async () => {
  const inbox = {
    Comercial: [
      { id: 'g1', author: 'Ana', text: 'bom dia', direction: 'in' as const },
      { id: 'g2', author: 'Bruno', text: 'sem mencao aqui', direction: 'in' as const },
    ],
  };
  const client = new FakeClient(inbox);
  const channel = new TeamsWebChannel({ config: config(), botDisplayName: 'Agente M365', seenFile: freshSeenFile('mencao'), client: client as unknown as TeamsWebClient });
  const handled: string[] = [];
  await channel.start(async (message) => {
    handled.push(message.text);
  });
  await channel.sweep(); // priming
  inbox.Comercial.push({ id: 'g3', author: 'Ana', text: '@Agente M365 e o preço do Copilot?', direction: 'in' });
  inbox.Comercial.push({ id: 'g4', author: 'Bruno', text: 'conversa paralela sem chamar o agente', direction: 'in' });
  const delivered = await channel.sweep();
  assert.equal(delivered.length, 1);
  assert.match(handled[0] ?? '', /preço do Copilot/);
  assert.equal(delivered[0]?.mentionsAgent, true);
  await channel.stop();
});

test('adapter resolve o chat pelo conversationId ao enviar', async () => {
  const client = new FakeClient({ Suporte: [], Comercial: [] });
  const channel = new TeamsWebChannel({
    config: config({ chats: [] }),
    botDisplayName: 'Agente M365',
    seenFile: freshSeenFile('envio'),
    client: client as unknown as TeamsWebClient,
  });
  await channel.start(async () => undefined);
  const sent = await channel.send({ conversationId: 'teams-web:Suporte', text: 'chamado #7 aberto' });
  assert.equal(sent.ok, true);
  assert.deepEqual(client.sent, [{ chat: 'Suporte', text: 'chamado #7 aberto' }]);
  assert.deepEqual(client.opened, ['Suporte']);
  await channel.stop();
});

test('cliente Playwright lê e envia no DOM do Teams (fixture de QA)', async (t) => {
  let client: TeamsWebClient | undefined;
  try {
    client = new TeamsWebClient({
      url: pathToFileURL(fileURLToPath(new URL('fixtures/teams-web.html', import.meta.url))).href,
      userDataDir: fileURLToPath(new URL('.telemetry/playwright-profile', new URL('../', import.meta.url))),
      headless: true,
      channel: 'chrome',
      botDisplayName: 'Agente M365',
      timeoutMs: 15_000,
    });
    await client.launch();
  } catch (error) {
    t.skip(`playwright/Chrome indisponível: ${(error as Error).message}`);
    return;
  }

  try {
    assert.equal(await client.isLoggedIn(), true, 'fixture deve parecer sessão válida');

    const chats = await client.listChats();
    assert.deepEqual(chats.map((chat) => chat.name), ['Comercial', 'Suporte Interno']);
    assert.equal(chats[0]?.unread, 2);

    assert.equal(await client.openChat('Comercial'), true);
    const messages = await client.readMessages(10);
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.author, 'Ana Souza');
    assert.match(messages[0]?.text ?? '', /Copilot/);
    assert.equal(messages[0]?.direction, 'in');

    await client.sendMessage('Segue o orçamento com 10% de desconto.');
    const after = await client.readMessages(10);
    const outbound = after.filter((message) => message.direction === 'out');
    assert.equal(outbound.length, 1);
    assert.match(outbound[0]?.text ?? '', /orçamento/);
    assert.equal(outbound[0]?.author, 'Agente M365');

    const snapshot = await client.snapshot();
    assert.match(snapshot, /Segue o orçamento/);
  } finally {
    await client?.close();
  }
});
