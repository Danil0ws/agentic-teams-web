export const END = '__end__';

export type NodeFn<S> = (state: S, run: GraphRun<S>) => Promise<Partial<S>> | Partial<S>;

export interface GraphStep {
  node: string;
  /** Nó escolhido depois deste (END quando termina). */
  next: string;
  ms: number;
  error?: string;
}

export interface GraphRunResult<S> {
  state: S;
  steps: GraphStep[];
}

export interface GraphRun<S> {
  readonly steps: GraphStep[];
  /** Injeta metadados observáveis no estado (usado para trace). */
  annotate(state: S, note: string): void;
}

/**
 * Grafo de estados mínimo inspirado no LangGraph: nós puros + arestas
 * condicionais, com trace por passo e proteção contra ciclos.
 * Sem dependência externa — o mesmo motor roda no teste e em produção.
 */
export class StateGraph<S extends { trace?: string[] }> {
  readonly name: string;
  private readonly maxSteps: number;
  private readonly nodes = new Map<string, NodeFn<S>>();
  private readonly edges = new Map<string, string | ((state: S) => string)>();
  private entry?: string;

  constructor(name: string, maxSteps = 25) {
    this.name = name;
    this.maxSteps = maxSteps;
  }

  addNode(name: string, fn: NodeFn<S>): this {
    if (this.nodes.has(name)) throw new Error(`nó duplicado: ${name}`);
    this.nodes.set(name, fn);
    return this;
  }

  setEntry(name: string): this {
    this.entry = name;
    return this;
  }

  addEdge(from: string, to: string): this {
    this.edges.set(from, to);
    return this;
  }

  addConditionalEdge(from: string, resolver: (state: S) => string): this {
    this.edges.set(from, resolver);
    return this;
  }

  /** Executa o grafo a partir do estado inicial, mesclando cada retorno parcial. */
  async run(initial: S): Promise<GraphRunResult<S>> {
    if (!this.entry) throw new Error(`grafo ${this.name} sem entry point`);
    const steps: GraphStep[] = [];
    const state = initial;
    const run: GraphRun<S> = {
      steps,
      annotate(target, note) {
        target.trace = [...(target.trace ?? []), note];
      },
    };
    let current: string = this.entry;
    for (let hop = 0; hop < this.maxSteps; hop += 1) {
      if (current === END) break;
      const node = this.nodes.get(current);
      if (!node) throw new Error(`nó inexistente: ${current}`);
      const startedAt = performance.now();
      let next: string;
      try {
        const patch = await node(state, run);
        if (patch && typeof patch === 'object') Object.assign(state, patch);
        const edge = this.edges.get(current);
        next = typeof edge === 'function' ? edge(state) : (edge ?? END);
        state.trace = [...(state.trace ?? []), current];
        steps.push({ node: current, next, ms: Math.round((performance.now() - startedAt) * 100) / 100 });
      } catch (error) {
        steps.push({ node: current, next: END, ms: Math.round((performance.now() - startedAt) * 100) / 100, error: (error as Error).message });
        throw error;
      }
      current = next;
    }
    if (current !== END && steps.length >= this.maxSteps) {
      throw new Error(`grafo ${this.name} excedeu ${this.maxSteps} passos (possível ciclo)`);
    }
    return { state, steps };
  }
}
