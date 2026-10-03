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

// Sem canal iniciado o webhook responde 503 — em dev usamos process() para não
// tentar falar com o Bot Connector (que exige App ID/secret reais).
const channel = app.channels.get('botframework');
if (!channel) throw new Error('canal botframework não inicializado');
await channel.start(async (message) => {
  const result = await app.process(message);
  console.log(`\n[bot:dev] ${message.userName}: ${message.text}`);
  console.log(`[bot:dev] intenção=${result.intent} confiança=${result.confidence.toFixed(2)} handoff=${result.handoff}`);
  console.log(`[bot:dev] resposta:\n${result.reply}`);
});

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
