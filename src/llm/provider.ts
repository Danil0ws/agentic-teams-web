import type { LlmConfig } from '../config.ts';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Pede resposta JSON ao provedor (response_format json_object quando suportado). */
  json?: boolean;
}

export interface LlmProvider {
  readonly kind: 'offline' | 'remote';
  readonly model: string;
  complete(request: LlmRequest): Promise<string>;
  /** Retorna JSON parseado; lança se o modelo não devolver JSON válido. */
  completeJson<T>(request: LlmRequest): Promise<T>;
}

function parseJsonLoose<T>(text: string): T {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`resposta sem JSON: ${text.slice(0, 120)}`);
  return JSON.parse(trimmed.slice(start, end + 1)) as T;
}

/**
 * Provedor determinístico, sem rede e sem chave. Não "inventa" linguagem:
 * devolve string vazia e deixa os nós do agente usarem as regras/templates.
 * É o modo padrão para desenvolvimento e para a suíte de testes.
 */
export class OfflineProvider implements LlmProvider {
  readonly kind = 'offline' as const;
  readonly model: string;

  constructor(model = 'offline-template') {
    this.model = model;
  }

  async complete(): Promise<string> {
    return '';
  }

  async completeJson<T>(): Promise<T> {
    throw new Error('provedor offline não gera JSON');
  }
}

/** Cliente de qualquer endpoint compatível com a API /chat/completions. */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly kind = 'remote' as const;
  private readonly cfg: LlmConfig;

  constructor(cfg: LlmConfig) {
    this.cfg = cfg;
  }

  get model(): string {
    return this.cfg.model;
  }

  async complete(request: LlmRequest): Promise<string> {
    if (!this.cfg.apiKey) throw new Error('LLM_API_KEY ausente');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const response = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: this.cfg.model,
          messages: request.messages,
          temperature: request.temperature ?? this.cfg.temperature,
          max_tokens: request.maxTokens ?? this.cfg.maxTokens,
          ...(request.json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`LLM ${response.status}: ${body.slice(0, 300)}`);
      }
      const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return payload.choices?.[0]?.message?.content?.trim() ?? '';
    } finally {
      clearTimeout(timer);
    }
  }

  async completeJson<T>(request: LlmRequest): Promise<T> {
    return parseJsonLoose<T>(await this.complete({ ...request, json: true }));
  }
}

export function createLlm(cfg: LlmConfig): LlmProvider {
  return cfg.kind === 'openai' ? new OpenAiCompatibleProvider(cfg) : new OfflineProvider(cfg.model);
}
