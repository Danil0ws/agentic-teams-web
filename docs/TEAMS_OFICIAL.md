# Publicar o agente no Teams pelo caminho oficial

Resumo do que já está implementado neste repositório:

- `POST /api/messages` — endpoint que o Azure Bot Service chama.
- `src/adapters/botframework/auth.ts` — validação do Bearer token (RS256 via JWKS do Bot Framework, `iss`, `aud` = App ID, `exp`/`nbf`, claim `serviceurl`).
- `src/adapters/botframework/adapter.ts` — token app-only (`client_credentials`) e envio em `serviceUrl/v3/conversations/{id}/activities`.
- `activityToInbound()` — Activity do Teams → mensagem interna (com limpeza de `<at>`, detecção de grupo e de menção).

O que falta é o registro no Azure/Teams, que é **externo ao código**.

## 1. Azure Bot

No Azure Portal: *Create a resource* → **Azure Bot**.

- **Bot handle**: `agentic-teams-bot` (o que quiser).
- **Type of App**: *Single Tenant* (ou *Multi Tenant*; use `BOT_TENANT_ID` correspondente).
- **Creation type**: *Create new Microsoft App ID*.
- Depois de criar: *Configuration* → copie **Microsoft App ID**; em *Manage Password* crie um **client secret**.

```bash
# .env
BOT_APP_ID=<app id>
BOT_APP_SECRET=<client secret>
BOT_TENANT_ID=<tenant id>       # botframework.com para multi-tenant
BOT_SKIP_AUTH=0                 # produção: validação ligada
```

## 2. Endpoint público

O bot precisa de HTTPS alcançável. Em desenvolvimento, Dev Tunnel:

```bash
devtunnel create agentic-teams --allow-anonymous
devtunnel port create agentic-teams -p 3110 --protocol http
devtunnel host agentic-teams     # copie a URL https://<id>.devtunnels.ms
```

No Azure Bot → *Configuration* → **Messaging endpoint**: `https://<id>.devtunnels.ms/api/messages`.

Em produção, suba atrás de um proxy com TLS (Caddy/nginx/Cloud Run/Container Apps) e aponte o mesmo caminho.

## 3. Canal do Teams

Azure Bot → *Channels* → **Microsoft Teams** → habilitar. Para testar sem publicar na loja, use **sideload** em *Teams → Apps → Manage your apps → Upload an app*.

## 4. Manifest (sideload)

`manifest.json` (troque `<seu-app-id>` e as URLs pelo host real):

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/teams/v1.17/MicrosoftTeams.schema.json",
  "manifestVersion": "1.17",
  "version": "1.0.0",
  "id": "<seu-app-id>",
  "packageName": "com.exemplo.agentic.teams",
  "name": { "short": "Agente M365", "full": "Agente de pré-vendas Microsoft 365/Teams" },
  "developer": {
    "name": "Seu time",
    "websiteUrl": "https://exemplo.com",
    "privacyUrl": "https://exemplo.com/privacidade",
    "termsOfUseUrl": "https://exemplo.com/termos"
  },
  "description": {
    "short": "Pré-vendas de licenças Microsoft 365 e Teams.",
    "full": "Responde sobre catálogo, licenciamento, orçamento com desconto por volume, SLA, faturamento e segurança; escala para humano quando necessário."
  },
  "icons": { "color": "color.png", "outline": "outline.png" },
  "accentColor": "#5B8DEF",
  "bots": [
    {
      "botId": "<seu-app-id>",
      "scopes": ["personal", "team", "groupchat"],
      "supportsFiles": false,
      "isNotificationOnly": false
    }
  ],
  "permissions": ["identity", "messageTeamMembers"],
  "validDomains": []
}
```

Empacote `manifest.json` + `color.png` (192×192) + `outline.png` (32×32) em um ZIP e faça o sideload. Em grupo/canal, o agente é acionado por **@menção** (o Teams só entrega a Activity dessa forma) — `mentionsAgent` fica `true` e o texto chega limpo.

## 5. Verificação

```bash
npm start                     # sobe o servidor com BOT_SKIP_AUTH=0
curl -s http://127.0.0.1:3110/health | jq '.channels'
```

1. Sem token → `POST /api/messages` devolve **401** (`não autorizado`). Confirme antes de expor o endpoint.
2. No Teams, mande `Olá` para o bot → a Activity chega, o JWT é validado, a resposta volta pelo Bot Connector.
3. `curl -s http://127.0.0.1:3110/api/tickets | jq` mostra handoffs abertos ("falar com humano", pedido > 250 assentos, assunto sensível).

## 6. Produção — checklist

- [ ] `BOT_SKIP_AUTH=0` e `BOT_APP_ID`/`BOT_APP_SECRET`/`BOT_TENANT_ID` vindos de um cofre (Key Vault, SSM), nunca do repositório.
- [ ] `HOST=0.0.0.0` atrás de proxy com TLS; `PORT` do provedor.
- [ ] Banco fora do container: `DB_PATH=/dados/agent.sqlite` (volume persistente) ou trocar `MemoryStore` por Postgres.
- [ ] `SIMULATE_DISABLED=1` para não expor `POST /api/simulate`.
- [ ] `LLM_PROVIDER=openai` com `LLM_API_KEY` no cofre (ou Ollama em rede interna).
- [ ] Rotação do client secret antes do vencimento (o token app-only é cacheado por expiração, então a rotação é transparente).
- [ ] Observabilidade: `/health` e `/api/metrics` no seu monitor; `counters.errors` é o sinal de falha do agente.
- [ ] LGPD: prazo de retenção em `messages`/`tickets`, base legal documentada e rota para requisição de titular.
