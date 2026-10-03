import { loadConfig } from '../config.ts';
import { createApp, startChannels } from '../app.ts';
import { createHttpServer } from '../server/http.ts';

const app = createApp();
const server = createHttpServer(app, { simulateEnabled: process.env.SIMULATE_DISABLED !== '1' });

await new Promise<void>((resolve) => server.listen(app.cfg.port, app.cfg.host, resolve));

console.log('─'.repeat(72));
console.log(`Agente Teams no ar em http://${app.cfg.host}:${app.cfg.port}`);
console.log(`LLM: ${app.llm.kind} (${app.llm.model}) · catálogo: ${app.catalog.all().length} SKUs · base: ${app.kb.sections.length} seções`);
console.log('Rotas:');
console.log('  POST /api/messages      webhook do Azure Bot Service (Teams oficial)');
console.log('  POST /api/simulate      testa o agente sem Teams  { "text": "..." }');
console.log('  GET  /                  painel (métricas, conversas, handoffs)');
console.log('  GET  /health            estado do processo e dos canais');
console.log('─'.repeat(72));

if (app.cfg.teamsWeb.enabled) {
  try {
    await startChannels(app);
  } catch (error) {
    console.error(`[canal] falha ao iniciar Teams Web: ${(error as Error).message}`);
  }
} else {
  const bot = app.channels.get('botframework');
  if (bot) {
    await bot.start((message) => app.dispatch(message).then(() => undefined));
    console.log(`[canal] botframework: ${bot.status().detail}`);
  }
  console.log('[canal] teams-web desabilitado (TEAMS_WEB_ENABLE=1 para ativar — leia o aviso no README)');
}

const shutdown = async (signal: string): Promise<void> => {
  console.log(`\n[app] ${signal} recebido, encerrando…`);
  server.close();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
