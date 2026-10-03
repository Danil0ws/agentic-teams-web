import type { AgentDeps, AgentState, Intent, RetrievedItem } from './types.ts';
import { normalize } from '../utils/text.ts';
import { formatBrl } from '../utils/text.ts';

const GREETING = /\b(oi|ola|bom dia|boa tarde|boa noite|e ai|eai|hey|hello)\b/;
const HUMAN = /\b(falar com|fala com|atendente|humano|pessoa real|time comercial|vendedor|suporte humano|me liga|telefone)\b/;
const ORDER = /\b(quero|queria|preciso|necessito|comprar|contratar|assinar|orcamento|cotacao|proposta|pedido|licencas?|assentos?|adicionar usuarios?)\b/;
const QUANTITY = /(\d{1,4})\s*(licencas?|assentos?|usuarios?|contas?|unidades?)?/g;
const SUPPORT = /\b(como|onde|quando|por que|porque|sla|prazo|seguranca|lgpd|conformidade|faturamento|fatura|nota fiscal|implantacao|instalar|instalacao|migrar|migracao|configurar|politica|retencao|e-discovery|disponibilidade)\b/;

export const CATALOG_INTENT = /\b(preco|precos|valor|valores|quanto custa|quanto sai|catalogo|plano|planos|licenca|licencas|skus?|estoque|disponivel|diferenca|comparar|copilot|premium|essentials|business)\b/;
const ESCALATE_TOPICS = /\b(reclamacao|procon|processo|advogado|juridico|contrato|desconto especial|proposta comercial|incidente de seguranca|vazamento|violacao|titular de dados|rescisao)\b/;
const SECRETS: RegExp[] = [
  /sk-[A-Za-z0-9]{10,}/g,
  /gho_[A-Za-z0-9]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/gi,
  /\bapi[_-]?key\s*[:=]\s*\S+/gi,
  /\bclient[_-]?secret\s*[:=]\s*\S+/gi,
];

const ALLOWED_INTENTS: Intent[] = ['saudacao', 'catalogo', 'pedido', 'suporte', 'humano', 'fora_de_escopo'];

/** Classificador determinístico: sem LLM, sem rede, testável. */
export function classifyRules(text: string): { intent: Intent; confidence: number } {
  const clean = normalize(text).trim();
  if (!clean) return { intent: 'fora_de_escopo', confidence: 0.2 };
  if (HUMAN.test(clean) || ESCALATE_TOPICS.test(clean)) return { intent: 'humano', confidence: 0.9 };
  if (ORDER.test(clean) && (QUANTITY.test(clean) || CATALOG_INTENT.test(clean) || /\b(quero|preciso|contratar|comprar|assinar)\b/.test(clean))) {
    return { intent: 'pedido', confidence: 0.8 };
  }
  if (CATALOG_INTENT.test(clean)) return { intent: 'catalogo', confidence: 0.75 };
  if (SUPPORT.test(clean)) return { intent: 'suporte', confidence: 0.7 };
  if (GREETING.test(clean) && clean.length < 60) return { intent: 'saudacao', confidence: 0.65 };
  return { intent: 'fora_de_escopo', confidence: 0.4 };
}

