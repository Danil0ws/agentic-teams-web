# Arquitetura

## Por que um núcleo e dois transports

O erro clássico dos agentes de chat é amarrar a inteligência ao canal (`whatsapp-web.js`, Selenium, webhook). Aqui a regra é: **transport só normaliza e entrega**. Toda decisão — intenção, recuperação, orçamento, guardrail — vive em `src/agent/`, e o mesmo cérebro atende:

- o webhook oficial do **Azure Bot Service** (produção);
- o **Teams Web** dirigido por navegador (demo/uso pessoal).

Consequência prática: testar o agente não exige Teams, token nem navegador — `npm run chat`, `POST /api/simulate` ou `npm test` exercitam exatamente o mesmo grafo que roda em produção.

```
        ┌──────────────── adapter ────────────────┐
Teams ──► normalize ──► InboundMessage ──► dispatch ──► agente (grafo) ──► AgentResult
        └─────────────────────────────────────────┘            │
                                               OutboundMessage ─┘──► adapter.send() ──► Teams
```

`src/adapters/types.ts` define o contrato (`Channel`, `InboundMessage`, `OutboundMessage`, `SendResult`). Nenhum campo do Bot Framework (`serviceUrl`, `entities[].mention`) vaza para o cérebro: `activityToInbound()` achata isso em `isGroup`, `mentionsAgent`, `text` limpo.

## O grafo

`src/agent/graph.ts` é um motor de estados de ~90 linhas, inspirado no LangGraph: nós com assinatura `(state, run) => Partial<state> | Promise<...>`, arestas fixas e condicionais, trace por passo com tempo, teto de passos para cortar ciclo, erro registrado no passo antes de propagar. Não há dependência externa — o mesmo motor roda no teste e no servidor.

O fluxo do agente (`src/agent/index.ts`):

```
hydrate → classify → retrieve ─┬─(pedido)→ quote ─┐
                               └──────────────────┴→ compose → guard ─┬─(handoff)→ escalate ─┐
                                                                      └───────────→ remember ─┴→ END
```

| Nó | Responsabilidade | Determinístico? |
| --- | --- | --- |
| `hydrate` | registra a conversa e carrega os últimos 8 turnos do SQLite | sim |
| `classify` | intenção + confiança (regras; LLM quando configurado, com fallback) | sim no modo offline |
| `retrieve` | top-4 entre catálogo e FAQ por BM25-lite; extrai SKU/quantidade do pedido | sim |
| `quote` | monta orçamento validando SKU, estoque e faixa de desconto | sim |
| `compose` | redige a resposta (template pt-BR; LLM com contexto injetado) | sim no modo offline |
| `guard` | redige segredos, decide handoff (assunto sensível, limite de assentos, resposta vazia) | sim |
| `escalate` | abre chamado no SQLite e avisa o usuário com o número | sim |
| `remember` | grava os dois turnos com metadados (intenção, handoff, trace) | sim |

### Por que os nós são puros

Cada nó recebe o estado e devolve um patch; o motor faz o merge. Isso permite testar um nó isolado (`composeTemplate`, `guard`) sem subir o grafo inteiro, e mantém o trace auditável: `steps[]` devolve nó, próximo nó e duração.

## Ferramentas

- **Catálogo** (`src/tools/catalog.ts`): CSV próprio com parser que respeita aspas; busca ponderada por SKU > nome > categoria > descrição; `quote()` valida SKU inexistente, estoque insuficiente e aplica as faixas do FAQ (10% a partir de 20 assentos, 15% a partir de 100).
- **FAQ** (`src/tools/kb.ts`): cada `## ` do markdown vira uma seção endereçável; recuperação por pontuação normalizada (sem acento, sem stopwords), com o mesmo scorer do catálogo.
- **Chamados**: o handoff cria um registro com motivo, usuário, texto redigido e o rascunho do agente — o humano recebe contexto, não a mensagem crua.

Preço nunca é gerado por LLM: vem sempre de `quote`/`catalog`, e o prompt de composição recebe o orçamento pronto com instrução explícita de não recalcular. Regra de negócio não se negocia com o modelo.

## LLM opcional, nunca obrigatório

`src/llm/provider.ts` expõe duas implementações do mesmo contrato:

- `OpenAiCompatibleProvider` — qualquer endpoint `/chat/completions` (OpenAI, Azure OpenAI, Groq, Ollama, vLLM).
- `OfflineProvider` — devolve string vazia de propósito. O agente detecta `kind !== 'remote'` e usa regras/template.

