import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createAgent, type Agent } from '../src/agent/index.ts';
import { createNodes, classifyRules, extractRequest, redactSecrets, composeTemplate } from '../src/agent/nodes.ts';
import { Catalog } from '../src/tools/catalog.ts';
import { KnowledgeBase } from '../src/tools/kb.ts';
import { MemoryStore } from '../src/memory/store.ts';
import { OfflineProvider } from '../src/llm/provider.ts';
import type { InboundMessage } from '../src/adapters/types.ts';

const catalog = Catalog.load(fileURLToPath(new URL('../data/catalog.csv', import.meta.url)));
const kb = KnowledgeBase.load(fileURLToPath(new URL('../data/faq.md', import.meta.url)));
const flat = (value: string): string => value.replace(/\u00a0/g, ' ');

function build(): { agent: Agent; memory: MemoryStore } {
  const memory = new MemoryStore(':memory:');
  const agent = createAgent({ catalog, kb, memory, llm: new OfflineProvider(), maxAssentosSemEscalonamento: 250 });
  return { agent, memory };
}

let counter = 0;
function message(text: string, conversationId = 'conv-1'): InboundMessage {
  counter += 1;
  return {
    id: `m-${counter}`,
    channel: 'botframework',
    conversationId,
    userId: 'u-1',
    userName: 'Ana Souza',
    text,
    timestamp: new Date().toISOString(),
    isGroup: false,
    mentionsAgent: true,
  };
}

test('classificador roteia intenções sem LLM', () => {
  assert.equal(classifyRules('Bom dia!').intent, 'saudacao');
  assert.equal(classifyRules('Quanto custa o Copilot?').intent, 'catalogo');
  assert.equal(classifyRules('Quero contratar 25 licenças do Business Premium').intent, 'pedido');
  assert.equal(classifyRules('Qual é o SLA de disponibilidade?').intent, 'suporte');
  assert.equal(classifyRules('Quero falar com um humano').intent, 'humano');
  assert.equal(classifyRules('Qual a previsão do tempo amanhã?').intent, 'fora_de_escopo');
});

test('extração de pedido ignora o número de "Microsoft 365"', () => {
  const pedido = extractRequest('Quero 25 licenças do Microsoft 365 Business Premium', catalog);
  assert.equal(pedido[0]?.qtd, 25);
  assert.equal(pedido[0]?.sku, 'TL-M365-PREM');
});

test('saudação responde com o escopo do agente e registra o turno', async () => {
  const { agent, memory } = build();
  const result = await agent.handle(message('Oi, bom dia!'));
  assert.equal(result.intent, 'saudacao');
  assert.match(result.reply, /agente de pré-vendas/i);
  assert.deepEqual(result.trace, ['hydrate', 'classify', 'retrieve', 'compose', 'guard', 'remember']);
  assert.equal(memory.recentMessages('conv-1', 5).length, 2);
  memory.close();
});

test('pergunta de catálogo cita preço oficial do CSV', async () => {
  const { agent, memory } = build();
  const result = await agent.handle(message('Quanto custa o Microsoft 365 Copilot por usuário?'));
  assert.equal(result.intent, 'catalogo');
  assert.match(flat(result.reply), /190,00/);
  assert.ok(result.retrieved.some((item) => item.sku === 'TL-COPILOT-C'));
  memory.close();
});

test('pedido gera orçamento com desconto de volume e passa pelo nó quote', async () => {
  const { agent, memory } = build();
  const result = await agent.handle(message('Quero 25 licenças do Business Premium'));
  assert.equal(result.intent, 'pedido');
  assert.equal(result.quote?.assentos, 25);
  assert.equal(result.quote?.descontoPct, 0.1);
  assert.equal(result.quote?.total, 3262.5);
  assert.match(flat(result.reply), /3\.262,50/);
  assert.ok(result.trace.includes('quote'));
  assert.equal(result.handoff, false);
  memory.close();
});

