# agentic-teams-web

[![Licença: MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.6-brightgreen)](https://nodejs.org)
[![Testes](https://img.shields.io/badge/testes-47%20passando-success)](#testes)
[![Dependências obrigatórias](https://img.shields.io/badge/depend%C3%AAncias%20obrigat%C3%B3rias-0-success)](#arquitetura-em-10-linhas)

Agente autônomo para **Microsoft Teams** com um único núcleo de inteligência servindo **dois transports**:

| Transport | O que é | Quando usar |
| --- | --- | --- |
| `botframework` | Webhook do **Azure Bot Service** (`POST /api/messages`) + envio autenticado no Bot Connector. Valida JWT RS256 do Bot Framework, responde em `serviceUrl/v3/conversations/{id}/activities`. | **Produção.** É o caminho oficial e suportado pela Microsoft para agentes no Teams. |
| `teams-web` | Dirige o **Teams Web real** em um navegador (Playwright), como o `whatsapp-web.js` faz com o WhatsApp Web. | Uso pessoal, demo e laboratório — **não** para produção (ver *Aviso legal*). |

O agente responde sobre catálogo/licenciamento, orçamento com desconto por volume, SLA, faturamento, segurança/LGPD e escala para humano quando o caso pede. Roda **sem chave de API e sem rede** (modo `offline` determinístico) — o mesmo código serve para teste e para produção.

## Em 60 segundos

```bash
git clone https://github.com/Danil0ws/agentic-teams-web && cd agentic-teams-web
npm test                                              # 47 testes, sem chave e sem rede
npm run chat -- "Quero 25 licenças do Business Premium"
```

Funciona sem configurar nada: o modo padrão (`LLM_PROVIDER=offline`) responde com regras determinísticas e preços do catálogo. Para LLM, Teams Web ou Teams oficial, veja [Rodando](#rodando).

## Sumário

- [Arquitetura em 10 linhas](#arquitetura-em-10-linhas)
- [Começando](#começando)
- [Rodando](#rodando)
- [Ligando no Teams de verdade](#ligando-no-teams-de-verdade)
- [HTTP](#http)
- [Testes](#testes)
- [Estrutura](#estrutura)
- [Aviso legal](#aviso-legal)

## Arquitetura em 10 linhas

```
Teams Web (Playwright) ─┐
                        ├─► InboundMessage ─► GRAFO ─► AgentResult ─► OutboundMessage ─► adapter de volta ao Teams
Azure Bot Service ──────┘                       │
                                                └─ nós: hydrate → classify → retrieve → (quote) → compose → guard → (escalate) → remember
```

- **Grafo de estados próprio** (`src/agent/graph.ts`): nós puros, arestas condicionais, trace por passo, proteção contra ciclo. Sem dependência de LangGraph — roda igual no teste e em produção.
- **Ferramentas**: catálogo CSV com orçamento e faixas de desconto, FAQ markdown com recuperação por pontuação BM25-lite, criação de chamado no handoff.
- **Memória**: SQLite nativo (`node:sqlite`) com conversas, turnos e chamados. Zero dependência obrigatória no projeto.
- **LLM opcional**: qualquer endpoint compatível com `/chat/completions` (OpenAI, Azure OpenAI, Groq, Ollama local). Se faltar chave, rede ou o modelo devolver lixo, o agente cai no classificador por regras e no compositor por template — a resposta continua correta e grounded no catálogo.
- **Guardrails**: redação de segredos antes de qualquer saída, handoff automático para pedidos acima de 250 assentos, assuntos sensíveis e pedido explícito de humano.

Detalhes em [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md) e o de-para com os projetos open-source de referência em [`docs/REFERENCIAS.md`](docs/REFERENCIAS.md).

## Começando

Requisitos: **Node ≥ 22.6** (TypeScript nativo, sem build). Playwright é opcional e só para o adapter `teams-web`.

```bash
cp .env.example .env      # opcional: o default já roda (LLM_PROVIDER=offline)
node --version            # >= 22.6
npm test                  # 47 testes
```

## Rodando

### 1. Conversa única no terminal (sem Teams)

```bash
npm run chat -- "Quanto custa o Microsoft 365 Copilot?"
npm run chat -- "Quero 25 licenças do Business Premium"
npm run chat -- "Quero 300 licenças do Copilot"     # escala e abre chamado
```

Saída: resposta + intenção + confiança + trace do grafo + tempo por nó.

### 2. Servidor (webhook + painel + simulador)

```bash
npm start                # http://127.0.0.1:3110
```

```bash
# testa o agente sem Teams nenhum
curl -s -X POST http://127.0.0.1:3110/api/simulate \
  -H 'content-type: application/json' \
  -d '{"text":"Quero 30 licenças do Copilot","userName":"Ana"}' | jq
```

Abra http://127.0.0.1:3110 no navegador: métricas, canais, conversas recentes e chamados de handoff.

### 3. Com LLM de verdade

```bash
# OpenAI
LLM_PROVIDER=openai LLM_API_KEY=... LLM_MODEL=gpt-4o-mini npm start

# Ollama local (mesma interface /v1)
LLM_PROVIDER=openai LLM_BASE_URL=http://127.0.0.1:11434/v1 LLM_API_KEY=ollama LLM_MODEL=qwen2.5:7b-instruct npm start
```

Com LLM ativo, os nós `classify` e `compose` passam a usar o modelo; qualquer falha volta automaticamente para regras/template (veja `meta.classify` e `meta.compose` na resposta).

### 4. Teams Web (Playwright)

```bash
TEAMS_WEB_ENABLE=1 TEAMS_WEB_HEADLESS=0 npm run teams-web   # primeira vez: faça login na janela
TEAMS_WEB_ENABLE=1 npm run teams-web                        # depois: sessão persistida, roda headless
```

A sessão vive em `TEAMS_WEB_USER_DATA_DIR` (perfil persistente) — **nenhuma credencial passa pelo código**. A primeira varredura é só *priming* (o histórico não gera resposta); depois disso, o agente responde apenas mensagens novas, deduplicadas por id. Em grupo, responde só quando citado (`@Agente M365`), controlado por `TEAMS_WEB_MENTION_ONLY`.

### 5. Modo dev do webhook oficial

```bash
npm run bot:dev          # força BOT_SKIP_AUTH=1 e imprime o curl de teste
```

Para receber Activities reais no seu Mac, exponha a porta com Dev Tunnel e registre a URL no Azure Bot:

```bash
devtunnel create agentic-teams --allow-anonymous
devtunnel port create agentic-teams -p 3110 --protocol http
# Messaging endpoint do Azure Bot: https://<id>.devtunnels.ms/api/messages
```

## Ligando no Teams de verdade

1. **Azure Bot** (Azure Portal → *Create a resource* → *Azure Bot*): tipo *Single Tenant*, copie **App ID** e gere um **client secret** → `BOT_APP_ID`, `BOT_APP_SECRET`, `BOT_TENANT_ID`.
2. **Canal Teams** no recurso do bot (*Channels* → Microsoft Teams).
3. **Messaging endpoint**: `https://<seu-túnel-ou-host>/api/messages`.
4. Desligue `BOT_SKIP_AUTH` e suba o servidor. A validação de JWT (assinatura RS256 pela JWKS do Bot Framework, `iss`, `aud`, `exp/nbf` e o claim `serviceurl`) está em `src/adapters/botframework/auth.ts` — requisição sem token legítimo recebe **401**.
5. **Publicar no Teams** (sideload para testar): use o Manifest do Teams apontando para o mesmo `appId` (`docs/TEAMS_OFICIAL.md` traz o JSON e o passo a passo com App Studio / Teams Toolkit).

## HTTP

| Rota | Descrição |
| --- | --- |
| `POST /api/messages` | Webhook do Azure Bot Service (Teams oficial). Valida JWT e normaliza a Activity. |
| `POST /api/simulate` | Injeta uma mensagem local e devolve `AgentResult` completo (trace, orçamento, handoff). |
| `GET /health` | Estado do processo, LLM ativo, status dos canais e estatísticas do banco. |
| `GET /api/metrics` | Contadores por intenção, canal, handoffs e erros. |
| `GET /api/conversations` | Últimas conversas com a última mensagem (alimenta o painel). |
| `GET /api/tickets` | Chamados abertos por handoff. |
| `GET /` | Painel HTML (sem build, sem dependência de front). |

## Testes

```bash
npm test
```

47 testes com `node:test`, sem rede e sem chave:

- `tests/graph.test.ts` — motor do grafo: ordem, arestas condicionais, ciclo, erro.
- `tests/agent.test.ts` — intenções, orçamento com desconto, handoff por limite, redação de segredos, pureza dos nós.
- `tests/tools.test.ts` — catálogo, faixas de desconto, FAQ.
- `tests/memory.test.ts` — turnos, busca, chamados, persistência em arquivo.
- `tests/http.test.ts` — `/health`, `/api/simulate`, webhook com e sem token, 404, dashboard.
- `tests/botframework.test.ts` — JWT RS256 (token válido, adulterado, `alg: none`, audience errada, expirado, `serviceurl` divergente) e `send()` contra um Bot Connector falso.
- `tests/teams-web.test.ts` — lógica do adapter (priming, dedupe, menção) com cliente falso + leitura/envio no DOM do Teams contra a fixture `tests/fixtures/teams-web.html` no Chrome real (o teste é pulado se Playwright/Chrome não existirem).

Para instalar o navegador do segundo bloco: `npm i -D playwright && npx playwright install chromium` (ou use o Google Chrome já instalado — é o default via `TEAMS_WEB_CHANNEL=chrome`).

## Estrutura

```
src/
  agent/        graph.ts · nodes.ts · index.ts · types.ts   ← o cérebro, agnóstico de transport
  adapters/
    botframework/  auth.ts (JWT RS256) · adapter.ts (webhook + Bot Connector)
    teams-web/     selectors.ts · client.ts (Playwright) · adapter.ts (polling, dedupe, priming)
    types.ts       Channel/InboundMessage/OutboundMessage — o contrato dos dois transports
  tools/        catalog.ts (CSV + orçamento) · kb.ts (FAQ)
  memory/       store.ts (SQLite: conversas, turnos, chamados, métricas)
  llm/          provider.ts (OpenAI-compatível + offline determinístico)
  server/       http.ts (rotas) · dashboard.html
  cli/          serve.ts · chat.ts · teams-web.ts · bot-dev.ts
data/           catalog.csv · faq.md        ← troque pelos seus dados; nada mais precisa mudar
tests/          47 testes + fixtures/teams-web.html
docs/           ARQUITETURA.md · REFERENCIAS.md · TEAMS_OFICIAL.md
LICENSE · CONTRIBUTING.md · SECURITY.md · CODE_OF_CONDUCT.md
```

Trocar o domínio do negócio = editar `data/catalog.csv` e `data/faq.md`. Nós, guardrails e transports ficam iguais.

## Aviso legal

- O adapter **`teams-web` automatiza a interface do Teams Web**. Isso contraria os termos de uso da Microsoft para uso não assistido/em massa e pode violar políticas do seu tenant — use para uso pessoal, demo ou laboratório. Para qualquer uso corporativo/produção, use o adapter **`botframework`** (API oficial).
- O agente persiste o texto das mensagens e metadados do remetente em SQLite local. Em produção, trate isso como dado pessoal: defina base legal, prazo de retenção e o caminho de requisição de titular (LGPD). Segredos são redigidos antes de qualquer resposta ou chamado, mas o texto de entrada é gravado como recebido.
- Preços no `data/catalog.csv` são fictícios, para demonstração.

## Publicação

Os workflows do GitHub Actions desta conta não iniciam execução (`startup_failure` até em workflow mínimo), então a verificação roda localmente (`npm test`) e o push é feito direto pelo `gh`. Se o Actions voltar a funcionar, o passo de CI é simplesmente `npm test`.

## Licença e contribuição

[MIT](LICENSE) — use, modifique e redistribua, inclusive comercialmente, mantendo o aviso de copyright.

- **Como contribuir**: [`CONTRIBUTING.md`](CONTRIBUTING.md) — onde cada tipo de mudança encaixa (domínio, nó, canal, ferramenta) e as regras de ouro.
- **Segurança**: [`SECURITY.md`](SECURITY.md) — relato privado de vulnerabilidade, escopo e checklist de implantação.
- **Convivência**: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — Contributor Covenant v2.1.
- **Decisões e histórico**: [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md), [`CHANGELOG.md`](CHANGELOG.md), [`REGISTRO.md`](REGISTRO.md).

É um aplicativo, não uma biblioteca publicada: o `package.json` mantém `"private": true` para impedir publicação acidental no npm. Reaproveite clonando o repositório.
