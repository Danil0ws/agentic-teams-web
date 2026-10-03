import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { createHttpServer } from '../src/server/http.ts';
import type { BotFrameworkChannel } from '../src/adapters/botframework/adapter.ts';

async function boot(overrides: { skipAuth: boolean }): Promise<{ base: string; close: () => Promise<void>; app: ReturnType<typeof createApp> }> {
  const cfg = loadConfig({
    dbPath: ':memory:',
    bot: { skipAuth: overrides.skipAuth, appId: 'dev-app-id', appSecret: 'dev-secret' },
  });
  const app = createApp(cfg, { memoryPath: ':memory:' });
  const channel = app.channels.get('botframework') as BotFrameworkChannel;
  await channel.start((msg) => app.dispatch(msg).then(() => undefined));
  const server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    app,
    close: async () => {
      server.close();
      await app.close();
    },
  };
}

function activity(text: string): Record<string, unknown> {
  return {
    type: 'message',
    id: `act-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    text,
    from: { id: 'aad-1', aadObjectId: 'aad-1', name: 'Ana Souza' },
    conversation: { id: 'conv-http-1', conversationType: 'personal', tenantId: 'tenant-dev' },
    channelId: 'msteams',
    serviceUrl: 'https://smba.trafficmanager.net/teams/',
  };
}

test('GET /health expõe canais, LLM e estatísticas', async () => {
  const { base, close } = await boot({ skipAuth: true });
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.status, 'ok');
  assert.equal(health.llm.kind, 'offline');
  assert.equal(health.channels[0].name, 'botframework');
  assert.equal(health.channels[0].running, true);
  assert.equal(typeof health.stats.messages, 'number');
  await close();
});

test('POST /api/simulate roda o agente localmente e devolve o trace', async () => {
  const { base, app, close } = await boot({ skipAuth: true });
  const response = await fetch(`${base}/api/simulate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Quero 30 licenças do Copilot', userName: 'Ana' }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.intent, 'pedido');
  assert.equal(result.quote.assentos, 30);
  assert.equal(result.quote.descontoPct, 0.1);
  assert.deepEqual(result.trace, ['hydrate', 'classify', 'retrieve', 'quote', 'compose', 'guard', 'remember']);
  assert.equal(app.memory.stats().messages, 2);
  assert.equal(app.counters.total, 1, 'simulação também conta nas métricas');
  assert.equal(app.counters.byIntent.pedido, 1);
  assert.equal(app.counters.byChannel.botframework, 1);
  await close();
});

test('POST /api/simulate valida corpo obrigatório', async () => {
  const { base, close } = await boot({ skipAuth: true });
  const response = await fetch(`${base}/api/simulate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 400);
  await close();
});

test('webhook do Teams aceita Activity quando a validação está desligada (dev)', async () => {
  const { base, close } = await boot({ skipAuth: true });
  const response = await fetch(`${base}/api/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(activity('Qual é o SLA do Teams?')),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.conversationId, 'conv-http-1');
  await close();
});

test('webhook rejeita requisição sem Bearer token válido', async () => {
  const { base, close } = await boot({ skipAuth: false });
  const response = await fetch(`${base}/api/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(activity('oi')),
  });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.match(body.reason, /Authorization/);
  await close();
});

test('ignora Activities que não são de mensagem (typing, conversationUpdate)', async () => {
  const { base, close } = await boot({ skipAuth: true });
  const response = await fetch(`${base}/api/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...activity(''), type: 'typing' }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ignored, 'activity.type=typing');
  await close();
});

test('rotas inválidas devolvem 404 com a rota pedida', async () => {
  const { base, close } = await boot({ skipAuth: true });
  const response = await fetch(`${base}/api/inexistente`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).route, 'GET /api/inexistente');
  await close();
});

test('dashboard é servido como HTML em GET /', async () => {
  const { base, close } = await boot({ skipAuth: true });
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  const html = await response.text();
  assert.match(html, /Agente Microsoft Teams/);
  await close();
});
