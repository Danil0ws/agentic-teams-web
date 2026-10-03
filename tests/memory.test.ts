import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/memory/store.ts';

test('memória guarda turnos e devolve os mais recentes em ordem', () => {
  const memory = new MemoryStore(':memory:');
  memory.ensureConversation('c1', { channel: 'botframework', userId: 'u1', userName: 'Ana' });
  for (let index = 1; index <= 5; index += 1) {
    memory.appendMessage('c1', { role: index % 2 === 0 ? 'assistant' : 'user', text: `mensagem ${index}` });
  }
  const recent = memory.recentMessages('c1', 3);
  assert.deepEqual(recent.map((message) => message.text), ['mensagem 3', 'mensagem 4', 'mensagem 5']);
  assert.equal(recent.at(-1)?.role, 'user');
  memory.close();
});

test('busca textual encontra turnos antigos pelo conteúdo', () => {
  const memory = new MemoryStore(':memory:');
  memory.ensureConversation('c1', { channel: 'teams-web', userId: 'u1', userName: 'Ana' });
  memory.appendMessage('c1', { role: 'user', text: 'Quero 25 licenças do Business Premium' });
  memory.appendMessage('c1', { role: 'assistant', text: 'Orçamento enviado' });
  const hits = memory.search('licenças', 5);
  assert.equal(hits.length, 1);
  assert.match(hits[0]!.text, /Business Premium/);
  memory.close();
});

test('chamados de handoff são persistidos e contabilizados', () => {
  const memory = new MemoryStore(':memory:');
  memory.ensureConversation('c1', { channel: 'botframework', userId: 'u1', userName: 'Ana' });
  const ticket = memory.createTicket({ conversationId: 'c1', subject: 'Handoff', body: 'pedido grande' });
  assert.ok(ticket.id > 0);
  memory.appendMessage('c1', { role: 'assistant', text: 'chamado aberto', meta: { handoff: true, ticketId: ticket.id } });
  const stats = memory.stats();
  assert.equal(stats.tickets, 1);
  assert.equal(stats.handoffs, 1);
  assert.equal(memory.listTickets(5)[0]?.status, 'ABERTO');
  memory.close();
});

test('recentConversations traz a última mensagem de cada conversa', () => {
  const memory = new MemoryStore(':memory:');
  memory.ensureConversation('c1', { channel: 'botframework', userId: 'u1', userName: 'Ana' });
  memory.ensureConversation('c2', { channel: 'teams-web', userId: 'u2', userName: 'Bruno' });
  memory.appendMessage('c1', { role: 'user', text: 'primeira de c1' });
  memory.appendMessage('c2', { role: 'user', text: 'última de c2' });
  memory.appendMessage('c1', { role: 'user', text: 'última de c1' });
  const rows = memory.recentConversations(10);
  assert.equal(rows.length, 2);
  const c1 = rows.find((row) => row.id === 'c1');
  assert.equal(c1?.text, 'última de c1');
  assert.equal(c1?.user_name, 'Ana');
  memory.close();
});

test('persistência em arquivo sobrevive ao fechamento', () => {
  const path = new URL('../.telemetry/test-memory.sqlite', import.meta.url).pathname;
  const first = new MemoryStore(path);
  first.ensureConversation('persist', { channel: 'botframework', userId: 'u1', userName: 'Ana' });
  first.appendMessage('persist', { role: 'user', text: 'guardar isso' });
  first.close();
  const second = new MemoryStore(path);
  assert.equal(second.recentMessages('persist', 5)[0]?.text, 'guardar isso');
  second.close();
});
