import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CreatedApp } from '../app.ts';
import type { BotFrameworkChannel, Activity } from '../adapters/botframework/adapter.ts';

export interface ServerOptions {
  /** Habilita POST /api/simulate (testar o agente sem Teams). */
  simulateEnabled?: boolean;
  /** Serve o dashboard em GET /. */
  dashboard?: boolean;
}

const MAX_BODY = 1_000_000;

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('payload acima de 1 MB');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

function send(response: ServerResponse, status: number, body: unknown, contentType = 'application/json; charset=utf-8'): void {
  const payload = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  response.writeHead(status, { 'content-type': contentType, 'content-length': Buffer.byteLength(payload) });
  response.end(payload);
}

/**
 * HTTP do agente:
 *   POST /api/messages  → webhook do Azure Bot Service (Teams oficial)
 *   POST /api/simulate  → injeta uma mensagem local (dev)
 *   GET  /health | /api/metrics | /api/tickets | /api/conversations
 */
export function createHttpServer(app: CreatedApp, options: ServerOptions = {}): Server {
  const dashboardHtml = options.dashboard === false ? '' : readFileSync(join(import.meta.dirname, 'dashboard.html'), 'utf8');
  const simulateEnabled = options.simulateEnabled ?? true;

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const route = `${request.method} ${url.pathname}`;
    try {
      if (route === 'GET /health') {
        send(response, 200, {
          status: 'ok',
          uptimeSeconds: Math.round((Date.now() - new Date(app.counters.startedAt).getTime()) / 1000),
          llm: { kind: app.llm.kind, model: app.llm.model },
          channels: [...app.channels.values()].map((channel) => channel.status()),
          stats: app.memory.stats(),
        });
        return;
      }

      if (route === 'GET /api/metrics') {
        send(response, 200, { counters: app.counters, stats: app.memory.stats() });
        return;
      }

      if (route === 'GET /api/tickets') {
        send(response, 200, { tickets: app.memory.listTickets(50) });
        return;
      }

      if (route === 'GET /api/conversations') {
        send(response, 200, { conversations: app.memory.recentConversations(25) });
        return;
      }

      if (route === 'POST /api/messages') {
        const channel = app.channels.get('botframework') as BotFrameworkChannel | undefined;
        if (!channel) {
          send(response, 503, { error: 'canal botframework não inicializado' });
          return;
        }
        const activity = await readJson<Activity>(request);
        const result = await channel.ingest(activity, request.headers.authorization);
        send(response, result.status, result.body);
        return;
      }

      if (route === 'POST /api/simulate') {
        if (!simulateEnabled) {
          send(response, 403, { error: 'simulação desabilitada' });
          return;
        }
        const body = await readJson<{ text?: string; conversationId?: string; userName?: string; channel?: 'teams-web' | 'botframework' }>(request);
        if (!body.text?.trim()) {
          send(response, 400, { error: 'campo "text" é obrigatório' });
          return;
        }
        const result = await app.process({
          id: `sim-${Date.now()}`,
          channel: body.channel ?? 'botframework',
          conversationId: body.conversationId ?? 'simulacao-local',
          userId: body.userName ?? 'dev-local',
          userName: body.userName ?? 'Dev Local',
          text: body.text,
          timestamp: new Date().toISOString(),
          isGroup: false,
          mentionsAgent: true,
        });
        send(response, 200, result);
        return;
      }

      if (route === 'GET /' && dashboardHtml) {
        send(response, 200, dashboardHtml, 'text/html; charset=utf-8');
        return;
      }

      send(response, 404, { error: 'rota não encontrada', route });
    } catch (error) {
      send(response, 500, { error: (error as Error).message });
    }
  });
}