Quando o LLM está ativo, ele só entra em `classify` (JSON com `{intent, confidence}`, validado contra a lista fechada) e `compose` (contexto recuperado + orçamento + histórico). Timeout, 401, JSON inválido ou resposta vazia caem no caminho determinístico e ficam marcados em `meta.classify` / `meta.compose`. Ou seja: o pior caso do modo LLM é o modo offline.

## Memória

SQLite nativo (`node:sqlite`), sem ORM:

- `conversations` — canal, usuário, primeira e última atividade;
- `messages` — turnos com `meta_json` (intenção, confiança, handoff, ticket, trace);
- `tickets` — chamados de handoff com status.

`stats()` conta conversas, turnos, chamados e handoffs (via `json_extract`), alimentando `/health` e o painel. WAL ligado por padrão para leitura concorrente com o servidor.

## Guardrails

1. **Redação de segredos** (`redactSecrets`): `sk-…`, `gho_…`, `Bearer …`, `api_key=…`, `client_secret=…` viram `[REDACTED]` **antes** de sair para o chat e antes de entrar no chamado.
2. **Handoff obrigatório** quando: o usuário pede humano; o assunto é sensível (contrato, Procon, segurança/vazamento, titular de dados); o pedido passa de 250 assentos; ou o rascunho sai vazio.
3. **Escopo fechado**: assunto fora de catálogo/licenciamento/faturamento/SLA/segurança é recusado em vez de improvisado.
4. **Limite de payload**: webhook rejeita corpo acima de 1 MB.

## Adapter Teams Web (Playwright)

`src/adapters/teams-web/`:

- `selectors.ts` — cada elemento tem uma lista de seletores em ordem de preferência (`data-tid` → `role/aria` → classe legada). Quando o Teams muda o DOM, ajusta-se só esse arquivo.
- `client.ts` — perfil persistente (sessão do usuário), detecção de login, listagem de chats com contador de não lidas, leitura de mensagens, envio via compositor `contenteditable` (botão Enviar ou Enter) e `snapshot()` textual para QA.
- `adapter.ts` — polling com `setTimeout` não-bloqueante, **priming** na primeira passada (histórico não gera resposta), dedupe por `chat|mensagem-id` persistido em JSON, resposta em grupo só com menção, e `conversationId` ↔ nome do chat.

O QA roda contra `tests/fixtures/teams-web.html`, uma réplica mínima do DOM do Teams com compositor funcional: o teste abre no Chrome real, lê duas mensagens, envia uma e confere que ela foi publicada — sem tocar no Teams e sem TCC/permissões.

## Adapter Bot Framework

`src/adapters/botframework/`:

- `auth.ts` — valida o Bearer token como o `botbuilder` faz: JWKS pública de `login.botframework.com` (cache 24h), assinatura RS256, `iss`, `aud` = App ID, `exp`/`nbf` com folga de 5 min e comparação do claim `serviceurl` contra a Activity (evita replay de token legítimo para outro endpoint).
- `adapter.ts` — `ingest()` autentica, guarda a referência de conversa (`serviceUrl`) e normaliza a Activity; `send()` pega token app-only (`client_credentials`, cache por expiração) e publica em `v3/conversations/{id}/activities` com `textFormat: markdown`.

Ambos os caminhos usam `crypto` e `fetch` da stdlib: nenhuma dependência obrigatória no `package.json`.

## Decisões registradas

| Decisão | Motivo |
| --- | --- |
| Grafo próprio em vez de LangGraph | Sem dependência, execução determinística, trace por nó testável; a interface é a mesma se depois quiser trocar. |
| SQLite em vez de Postgres+pgvector | O volume de um agente de pré-vendas é trivial; zero infra para rodar. Trocar por vetorial é implementar outro `MemoryStore` — o agente só usa a interface. |
| Regras determinísticas antes do LLM | Preço, SLA e handoff não podem depender de amostragem; o LLM entra onde agrega (linguagem), não onde há regra. |
| Dois adapters | O oficial é o único caminho para produção; o de navegador existe porque é o que torna o agente utilizável hoje, sem Azure. |
| Sem build de front | Painel HTML + `fetch` evita cadeia de build num projeto cujo valor está no cérebro. |
| TypeScript nativo do Node | Sem bundler/tsc: `node src/cli/serve.ts` roda o código real, o que elimina divergência entre "compilado" e "fonte". |
