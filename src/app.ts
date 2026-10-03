import { loadConfig, type AppConfig } from './config.ts';
import { Catalog } from './tools/catalog.ts';
import { KnowledgeBase } from './tools/kb.ts';
import { MemoryStore } from './memory/store.ts';
import { createLlm, type LlmProvider } from './llm/provider.ts';
import { createAgent, type Agent } from './agent/index.ts';
import type { AgentResult, Intent } from './agent/types.ts';
import type { Channel, ChannelKind, InboundMessage } from './adapters/types.ts';
import { BotFrameworkChannel } from './adapters/botframework/adapter.ts';
import { TeamsWebChannel } from './adapters/teams-web/adapter.ts';

export interface Counters {
  startedAt: string;
  total: number;
  byIntent: Record<Intent, number>;
  handoffs: number;
  errors: number;
  byChannel: Record<string, number>;
}

export interface CreatedApp {
  cfg: AppConfig;
  catalog: Catalog;
  kb: KnowledgeBase;
  memory: MemoryStore;
  llm: LlmProvider;
  agent: Agent;
  counters: Counters;
  channels: Map<ChannelKind, Channel>;
  /** Roda o agente e contabiliza (sem enviar por canal). */
  process(message: InboundMessage): Promise<AgentResult>;
  /** Roda o agente e envia a resposta pelo canal de origem. */
  dispatch(message: InboundMessage): Promise<AgentResult>;
  close(): Promise<void>;
}

function emptyCounters(): Counters {
  return {
    startedAt: new Date().toISOString(),
    total: 0,
    byIntent: { saudacao: 0, catalogo: 0, pedido: 0, suporte: 0, humano: 0, fora_de_escopo: 0 },
    handoffs: 0,
    errors: 0,
    byChannel: {},
  };
}

export interface CreateAppOptions {
  /** ':memory:' nos testes; por padrão usa DB_PATH. */
  memoryPath?: string;
  /** Cria apenas os canais habilitados na config. */
  includeChannels?: boolean;
}

/**
 * Composition root: um único agente alimentando N transports.
 * Os adapters só normalizam/enviar mensagens — a inteligência fica no grafo.
 */
export function createApp(cfg: AppConfig = loadConfig(), options: CreateAppOptions = {}): CreatedApp {
  const catalog = Catalog.load(cfg.catalogPath);
  const kb = KnowledgeBase.load(cfg.faqPath);
  const memory = new MemoryStore(options.memoryPath ?? cfg.dbPath);
  const llm = createLlm(cfg.llm);
  const agent = createAgent({ catalog, kb, memory, llm, maxAssentosSemEscalonamento: 250 });
  const counters = emptyCounters();
  const channels = new Map<ChannelKind, Channel>();

  if (options.includeChannels !== false) {
    channels.set('botframework', new BotFrameworkChannel(cfg.bot));
    if (cfg.teamsWeb.enabled) {
      channels.set(
        'teams-web',
        new TeamsWebChannel({
          config: cfg.teamsWeb,
          botDisplayName: process.env.TEAMS_WEB_BOT_NAME ?? 'Agente M365',
          seenFile: `${cfg.teamsWeb.userDataDir}/../teams-web-seen.json`,
        }),
      );
    }
  }

  const process = async (message: InboundMessage): Promise<AgentResult> => {
    counters.total += 1;
    counters.byChannel[message.channel] = (counters.byChannel[message.channel] ?? 0) + 1;
    try {
      const result = await agent.handle(message);
      counters.byIntent[result.intent] = (counters.byIntent[result.intent] ?? 0) + 1;
      if (result.handoff) counters.handoffs += 1;
      return result;
    } catch (error) {
      counters.errors += 1;
      console.error(`[app] erro ao processar mensagem: ${(error as Error).message}`);
      return {
        conversationId: message.conversationId,
        channel: message.channel,
        intent: 'fora_de_escopo',
        confidence: 0,
        reply: 'Tive um problema técnico ao processar sua mensagem. Vou registrar e já volto.',
        handoff: false,
        retrieved: [],
        trace: [],
        steps: [],
      };
    }
  };

  const dispatch = async (message: InboundMessage): Promise<AgentResult> => {
    const result = await process(message);
    const channel = channels.get(message.channel);
    if (channel) {
      const sent = await channel.send({
        conversationId: message.conversationId,
        text: result.reply,
        replyToId: message.id,
        handoff: result.handoff,
        raw: message.raw,
      });
      if (!sent.ok) console.warn(`[${message.channel}] falha ao enviar resposta: ${sent.error}`);
    }
    return result;
  };

  const close = async (): Promise<void> => {
    for (const channel of channels.values()) await channel.stop().catch(() => undefined);
    memory.close();
  };

  return { cfg, catalog, kb, memory, llm, agent, counters, channels, process, dispatch, close };
}

/** Liga todos os canais habilitados ao dispatcher do app. */
export async function startChannels(app: CreatedApp): Promise<void> {
  for (const [name, channel] of app.channels) {
    await channel.start((message) => app.dispatch(message).then(() => undefined));
    console.log(`[canal] ${name}: ${channel.status().detail}`);
  }
}
