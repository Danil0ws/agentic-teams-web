import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, createSign, type KeyObject } from 'node:crypto';
import { verifyBotFrameworkToken, type JwtPayload } from '../src/adapters/botframework/auth.ts';
import { BotFrameworkChannel, activityToInbound, stripMentions } from '../src/adapters/botframework/adapter.ts';
import type { BotConfig } from '../src/config.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = 'test-kid';
const jwk = { kid, ...(publicKey.export({ format: 'jwk' }) as { kty: string; n: string; e: string }) };
const APP_ID = 'app-id-teste';

function signToken(payload: JwtPayload, key: KeyObject = privateKey, header: Record<string, unknown> = { alg: 'RS256', kid, typ: 'JWT' }): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(key).toString('base64url')}`;
}

const serviceUrl = 'https://smba.trafficmanager.net/teams/';

function safeJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

const basePayload: JwtPayload = {
  aud: APP_ID,
  iss: 'https://api.botframework.com',
  exp: Math.floor(Date.now() / 1000) + 3_600,
  nbf: Math.floor(Date.now() / 1000) - 60,
  serviceurl: serviceUrl,
};

test('valida token legítimo do Bot Framework (RS256 + aud + serviceurl)', async () => {
  const result = await verifyBotFrameworkToken(signToken(basePayload), { appId: APP_ID, serviceUrl, keys: [jwk] });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.payload?.aud, APP_ID);
});

test('rejeita assinatura adulterada, alg "none", audience errada e token expirado', async () => {
  const valid = signToken(basePayload);
  const [header, payload] = valid.split('.');
  const tampered = `${header}.${payload}.${Buffer.from('assinatura-falsa').toString('base64url')}`;
  assert.equal((await verifyBotFrameworkToken(tampered, { appId: APP_ID, keys: [jwk] })).ok, false);

  const noneAlg = signToken(basePayload, privateKey, { alg: 'none', kid });
  const noneResult = await verifyBotFrameworkToken(noneAlg, { appId: APP_ID, keys: [jwk] });
  assert.equal(noneResult.ok, false);
  assert.match(String(noneResult.reason), /alg/);

  const outraAudiencia = signToken({ ...basePayload, aud: 'outro-app' });
  assert.match(String((await verifyBotFrameworkToken(outraAudiencia, { appId: APP_ID, keys: [jwk] })).reason), /audience/);

  const expirado = signToken({ ...basePayload, exp: Math.floor(Date.now() / 1000) - 3_600 });
  assert.match(String((await verifyBotFrameworkToken(expirado, { appId: APP_ID, keys: [jwk] })).reason), /expirado/);

  const outroServiceUrl = signToken({ ...basePayload, serviceurl: 'https://atacante.example.com/' });
  assert.match(String((await verifyBotFrameworkToken(outroServiceUrl, { appId: APP_ID, serviceUrl, keys: [jwk] })).reason), /serviceurl/);

  assert.equal((await verifyBotFrameworkToken('nao-e-jwt', { appId: APP_ID, keys: [jwk] })).ok, false);
});

test('Activity do Teams é normalizada para o formato interno', () => {
  const inbound = activityToInbound(
    {
      type: 'message',
      id: 'a1',
      text: '<at>Agente M365</at> quanto custa o Copilot?',
      from: { id: 'u1', aadObjectId: 'aad-1', name: 'Ana' },
      conversation: { id: 'c1', conversationType: 'groupChat' },
      entities: [{ type: 'mention', mentioned: { id: APP_ID, name: 'Agente M365' } }],
    },
    APP_ID,
  );
  assert.equal(inbound.text, 'quanto custa o Copilot?');
  assert.equal(inbound.isGroup, true);
  assert.equal(inbound.mentionsAgent, true);
  assert.equal(inbound.userId, 'aad-1');
  assert.equal(inbound.channel, 'botframework');
  assert.equal(stripMentions('oi'), 'oi');
});

test('ingest recusa Activity sem token quando a validação está ativa', async () => {
  const cfg: BotConfig = { appId: APP_ID, appSecret: 's', tenantId: 'botframework.com', skipAuth: false, serviceUrl, loginBaseUrl: 'https://login.microsoftonline.com' };
  const channel = new BotFrameworkChannel(cfg);
  await channel.start(async () => undefined);
  const result = await channel.ingest({ type: 'message', text: 'oi', conversation: { id: 'c1' }, serviceUrl }, undefined);
  assert.equal(result.status, 401);
  assert.match(String(result.body.reason), /Authorization/);
  await channel.stop();
});

test('send publica Activity autenticada no serviceUrl (token app-only)', async () => {
  const received: Array<{ url: string; authorization?: string; body: any }> = [];
  const stub: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(chunk as Buffer));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const isTokenRequest = (request.url ?? '').includes('/oauth2/v2.0/token');
      // O token vai form-encoded; a Activity vai em JSON.
      const body = isTokenRequest ? Object.fromEntries(new URLSearchParams(raw)) : safeJson(raw);
      received.push({ url: request.url ?? '', authorization: request.headers.authorization, body });
      response.writeHead(isTokenRequest ? 200 : 201, { 'content-type': 'application/json' });
      response.end(JSON.stringify(isTokenRequest ? { access_token: 'stub-token', expires_in: 3600 } : { id: 'activity-out-1' }));
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const { port } = stub.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const cfg: BotConfig = { appId: APP_ID, appSecret: 'segredo', tenantId: 'tenant-dev', skipAuth: false, serviceUrl: `${base}/teams/`, loginBaseUrl: base };
  const channel = new BotFrameworkChannel(cfg);
  await channel.start(async () => undefined);
  const sent = await channel.send({ conversationId: 'conv-42', text: 'Resposta do agente', replyToId: 'act-1' });
  assert.equal(sent.ok, true, sent.error);
  assert.equal(sent.id, 'activity-out-1');

  const tokenCall = received.find((entry) => entry.url.includes('/oauth2/v2.0/token'));
  assert.ok(tokenCall, 'deve pedir token app-only');
  assert.match(tokenCall!.url, /tenant-dev\/oauth2\/v2\.0\/token/);

  const activityCall = received.find((entry) => entry.url.includes('/activities'));
  assert.ok(activityCall, 'deve postar a Activity');
  assert.equal(activityCall!.url, '/teams/v3/conversations/conv-42/activities');
  assert.equal(activityCall!.authorization, 'Bearer stub-token');
  assert.equal(activityCall!.body.text, 'Resposta do agente');
  assert.equal(activityCall!.body.replyToId, 'act-1');

  await channel.stop();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

test('send falha de forma explícita sem credenciais', async () => {
  const channel = new BotFrameworkChannel({ appId: '', appSecret: '', tenantId: 'botframework.com', skipAuth: false, serviceUrl, loginBaseUrl: 'http://127.0.0.1:1' });
  await channel.start(async () => undefined);
  const sent = await channel.send({ conversationId: 'c1', text: 'oi' });
  assert.equal(sent.ok, false);
  assert.match(String(sent.error), /BOT_APP_ID/);
  await channel.stop();
});
