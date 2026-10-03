# REGISTRO — decisões e verificações

## Contexto

Pedido: criar um agente para **Microsoft Teams Web**, a partir de uma lista de referências open-source de agentes de WhatsApp em Python (catálogo+LLM, LangGraph, Selenium), Node/TypeScript (whatsapp-web.js + dashboard, Qdrant + grafo) e extensão de navegador (sessão do usuário, risco zero).

## Decisões

1. **TypeScript, não Python.** O alvo é Teams **Web**: a automação real depende de Playwright/DOM, exatamente o que os projetos Node da lista (`whatsapp-web.js`) fazem melhor. O cérebro (grafo, ferramentas, memória, LLM) é independente de linguagem — o que muda é o transporte, e o transporte venceu a discussão.
2. **Um núcleo, dois transports.** O Teams tem um caminho oficial (Azure Bot Service + Bot Connector) que o WhatsApp não tem. Foi implementado **e** o caminho de navegador foi mantido, porque é ele que torna o agente utilizável hoje, sem Azure. Ambos implementam o mesmo contrato `Channel`; trocar de transport não toca no cérebro.
3. **Grafo de estados próprio em vez de LangGraph.** Requisito de venda: nada de infra extra. O motor tem ~90 linhas, nós puros, arestas condicionais e trace por nó; a assinatura dos nós é compatível com LangGraph se a troca fizer sentido depois.
4. **Preço e SLA fora do LLM.** O LLM entra em classificação e redação (linguagem), nunca em regra de negócio. `quote()` calcula; o prompt recebe o orçamento pronto e instrução explícita de não recalcular.
5. **Regras antes de LLM, com LLM como camada opcional.** O modo padrão roda sem chave, sem rede e sem aleatoriedade — o que permite 47 testes determinísticos. Com LLM ativo, qualquer falha (timeout, 401, JSON inválido, resposta vazia) volta para o caminho determinístico.
6. **SQLite em vez de Postgres+pgvector.** Corpus pequeno (9 SKUs, 7 seções) e volume de pré-vendas trivial; BM25-lite resolve. `MemoryStore` é a costura para trocar por vetorial.
7. **TypeScript nativo do Node (sem build).** Rodar o fonte direto elimina divergência entre "compila" e "funciona"; a suíte executa o mesmo código que o servidor.

## Verificações executadas

| Verificação | Resultado |
| --- | --- |
| `npm test` (47 testes, `node:test`) | **47 passaram, 0 falharam** |
| `npm run chat` (modo offline) | resposta com preço do catálogo, trace `hydrate → classify → retrieve → compose → guard → remember` |
| Servidor real (`PORT=3131 node src/cli/serve.ts`) | `/health` ok; `/api/simulate` com "Quero 30 licenças do Copilot" → `intent=pedido`, `assentos=30`, `desconto=0.1`, `total=5130`, `handoff=false`; `/api/metrics` com contadores por canal; dashboard em `/` retornando HTML |
| Adapter Teams Web no Chrome real | fixture `tests/fixtures/teams-web.html`: login detectado, 2 chats listados (não lidas = 2), 2 mensagens lidas, mensagem enviada e publicada no DOM |
| Validação de JWT do Bot Framework | token válido aceito; adulterado, `alg: none`, audience errada, expirado e `serviceurl` divergente recusados |
| `send()` no Bot Connector | Activity postada com `Bearer` do token app-only contra Bot Connector falso, incluindo `replyToId` |
| Painel renderizado (Chrome real, headless) | 1440×900 (grid 4×336px), 390×844 (1 coluna 342px) e 320×800 (280px): `scrollWidth == clientWidth` nas três larguras, zero elemento ultrapassando o viewport, zero célula com texto cortado, zero erro de console e auto-refresh de 5s confirmado (texto do cabeçalho muda). Screenshots em `.telemetry/dashboard-{desktop,mobile,narrow}.png` (não versionados). |

## Pendências conhecidas (honestas)

- **Validação contra o Teams real**: exige tenant/Azure Bot com `BOT_APP_ID` e login manual no Teams Web. O caminho oficial foi validado por teste com Bot Connector falso + JWKS injetada; o caminho de navegador foi validado contra fixture do DOM, não contra `teams.microsoft.com`.
- **Seletores do Teams Web** mudam sem aviso: todos ficam em `src/adapters/teams-web/selectors.ts`, com alternativas em ordem de preferência, para ajuste em um arquivo só.
- **Memória vetorial**: não implementada de propósito (corpus pequeno). Trocar `MemoryStore` é o caminho.
- **CI**: workflows do GitHub Actions desta conta não iniciam execução (`startup_failure`), então a verificação roda localmente; sem workflow versionado para não deixar CI quebrado no repo.
- **Mídia** (áudio/anexos do Teams): `OutboundMessage.raw` está preparado, mas cards/anexos nativos e transcrição não foram implementados — não eram necessários para o caso de pré-vendas.
