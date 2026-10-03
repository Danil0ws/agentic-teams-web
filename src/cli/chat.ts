import { loadConfig } from '../config.ts';
import { createApp } from '../app.ts';
import type { InboundMessage } from '../adapters/types.ts';

const text = process.argv.slice(2).join(' ').trim();
if (!text) {
  console.error('uso: npm run chat -- "sua pergunta aqui"');
  process.exit(1);
}

const conversationId = process.env.CHAT_CONVERSATION ?? 'cli-local';
const app = createApp(loadConfig(), { memoryPath: process.env.CHAT_MEMORY_PATH ?? ':memory:' });

const message: InboundMessage = {
  id: `cli-${Date.now()}`,
  channel: 'botframework',
  conversationId,
  userId: process.env.CHAT_USER ?? 'cli-user',
  userName: process.env.CHAT_USERNAME ?? 'Usuário CLI',
  text,
  timestamp: new Date().toISOString(),
  isGroup: false,
  mentionsAgent: true,
};

const result = await app.agent.handle(message);
const sent = await app.channels.get('botframework')?.send({ conversationId, text: result.reply }) ?? { ok: true };
console.log(`\n> ${text}\n`);
console.log(result.reply);
console.log(`\n[intenção=${result.intent} confiança=${result.confidence.toFixed(2)} handoff=${result.handoff}${result.ticketId ? ` chamado=#${result.ticketId}` : ''}]`);
console.log(`[trace] ${result.trace.join(' → ')}`);
console.log(`[tempo por nó] ${result.steps.map((step) => `${step.node}:${step.ms}ms`).join(' ')}`);
console.log(`[envio pelo canal] ${JSON.stringify(sent)}`);
await app.close();
