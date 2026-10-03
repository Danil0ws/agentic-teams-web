import { loadConfig } from '../config.ts';
import { createApp } from '../app.ts';
import { createHttpServer } from '../server/http.ts';

/** Sobe o webhook do Teams em modo dev (sem validar JWT) e imprime o curl de teste. */
const cfg = loadConfig();
cfg.bot.skipAuth = true;
if (!cfg.bot.appId) cfg.bot.appId = 'dev-bot-app-id';

const app = createApp(cfg);
const server = createHttpServer(app);
await new Promise<void>((resolve) => server.listen(cfg.port, cfg.host, resolve));

const activity = {
  type: 'message',
  id: 'dev-activity-1',
  timestamp: new Date().toISOString(),
  text: 'Olá, quanto custa o Microsoft 365 Copilot para 25 usuários?',
  from: { id: 'user-aad-1', aadObjectId: 'user-aad-1', name: 'Ana Souza' },
  conversation: { id: 'dev-conversation-1', conversationType: 'personal', tenantId: 'dev-tenant' },
  channelId: 'msteams',
  serviceUrl: 'https://smba.trafficmanager.net/teams/',
};

console.log(`[bot:dev] webhook em http://${cfg.host}:${cfg.port}/api/messages (BOT_SKIP_AUTH forçado)`);
console.log('[bot:dev] quer receber Activities reais do Teams? Exponha a porta com Dev Tunnel e registre no Azure Bot:');
console.log('  devtunnel create agentic-teams --allow-anonymous');
console.log(`  devtunnel port create agentic-teams -p ${cfg.port} --protocol http`);
console.log('  # Messaging endpoint do Azure Bot: https://<id>.devtunnels.ms/api/messages');
console.log('\n[bot:dev] teste local:');
console.log(`curl -s -X POST http://${cfg.host}:${cfg.port}/api/messages \\\n  -H 'content-type: application/json' \\\n  -d '${JSON.stringify(activity)}' | jq`);
console.log('\n[bot:dev] resposta do agente aparece no log do canal e no banco:', cfg.dbPath);

process.on('SIGINT', async () => {
  server.close();
  await app.close();
  process.exit(0);
});
