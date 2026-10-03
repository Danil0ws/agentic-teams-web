# Changelog

Todas as mudanças relevantes deste projeto. Formato inspirado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); versionamento semântico.

## [0.1.0] — 2026-10-02

Primeira versão funcional: agente para Microsoft Teams com um núcleo de agente e dois transports.

### Adicionado

- **Núcleo de agente agnóstico de canal** (`src/agent/`):
  - motor de grafo de estados próprio (`graph.ts`) com nós puros, arestas condicionais, trace por passo com duração, teto de passos contra ciclo e erro registrado no passo;
  - fluxo `hydrate → classify → retrieve → (quote) → compose → guard → (escalate) → remember`;
  - classificador determinístico de intenções (saudação, catálogo, pedido, suporte, humano, fora de escopo) com extração de SKU e quantidade;
  - redação de segredos (`sk-…`, `gho_…`, `Bearer …`, `api_key=…`, `client_secret=…`) antes de qualquer saída;
  - handoff automático por assunto sensível (contrato, Procon, segurança/vazamento, titular de dados), pedido acima de 250 assentos, pedido explícito de humano e rascunho vazio.
- **Ferramentas**: `catalog.ts` (CSV próprio com parser que respeita aspas, busca ponderada, orçamento com validação de SKU/estoque e faixas de desconto 10%/15%), `kb.ts` (FAQ markdown em seções endereçáveis com BM25-lite).
- **Memória SQLite nativa** (`node:sqlite`, sem dependência): conversas, turnos com metadados e chamados; busca textual; `stats()` com contagem de handoffs; WAL habilitado.
- **LLM opcional**: `OpenAiCompatibleProvider` (OpenAI, Azure OpenAI, Groq, Ollama, vLLM) e `OfflineProvider` determinístico; qualquer falha do modelo cai para regras/template e fica marcada em `meta.classify`/`meta.compose`.
- **Adapter Bot Framework (caminho oficial)**: webhook `POST /api/messages`; validação de Bearer token com JWKS pública do Bot Framework (cache 24h), RS256, `iss`, `aud` = App ID, `exp`/`nbf` com folga de 5 min e claim `serviceurl` comparado com a Activity; envio app-only (`client_credentials`, cache por expiração) em `serviceUrl/v3/conversations/{id}/activities` com `textFormat: markdown`; normalização de Activity (limpeza de `<at>`, detecção de grupo e menção) e erro explícito de 401 no lugar de silêncio.
- **Adapter Teams Web (Playwright)**: perfil persistente (login manual, nenhuma credencial no código), detecção de login, listagem de chats com não lidas, leitura de mensagens, envio pelo compositor `contenteditable` (botão ou Enter), snapshot textual; polling não bloqueante, *priming* na primeira varredura, dedupe por `chat|id` persistido e resposta em grupo só com menção.
- **Servidor HTTP** (`node:http`): `/health`, `/api/metrics`, `/api/conversations`, `/api/tickets`, `/api/messages` (Teams), `/api/simulate` (teste local) e painel HTML em `/` sem build de front; limite de payload de 1 MB.
- **CLIs**: `serve` (servidor + canais), `chat` (conversa única no terminal), `teams-web` (navegador), `bot:dev` (webhook em modo dev com o curl pronto e instruções de Dev Tunnel).
- **Testes**: 47 testes com `node:test` e zero rede — grafo (ordem, condicional, ciclo, erro), agente (intenções, orçamento, handoff, redação, pureza dos nós), ferramentas, memória (inclusive persistência em arquivo), HTTP (inclusive 401 sem token), Bot Framework (token válido/adulterado/`alg: none`/audience errada/expirado/`serviceurl` divergente e `send()` contra Bot Connector falso) e adapter Teams Web (cliente falso + leitura e envio no DOM do Teams contra fixture, em Chrome real).
- **Fixture de QA** `tests/fixtures/teams-web.html`: réplica mínima do DOM do Teams com compositor funcional, permitindo validar o adapter de navegador sem tocar no Teams real.
- **Dados de exemplo**: 9 SKUs de licenças Microsoft 365/Teams (preços fictícios) e FAQ com 7 seções.
- **Documentação**: `README.md`, `docs/ARQUITETURA.md` (decisões e trade-offs), `docs/REFERENCIAS.md` (de-para com os projetos open-source de referência), `docs/TEAMS_OFICIAL.md` (registro no Azure Bot, manifest do Teams e checklist de produção) e `REGISTRO.md`.

### Corrigido

- **`npm run bot:dev`**: o canal não era iniciado, então o `curl` que o próprio CLI imprime respondia **503 (canal parado)**. Agora o webhook sobe com o canal ativo e a resposta do agente aparece no log.
- **Validação de JWT**: token cujo `kid` não existe na JWKS passa a ser recusado com motivo explícito (`kid não encontrado na JWKS`) em vez de tentar a primeira chave — cair para outra emissão mascararia o motivo real.
- **`npm run chat`**: não tenta mais enviar pelo canal quando não há credenciais do Bot Framework — antes imprimia `[envio pelo canal] {"ok":false,...}`, que parecia erro no primeiro contato com o projeto. Agora diz `ignorado (sem BOT_APP_ID/BOT_APP_SECRET — CLI local)`.
- **Painel (`GET /`)**: favicon embutido (`data:`) elimina o 404 no console; preview das conversas remove `**` do markdown (antes aparecia literal no lugar do texto); `overflow-wrap: anywhere` nas células evita estouro horizontal com strings longas sem espaço. Verificado renderizado em 1440×900, 390×844 e 320×800 — sem overflow horizontal, nenhuma célula truncada, console limpo.

### Documentação e projeto open source

- **`LICENSE`** (MIT) e repositório público — antes era privado.
- **`CONTRIBUTING.md`**: onde cada tipo de mudança encaixa (domínio em `data/`, nó em `src/agent/`, canal em `src/adapters/`, ferramenta em `src/tools/`), as regras de ouro (determinismo no caminho padrão, zero dependência obrigatória nova, sintaxe compatível com type stripping, teste junto, segredo redigido) e o fluxo de commit/PR.
- **`SECURITY.md`**: relato privado por GitHub Advisory, tabela de superfície (webhook, guardrails, injeção de prompt, SQL, configuração), o que está fora de escopo (adapter `teams-web` e ToS) e checklist de implantação.
- **`CODE_OF_CONDUCT.md`**: Contributor Covenant v2.1.
- **README**: badges (licença, Node, testes, zero dependência obrigatória), seção **Em 60 segundos** com o caminho clone → `npm test` → `npm run chat`, seção de licença/contribuição e árvore de arquivos atualizada.
- **`package.json`**: `license`, `author`, `keywords`, `repository`, `homepage` e `bugs` (segue `private: true` por ser aplicativo, não biblioteca publicada).

### Notas

- Zero dependência obrigatória: `node:sqlite`, `node:crypto`, `node:http` e TypeScript nativo do Node ≥ 22.6. Playwright é opcional (`optionalDependencies`) e usado apenas pelo adapter de navegador.
- O adapter `teams-web` automatiza a interface do Teams Web e contraria os termos de uso da Microsoft para uso não assistido/em massa: uso pessoal, demo ou laboratório. Produção é pelo `botframework`.
