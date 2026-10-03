# Referências open-source e o que foi aproveitado

Os projetos abaixo (WhatsApp) foram a base conceitual. O mapeamento para este repositório é por **camada**, não por cópia: nenhuma linha de código foi portada — as ideias foram reimplementadas para o Teams, que tem um transporte oficial (Bot Framework) que o WhatsApp não tem.

## 1. Python — ideias para o cérebro

| Projeto | Ideia aproveitada | Onde está aqui |
| --- | --- | --- |
| `FareedKhan-dev/agentic-whatsapp-ai` | Agente de e-commerce guiado por **catálogo estruturado local** (CSV) + FAQ, com LLM apenas como camada de linguagem | `data/catalog.csv`, `data/faq.md`, `src/tools/catalog.ts`, `src/tools/kb.ts`; o preço nunca sai do LLM (`quote()` calcula, `compose` só redige) |
| `lucasboscatti/Whatsapp-Langgraph-Agent-Integration` | **Grafo de estados** com roteamento condicional, estado tipado e memória conversacional | `src/agent/graph.ts` (nós + arestas condicionais + trace), `src/agent/nodes.ts`, `src/memory/store.ts`; se quiser LangGraph depois, os nós já têm a assinatura compatível |
| `acmbpdc/Whatsapp-Smart-AI-agent` | Controle do **cliente web real** em navegador guiado por linguagem natural | `src/adapters/teams-web/` (Playwright + seletores isolados + adaptador de polling) |

O que **não** foi adotado: transcrição/áudio (Whisper/TTS) — o Teams já entrega texto e arquivos pelo próprio cliente; o adapter de navegador lê o DOM, então áudio seria uma segunda camada de mídia sem uso no caso de pré-vendas.

## 2. Node/TypeScript — ideias para operação

| Projeto | Ideia aproveitada | Onde está aqui |
| --- | --- | --- |
| `DouglasVolcato/whatsapp-automation-agent` | Ecossistema em volta do agente: **múltiplas sessões, métricas e painel** | `GET /health`, `GET /api/metrics`, `GET /api/conversations`, painel em `src/server/dashboard.html`, contadores por intenção/canal |
| `neural-maze/ava-whatsapp-agent-course` | Pipeline de **memória de longo prazo** + decisão em grafo + integração multimodal | memória SQLite com busca textual e histórico por conversa; decisão em grafo; normalização de Activity com cards/anexos preparada em `OutboundMessage.raw` |

O que **não** foi adotado: Qdrant/vetores. O corpus aqui é pequeno e determinístico (9 SKUs, 7 seções de FAQ); BM25-lite resolve e mantém o projeto rodando sem infra. `MemoryStore` é a costura para trocar por vetorial quando fizer sentido.

## 3. Extensão de navegador — o "risco zero"

| Projeto | Ideia aproveitada | Onde está aqui |
| --- | --- | --- |
| `silham/WhatsApp-Web-AI-Assistant` | Sessão **do próprio usuário**, sem credencial no código; IA sob clique humano | perfil persistente do Playwright (`TEAMS_WEB_USER_DATA_DIR`), login manual, e a decisão de responder apenas quando citado em grupo (`TEAMS_WEB_MENTION_ONLY`) |

Diferença deliberada: em vez de extensão de Chrome (que exigiria publicar/injetar no navegador do usuário), o mesmo efeito é obtido com navegador próprio + perfil persistente — sem instalar nada no Chrome do operador.

## O que este repositório acrescenta

1. **Caminho oficial Microsoft**: webhook do Azure Bot Service com validação de JWT RS256 (chaves do Bot Framework, `aud`, `serviceurl`) e envio app-only no Bot Connector — o que nenhum dos projetos de WhatsApp tem equivalente.
2. **Cérebro independente de transport**: os dois adapters compartilham o mesmo grafo, então a inteligência é testada uma vez só.
3. **Guardrails de negócio**: redação de segredos, handoff por limite/assunto sensível, escopo fechado com recusa.
4. **Determinismo testável**: modo offline que roda sem chave/API/rede, 47 testes, e QA do adapter de navegador contra fixture do DOM do Teams.
5. **Zero dependência obrigatória**: `node:sqlite`, `node:crypto`, `node:http` e TypeScript nativo do Node; Playwright é opcional e entra só no caminho de navegador.