test('pedido acima de 250 assentos escala para humano e abre chamado', async () => {
  const { agent, memory } = build();
  const result = await agent.handle(message('Quero 300 licenças do Copilot'));
  assert.equal(result.handoff, true);
  assert.match(String(result.handoffReason), /acima do limite/);
  assert.ok((result.ticketId ?? 0) > 0);
  assert.match(result.reply, new RegExp(`#${result.ticketId}`));
  assert.equal(memory.stats().tickets, 1);
  assert.deepEqual(result.trace, ['hydrate', 'classify', 'retrieve', 'quote', 'compose', 'guard', 'escalate', 'remember']);
  memory.close();
});

test('pedido de humano abre chamado mesmo sem SKU', async () => {
  const { agent, memory } = build();
  const result = await agent.handle(message('Preciso falar com um humano do comercial'));
  assert.equal(result.intent, 'humano');
  assert.equal(result.handoff, true);
  assert.ok((result.ticketId ?? 0) > 0);
  memory.close();
});

test('dúvida de suporte responde a partir da base de conhecimento', async () => {
  const { agent, memory } = build();
  const result = await agent.handle(message('Como funciona o SLA de disponibilidade mensal?'));
  assert.equal(result.intent, 'suporte');
  assert.match(result.reply, /99,9 por cento|99,9/);
  memory.close();
});

test('assunto fora de escopo é recusado sem inventar resposta', async () => {
  const { agent, memory } = build();
  const result = await agent.handle(message('Faz um resumo do filme do Batman pra mim'));
  assert.equal(result.intent, 'fora_de_escopo');
  assert.match(result.reply, /fora desse escopo/);
  assert.equal(result.handoff, false);
  memory.close();
});

test('reclamação de fatura escala para humano (assunto sensível)', async () => {
  const { agent, memory } = build();
  const result = await agent.handle(message('Vou abrir reclamação no Procon sobre a fatura'));
  assert.equal(result.handoff, true);
  assert.match(String(result.handoffReason), /sensível/);
  memory.close();
});

test('segredos são redigidos antes de sair para o chat e para o chamado', async () => {
  const redacted = redactSecrets('meu token é sk-abcdefghij1234567890 e o client_secret=abc123');
  assert.equal(redacted.redacted, 2);
  assert.ok(!redacted.text.includes('sk-abcdefghij'));

  const { agent, memory } = build();
  const result = await agent.handle(message('falar com humano, minha api_key=sk-zzzzzzzzzz9999999999 vazou'));
  assert.ok(!result.reply.includes('sk-zzzzzzzzzz'));
  const ticket = memory.listTickets(1)[0];
  assert.ok(!ticket?.body.includes('sk-zzzzzzzzzz'));
  assert.ok(ticket?.body.includes('[REDACTED]'));
  memory.close();
});

test('nós são funções puras reutilizáveis (compose não muta o estado)', () => {
  const nodes = createNodes({ catalog, kb, memory: new MemoryStore(':memory:'), llm: new OfflineProvider(), maxAssentosSemEscalonamento: 250 });
  const state = {
    message: message('Quanto custa o Teams Phone Standard?'),
    history: [],
    intent: 'catalogo' as const,
    confidence: 0.7,
    retrieved: [
      { id: 'TL-PHONE-STD', titulo: 'Teams Phone Standard', trecho: 'R$ 60,00/mês', score: 3, fonte: 'catalogo' as const, sku: 'TL-PHONE-STD' },
    ],
    request: [],
    handoff: { required: false, reason: '' },
    reply: '',
    trace: [],
    meta: {},
  };
  const reply = composeTemplate(state);
  assert.match(flat(reply), /Teams Phone Standard/);
  assert.match(flat(reply), /60,00/);
  const patch = nodes.guard({ ...state, reply });
  assert.equal(patch.handoff?.required, false, patch.handoff?.reason);
  assert.equal(state.reply, '', 'template não deve mutar o estado');
  assert.equal(patch.reply, reply);
});
