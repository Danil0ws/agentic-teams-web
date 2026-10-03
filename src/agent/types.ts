import type { ChannelKind, InboundMessage } from '../adapters/types.ts';
import type { CatalogItem, Quote } from '../tools/catalog.ts';
import type { StoredMessage } from '../memory/store.ts';

export type Intent = 'saudacao' | 'catalogo' | 'pedido' | 'suporte' | 'humano' | 'fora_de_escopo';

export interface RetrievedItem {
  id: string;
  titulo: string;
  trecho: string;
  score: number;
  fonte: 'faq' | 'catalogo';
  sku?: string;
}

export interface ToolOutcome {
  tool: 'catalogo.quote' | 'catalogo.search' | 'kb.search' | 'ticket.create' | 'nenhuma';
  ok: boolean;
  resumo: string;
  data?: unknown;
}

export interface HandoffInfo {
  required: boolean;
  reason: string;
  ticketId?: number;
}

export interface AgentState {
  message: InboundMessage;
  history: StoredMessage[];
  intent: Intent;
  confidence: number;
  retrieved: RetrievedItem[];
  request: Array<{ sku: string; qtd: number }>;
  quote?: Quote;
  tool?: ToolOutcome;
  handoff: HandoffInfo;
  reply: string;
  trace: string[];
  meta: Record<string, unknown>;
}

export interface AgentResult {
  conversationId: string;
  channel: ChannelKind;
  intent: Intent;
  confidence: number;
  reply: string;
  handoff: boolean;
  handoffReason?: string;
  ticketId?: number;
  retrieved: RetrievedItem[];
  quote?: Quote;
  trace: string[];
  steps: Array<{ node: string; next: string; ms: number }>;
}

export interface AgentDeps {
  catalog: import('../tools/catalog.ts').Catalog;
  kb: import('../tools/kb.ts').KnowledgeBase;
  memory: import('../memory/store.ts').MemoryStore;
  llm: import('../llm/provider.ts').LlmProvider;
  /** Pedidos acima deste total de assentos são escalados ao time comercial. */
  maxAssentosSemEscalonamento: number;
}

export type { CatalogItem };
