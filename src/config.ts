import { resolve } from 'node:path';

export type LlmKind = 'offline' | 'openai';
export type BrowserChannel = 'chrome' | 'msedge' | 'chromium';

export interface LlmConfig {
  kind: LlmKind;
  model: string;
  baseUrl: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

export interface TeamsWebConfig {
  enabled: boolean;
  url: string;
  userDataDir: string;
  headless: boolean;
  channel: BrowserChannel;
  pollMs: number;
  chats: string[];
  mentionOnly: boolean;
}

export interface BotConfig {
  appId: string;
  appSecret: string;
  tenantId: string;
  skipAuth: boolean;
  /** serviceUrl do Bot Framework (inkscape do Azure Bot). */
  serviceUrl: string;
  /** Base do AAD usado para o token app-only (sobrescrevível em teste). */
  loginBaseUrl: string;
}

export interface AppConfig {
  port: number;
  host: string;
  dbPath: string;
  catalogPath: string;
  faqPath: string;
  llm: LlmConfig;
  bot: BotConfig;
  teamsWeb: TeamsWebConfig;
}

function env(key: string, fallback = ''): string {
  const raw = process.env[key];
  return raw === undefined || raw === '' ? fallback : raw;
}

function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on', 'sim'].includes(raw.trim().toLowerCase());
}

function list(key: string): string[] {
  return env(key)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Configuração única do processo, lida do ambiente (.env). */
export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const kind = (env('LLM_PROVIDER', 'offline').toLowerCase() === 'openai' ? 'openai' : 'offline') as LlmKind;
  const config: AppConfig = {
    port: num('PORT', 3110),
    host: env('HOST', '127.0.0.1'),
    dbPath: resolve(env('DB_PATH', 'data/agent.sqlite')),
    catalogPath: resolve(env('CATALOG_PATH', 'data/catalog.csv')),
    faqPath: resolve(env('FAQ_PATH', 'data/faq.md')),
    llm: {
      kind,
      model: env('LLM_MODEL', kind === 'offline' ? 'offline-template' : 'gpt-4o-mini'),
      baseUrl: env('LLM_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''),
      apiKey: env('LLM_API_KEY'),
      temperature: num('LLM_TEMPERATURE', 0.2),
      maxTokens: num('LLM_MAX_TOKENS', 600),
      timeoutMs: num('LLM_TIMEOUT_MS', 30_000),
    },
    bot: {
      appId: env('BOT_APP_ID'),
      appSecret: env('BOT_APP_SECRET'),
      tenantId: env('BOT_TENANT_ID', 'botframework.com'),
      skipAuth: bool('BOT_SKIP_AUTH', false),
      serviceUrl: env('BOT_SERVICE_URL', 'https://smba.trafficmanager.net/teams/'),
      loginBaseUrl: env('BOT_LOGIN_BASE_URL', 'https://login.microsoftonline.com'),
    },
    teamsWeb: {
      enabled: bool('TEAMS_WEB_ENABLE', false),
      url: env('TEAMS_WEB_URL', 'https://teams.microsoft.com/v2/'),
      userDataDir: resolve(env('TEAMS_WEB_USER_DATA_DIR', '.telemetry/teams-profile')),
      headless: bool('TEAMS_WEB_HEADLESS', true),
      channel: env('TEAMS_WEB_CHANNEL', 'chrome').toLowerCase() as BrowserChannel,
      pollMs: num('TEAMS_WEB_POLL_MS', 15_000),
      chats: list('TEAMS_WEB_CHATS'),
      mentionOnly: bool('TEAMS_WEB_MENTION_ONLY', true),
    },
  };
  return { ...config, ...overrides, llm: { ...config.llm, ...(overrides.llm ?? {}) }, bot: { ...config.bot, ...(overrides.bot ?? {}) }, teamsWeb: { ...config.teamsWeb, ...(overrides.teamsWeb ?? {}) } };
}