/** Extrai SKUs citados e quantidades ("3 licenças do Business Premium"). */
export function extractRequest(text: string, catalog: AgentDeps['catalog']): Array<{ sku: string; qtd: number }> {
  // "Microsoft 365" não é quantidade: neutraliza o número antes de procurar assentos.
  const clean = normalize(text).replace(/microsoft\s*365/g, 'm365');
  const qtyMatches = [...clean.matchAll(/(\d{1,4})\s*(?:licencas?|assentos?|usuarios?|contas?|unidades?)?/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value > 0 && value < 10_000);
  const qtd = qtyMatches.length > 0 ? qtyMatches[0] : 1;
  const explicitSkus = catalog.all().filter((item) => clean.includes(normalize(item.sku)));
  const found = explicitSkus.length > 0 ? explicitSkus : catalog.search(text, 1).map((hit) => hit.item);
  return found.map((item) => ({ sku: item.sku, qtd }));
}

export function redactSecrets(text: string): { text: string; redacted: number } {
  let redacted = 0;
  let output = text;
  for (const pattern of SECRETS) {
    output = output.replace(pattern, () => {
      redacted += 1;
      return '[REDACTED]';
    });
  }
  return { text: output, redacted };
}

function sectionExcerpt(body: string, max = 520): string {
  const single = body.replace(/\s+/g, ' ').trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}

function catalogBlock(state: AgentState): string {
  const hits = state.retrieved.filter((item) => item.fonte === 'catalogo');
  if (hits.length === 0) return '';
  return hits.map((hit) => `• **${hit.titulo}** (${hit.sku}) — ${hit.trecho}`).join('\n');
}

/** Resposta determinística em pt-BR: o agente funciona sem chave nem rede. */
export function composeTemplate(state: AgentState): string {
  const { intent, quote } = state;
  const kb = state.retrieved.find((item) => item.fonte === 'faq');
  if (intent === 'saudacao') {
    return [
      'Olá! Sou o agente de pré-vendas do time de Microsoft 365 e Teams. 👋',
      '',
      'Posso ajudar com:',
      '• preços e comparação de licenças (Teams Essentials, Business Basic/Standard/Premium, Copilot, Phone, Rooms, Webinars);',
      '• orçamento com desconto por volume (10% a partir de 20 assentos, 15% a partir de 100);',
      '• dúvidas de implantação, faturamento, SLA, segurança e LGPD.',
      '',
      'Me diga o cenário (quantos usuários e qual pacote) que eu já monto o orçamento.',
    ].join('\n');
  }
  if (intent === 'pedido' && quote) {
    const linhas = quote.linhas.map(
      (linha) => `• ${linha.nome} (${linha.sku}) — ${linha.qtd} × ${formatBrl(linha.unitario)} = ${formatBrl(linha.subtotal)}/mês`,
    );
    const resumo = [
      `Orçamento para **${quote.assentos} assento(s)**/mês:`,
      '',
      ...linhas,
      '',
      `Subtotal: ${formatBrl(quote.subtotal)}`,
      quote.descontoPct > 0 ? `Desconto por volume (${Math.round(quote.descontoPct * 100)}%): −${formatBrl(quote.descontoTotal)}` : 'Sem desconto por volume neste volume.',
      `**Total mensal: ${formatBrl(quote.total)}**`,
    ];
    const avisos = quote.avisos.length > 0 ? ['', ...quote.avisos.map((aviso) => `⚠️ ${aviso}`)] : [];
    return [...resumo, ...avisos, '', 'Confirma os SKUs e a quantidade? Eu registro o pedido e o time emite a nota fiscal em até 48h úteis.'].join('\n');
  }
  if (intent === 'catalogo') {
    const bloco = catalogBlock(state);
    return [
      'Valores oficiais do catálogo (por usuário/mês, BRL):',
      '',
      bloco || '• Nenhum SKU corresponde exatamente à busca — me diga o nome do pacote ou o SKU.',
      '',
      kb ? `Sobre isso: ${sectionExcerpt(kb.trecho)}` : 'Quer que eu monte um orçamento com desconto por volume?',
    ].join('\n');
  }
  if (intent === 'suporte') {
    return kb
      ? [`**${kb.titulo}**`, '', sectionExcerpt(kb.trecho, 700), '', 'Se precisar de algo mais específico, me diga o SKU ou o número do chamado.'].join('\n')
      : 'Não localizei essa informação na base interna. Posso escalar para o time responsável — quer que eu abra o chamado?';
  }
  if (intent === 'humano') {
    return 'Certo, vou te conectar com o time humano e levar todo o contexto deste chat junto.';
  }
  return [
    'Consigo ajudar com catálogo, licenciamento, faturamento, SLA e segurança do Microsoft Teams.',
    'Sua pergunta está fora desse escopo, então não vou arriscar uma resposta incorreta.',
    'Se for sobre contrato ou um caso específico, digo "falar com humano" e eu escalo.',
  ].join('\n');
}

/** Nós do grafo — todos puros em relação ao estado recebido. */
export function createNodes(deps: AgentDeps) {
  const hydrate = (state: AgentState): Partial<AgentState> => {
    deps.memory.ensureConversation(state.message.conversationId, {
      channel: state.message.channel,
      userId: state.message.userId,
      userName: state.message.userName,
    });
    return { history: deps.memory.recentMessages(state.message.conversationId, 8) };
  };

  const classify = async (state: AgentState): Promise<Partial<AgentState>> => {
    const rules = classifyRules(state.message.text);
    if (deps.llm.kind !== 'remote') return { intent: rules.intent, confidence: rules.confidence };
    try {
      const result = await deps.llm.completeJson<{ intent?: string; confidence?: number }>({
        messages: [
          { role: 'system', content: `Classifique a mensagem do usuário em uma única intenção: ${ALLOWED_INTENTS.join(', ')}. Responda apenas JSON {"intent":"...","confidence":0-1}.` },
          { role: 'user', content: state.message.text },
        ],
        temperature: 0,
        maxTokens: 80,
      });
      const intent = ALLOWED_INTENTS.includes(result.intent as Intent) ? (result.intent as Intent) : rules.intent;
      return { intent, confidence: Number(result.confidence ?? rules.confidence) || rules.confidence, meta: { ...state.meta, classify: 'llm' } };
    } catch {
      return { intent: rules.intent, confidence: rules.confidence, meta: { ...state.meta, classify: 'regras (fallback)' } };
    }
  };

  const retrieve = (state: AgentState): Partial<AgentState> => {
    const faqHits = deps.kb.search(state.message.text, 2).map<RetrievedItem>((hit) => ({
      id: hit.section.id,
      titulo: hit.section.titulo,
      trecho: hit.section.corpo,
      score: hit.score,
      fonte: 'faq',
    }));
    const catalogHits = deps.catalog.search(state.message.text, 4).map<RetrievedItem>((hit) => ({
      id: hit.item.sku,
      titulo: hit.item.nome,
      trecho: `${formatBrl(hit.item.precoMensal)}/mês · ${hit.item.estoque} assentos em estoque · ${hit.item.descricao}`,
      score: hit.score,
      fonte: 'catalogo',
      sku: hit.item.sku,
    }));
    const retrieved = [...catalogHits, ...faqHits].sort((left, right) => right.score - left.score).slice(0, 4);
    return { retrieved, request: extractRequest(state.message.text, deps.catalog) };
  };

  const quote = (state: AgentState): Partial<AgentState> => {
    const request = state.request.filter((entry) => deps.catalog.get(entry.sku));
    if (request.length === 0) {
      return { tool: { tool: 'nenhuma', ok: false, resumo: 'nenhum SKU identificado no pedido' } };
    }
    const result = deps.catalog.quote(request);
    return {
      quote: result,
      tool: {
        tool: 'catalogo.quote',
        ok: result.linhas.length > 0,
        resumo: `${result.linhas.length} linha(s), ${result.assentos} assentos, total ${formatBrl(result.total)}`,
        data: result,
      },
    };
  };

  const compose = async (state: AgentState): Promise<Partial<AgentState>> => {
    const template = composeTemplate(state);
    if (deps.llm.kind !== 'remote') return { reply: template, meta: { ...state.meta, compose: 'template' } };
    const contexto = [
      state.retrieved.map((item) => `[${item.fonte}] ${item.titulo}: ${sectionExcerpt(item.trecho, 400)}`).join('\n'),
      state.quote ? `Orçamento calculado (não recalcule): ${JSON.stringify(state.quote)}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    try {
      const reply = await deps.llm.complete({
        messages: [
          {
            role: 'system',
            content:
              'Você é o agente de pré-vendas de Microsoft 365/Teams em um chat corporativo. Responda em pt-BR, direto, no máximo 8 linhas. ' +
              'Use SOMENTE os fatos do contexto fornecido; nunca invente preço, SKU ou SLA. Se o contexto não cobrir a pergunta, diga isso e ofereça escalar para o time humano.',
          },
          { role: 'user', content: `Contexto:\n${contexto || '(vazio)'}\n\nPergunta: ${state.message.text}` },
        ],
      });
      return reply ? { reply, meta: { ...state.meta, compose: 'llm' } } : { reply: template, meta: { ...state.meta, compose: 'template (resposta vazia)' } };
    } catch {
      return { reply: template, meta: { ...state.meta, compose: 'template (falha do LLM)' } };
    }
  };

  const guard = (state: AgentState): Partial<AgentState> => {
    const { text: safeReply, redacted } = redactSecrets(state.reply);
    const normalized = normalize(state.message.text);
    const assentos = state.quote?.assentos ?? 0;
    const reasons: string[] = [];
    if (state.intent === 'humano') reasons.push('pedido explícito de atendimento humano');
    if (ESCALATE_TOPICS.test(normalized)) reasons.push('assunto sensível (contrato/fatura/segurança)');
    if (assentos > deps.maxAssentosSemEscalonamento) reasons.push(`pedido de ${assentos} assentos acima do limite de ${deps.maxAssentosSemEscalonamento}`);
    if (!safeReply.trim()) reasons.push('resposta vazia');
    return {
      reply: safeReply,
      handoff: { required: reasons.length > 0, reason: reasons.join('; ') || 'não aplicável' },
      meta: { ...state.meta, redacted, assentos },
    };
  };

  const escalate = (state: AgentState): Partial<AgentState> => {
    const { text: safeUserText } = redactSecrets(state.message.text);
    const ticket = deps.memory.createTicket({
      conversationId: state.message.conversationId,
      subject: `Handoff (${state.intent}): ${safeUserText.slice(0, 80)}`,
      body: `Motivo: ${state.handoff.reason}\nUsuário: ${state.message.userName} <${state.message.userId}>\nMensagem: ${safeUserText}\nRascunho do agente: ${state.reply}`,
    });
    return {
      handoff: { ...state.handoff, ticketId: ticket.id },
      reply: `${state.reply}\n\nAbri o chamado **#${ticket.id}** para o time responsável com o histórico deste chat.`,
      tool: { tool: 'ticket.create', ok: true, resumo: `chamado #${ticket.id} criado`, data: ticket },
    };
  };

  const remember = (state: AgentState): Partial<AgentState> => {
    deps.memory.appendMessage(state.message.conversationId, {
      role: 'user',
      text: state.message.text,
      meta: { channel: state.message.channel, userId: state.message.userId, userName: state.message.userName, messageId: state.message.id },
    });
    deps.memory.appendMessage(state.message.conversationId, {
      role: 'assistant',
      text: state.reply,
      meta: {
        intent: state.intent,
        confidence: state.confidence,
        handoff: state.handoff.required,
        ticketId: state.handoff.ticketId ?? null,
        trace: state.trace,
      },
    });
    return {};
  };

  return { hydrate, classify, retrieve, quote, compose, guard, escalate, remember };
}
