import { loadConfig } from '../config.ts';
import { createApp } from '../app.ts';
import { TeamsWebChannel } from '../adapters/teams-web/adapter.ts';

const cfg = loadConfig();
cfg.teamsWeb.enabled = true;
const app = createApp(cfg, { includeChannels: false });
const channel = new TeamsWebChannel({
  config: cfg.teamsWeb,
  botDisplayName: process.env.TEAMS_WEB_BOT_NAME ?? 'Agente M365',
  seenFile: `${cfg.teamsWeb.userDataDir}/../teams-web-seen.json`,
});

console.log(`[teams-web] abrindo ${cfg.teamsWeb.url} (headless=${cfg.teamsWeb.headless}, canal=${cfg.teamsWeb.channel})`);
console.log('[teams-web] na primeira execução use TEAMS_WEB_HEADLESS=0 e faça login manualmente: a sessão fica no perfil persistente.');
console.log(`[teams-web] chats monitorados: ${cfg.teamsWeb.chats.length ? cfg.teamsWeb.chats.join(', ') : 'todos com não lidas'}`);

await channel.start(async (message) => {
  const result = await app.dispatch(message);
  console.log(`[teams-web] ${message.userName}: ${message.text.slice(0, 80)} → intenção=${result.intent} handoff=${result.handoff}`);
});

const status = channel.status();
console.log(`[teams-web] ${status.detail}`);

const shutdown = async (signal: string): Promise<void> => {
  console.log(`\n[teams-web] ${signal}, encerrando…`);
  await channel.stop();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
