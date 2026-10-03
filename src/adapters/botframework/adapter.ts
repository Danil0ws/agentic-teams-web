import type { BotConfig } from '../../config.ts';
import type { Channel, ChannelStatus, InboundHandler, InboundMessage, OutboundMessage, SendResult } from '../types.ts';
import { verifyBotFrameworkToken } from './auth.ts';

/** Subconjunto do Activity schema do Bot Framework usado pelo Teams. */
export interface Activity {
  type: string;
  id?: string;
  timestamp?: string;
  text?: string;
  from?: { id?: string; name?: string; aadObjectId?: string };
  conversation?: { id?: string; conversationType?: string; tenantId?: string; name?: string };
  channelId?: string;
  serviceUrl?: string;
  recipient?: { id?: string; name?: string };
  entities?: Array<{ type?: string; mentioned?: { id?: string; name?: string }; text?: string }>;
  replyToId?: string;
  [key: string]: unknown;
}

export interface IngestResult {
  status: number;
  body: Record<string, unknown>;
}

const MENTION_MARKUP = /<at>.*?<\/at>/gi;

/** Remove o wrapper <at>Nome</at> que o Teams insere nas menções. */
export function stripMentions(text: string): string {
  return text.replace(MENTION_MARKUP, ' ').replace(/\s+/g, ' ').trim();
}

/** Activity do Teams → mensagem interna do agente (mesmo formato do adapter Web). */
export function activityToInbound(activity: Activity, appId: string): InboundMessage {
  const conversationType = activity.conversation?.conversationType ?? 'personal';
  const mentions = activity.entities?.filter((entity) => entity.type === 'mention') ?? [];
  return {
    id: activity.id ?? `act-${Date.now()}`,
    channel: 'botframework',
    conversationId: activity.conversation?.id ?? 'desconhecida',
    userId: activity.from?.aadObjectId ?? activity.from?.id ?? 'desconhecido',
    userName: activity.from?.name ?? 'Usuário do Teams',
    text: stripMentions(activity.text ?? ''),
    timestamp: activity.timestamp ?? new Date().toISOString(),
    isGroup: conversationType === 'groupChat' || conversationType === 'channel',
    mentionsAgent: mentions.some((entity) => entity.mentioned?.id === appId),
    raw: activity,
  };
}

/**
 * Transport oficial: webhook do Azure Bot Service + envio autenticado em
 * serviceUrl/v3/conversations/{id}/activities. É o caminho suportado pela
 * Microsoft para agentes no Teams (sem automação de UI).
 */
export class BotFrameworkChannel implements Channel {
  readonly name = 'botframework' as const;
  private readonly cfg: BotConfig;
  private handler?: InboundHandler;
  private running = false;
  private readonly refs = new Map<string, { serviceUrl: string; conversationId: string; tenantId?: string }>();
  private token?: { value: string; expiresAt: number };
  lastError?: string;

  constructor(cfg: BotConfig) {
    this.cfg = cfg;
  }

  async start(handler: InboundHandler): Promise<void> {
    this.handler = handler;
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.handler = undefined;
  }

  status(): ChannelStatus {
    const configured = Boolean(this.cfg.appId && this.cfg.appSecret);
    return {
      name: this.name,
      running: this.running,
      detail: this.running
        ? `webhook ativo (appId=${this.cfg.appId || 'não configurado'}, auth=${this.cfg.skipAuth ? 'DESLIGADA (dev)' : 'JWT RS256'})`
        : 'parado',
    };
  }

  /** Autentica a requisição e devolve 401 quando o token não é confiável. */
  async authenticate(authorization: string | undefined, serviceUrl: string | undefined): Promise<{ ok: boolean; reason?: string }> {
    if (this.cfg.skipAuth) return { ok: true, reason: 'BOT_SKIP_AUTH=1 (apenas desenvolvimento)' };
    if (!this.cfg.appId) return { ok: false, reason: 'BOT_APP_ID não configurado' };
    const token = (authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return { ok: false, reason: 'header Authorization ausente' };
    const result = await verifyBotFrameworkToken(token, { appId: this.cfg.appId, serviceUrl });
    return { ok: result.ok, reason: result.reason };
  }

  /** Normaliza a Activity, roda o agente e devolve a resposta do webhook. */
  async ingest(activity: Activity, authorization?: string): Promise<IngestResult> {
    if (!this.running || !this.handler) return { status: 503, body: { error: 'canal parado' } };
    const auth = await this.authenticate(authorization, activity.serviceUrl);
    if (!auth.ok) return { status: 401, body: { error: 'não autorizado', reason: auth.reason } };
    if (activity.conversation?.id && activity.serviceUrl) {
      this.refs.set(activity.conversation.id, {
        serviceUrl: activity.serviceUrl,
        conversationId: activity.conversation.id,
        tenantId: activity.conversation.tenantId,
      });
    }
    if (activity.type !== 'message' || !activity.text?.trim()) {
      return { status: 200, body: { ok: true, ignored: `activity.type=${activity.type}` } };
    }
    const inbound = activityToInbound(activity, this.cfg.appId);
    await this.handler(inbound);
    return { status: 200, body: { ok: true, conversationId: inbound.conversationId, text: inbound.text } };
  }

  /** Token app-only (client_credentials) para chamar o Bot Connector. */
  private async connectorToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAt > now + 60_000) return this.token.value;
    if (!this.cfg.appId || !this.cfg.appSecret) throw new Error('BOT_APP_ID/BOT_APP_SECRET ausentes');
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.cfg.appId,
      client_secret: this.cfg.appSecret,
      scope: `${this.cfg.appId}/.default`,
    });
    const response = await fetch(`${this.cfg.loginBaseUrl}/${this.cfg.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response.ok) throw new Error(`token ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const payload = (await response.json()) as { access_token: string; expires_in?: number };
    this.token = { value: payload.access_token, expiresAt: now + (payload.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const ref = this.refs.get(message.conversationId);
    const serviceUrl = (message.raw as { serviceUrl?: string } | undefined)?.serviceUrl ?? ref?.serviceUrl ?? this.cfg.serviceUrl;
    const base = serviceUrl.endsWith('/') ? serviceUrl : `${serviceUrl}/`;
    try {
      const token = await this.connectorToken();
      const response = await fetch(`${base}v3/conversations/${encodeURIComponent(message.conversationId)}/activities`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          type: 'message',
          text: message.text,
          textFormat: 'markdown',
          ...(message.replyToId ? { replyToId: message.replyToId } : {}),
        }),
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 200);
        this.lastError = `${response.status}: ${detail}`;
        return { ok: false, error: this.lastError };
      }
      const payload = (await response.json().catch(() => ({}))) as { id?: string };
      return { ok: true, id: payload.id };
    } catch (error) {
      this.lastError = (error as Error).message;
      return { ok: false, error: this.lastError };
    }
  }
}
