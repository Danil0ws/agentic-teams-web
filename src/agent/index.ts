import { StateGraph, END } from './graph.ts';
import { createNodes } from './nodes.ts';
import type { AgentDeps, AgentResult, AgentState } from './types.ts';
import type { InboundMessage } from '../adapters/types.ts';

export interface Agent {
  readonly graph: StateGraph<AgentState>;
  handle(message: InboundMessage): Promise<AgentResult>;
}

export function createInitialState(message: InboundMessage): AgentState {
  return {
    message,
    history: [],
    intent: 'fora_de_escopo',
    confidence: 0,
    retrieved: [],
    request: [],
    handoff: { required: false, reason: '' },
    reply: '',
    trace: [],
    meta: { channel: message.channel },
  };
}

/**
 * Liga os nós em grafo:
 * hydrate → classify → retrieve → (quote?) → compose → guard → (escalate?) → remember
 */
export function createAgent(deps: AgentDeps): Agent {
  const nodes = createNodes(deps);
  const graph = new StateGraph<AgentState>('agentic-teams')
    .addNode('hydrate', nodes.hydrate)
    .addNode('classify', nodes.classify)
    .addNode('retrieve', nodes.retrieve)
    .addNode('quote', nodes.quote)
    .addNode('compose', nodes.compose)
    .addNode('guard', nodes.guard)
    .addNode('escalate', nodes.escalate)
    .addNode('remember', nodes.remember)
    .setEntry('hydrate')
    .addEdge('hydrate', 'classify')
    .addEdge('classify', 'retrieve')
    .addConditionalEdge('retrieve', (state) => (state.intent === 'pedido' ? 'quote' : 'compose'))
    .addEdge('quote', 'compose')
    .addEdge('compose', 'guard')
    .addConditionalEdge('guard', (state) => (state.handoff.required ? 'escalate' : 'remember'))
    .addEdge('escalate', 'remember')
    .addEdge('remember', END);

  return {
    graph,
    async handle(message: InboundMessage): Promise<AgentResult> {
      const result = await graph.run(createInitialState(message));
      const { state, steps } = result;
      return {
        conversationId: message.conversationId,
        channel: message.channel,
        intent: state.intent,
        confidence: state.confidence,
        reply: state.reply,
        handoff: state.handoff.required,
        handoffReason: state.handoff.required ? state.handoff.reason : undefined,
        ticketId: state.handoff.ticketId,
        retrieved: state.retrieved,
        quote: state.quote,
        trace: state.trace,
        steps: steps.map((step) => ({ node: step.node, next: step.next, ms: step.ms })),
      };
    },
  };
}
