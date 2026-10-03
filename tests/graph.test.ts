import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StateGraph, END } from '../src/agent/graph.ts';

interface FakeState {
  value: number;
  path: string[];
  branch?: string;
  trace: string[];
}

function buildGraph(maxSteps = 10): StateGraph<FakeState> {
  return new StateGraph<FakeState>('teste', maxSteps)
    .addNode('start', (state) => ({ value: state.value + 1 }))
    .addNode('grow', (state) => ({ value: state.value * 2 }))
    .addNode('par', (state) => ({ branch: 'par' }))
    .addNode('impar', (state) => ({ branch: 'impar' }))
    .addNode('fim', () => ({}))
    .setEntry('start')
    .addEdge('start', 'grow')
    .addEdge('grow', 'decidir')
    .addNode('decidir', (state) => ({ path: [...state.path, state.value % 2 === 0 ? 'par' : 'impar'] }))
    .addConditionalEdge('decidir', (state) => (state.value % 2 === 0 ? 'par' : 'impar'))
    .addEdge('par', 'fim')
    .addEdge('impar', 'fim')
    .addEdge('fim', END);
}

test('grafo executa nós na ordem e mescla os retornos parciais', async () => {
  const { state, steps } = await buildGraph().run({ value: 3, path: [], trace: [] });
  assert.equal(state.value, 8);
  assert.equal(state.branch, 'par');
  assert.deepEqual(state.trace, ['start', 'grow', 'decidir', 'par', 'fim']);
  assert.deepEqual(steps.map((step) => step.node), ['start', 'grow', 'decidir', 'par', 'fim']);
  assert.equal(steps.at(-1)?.next, END);
  assert.ok(steps.every((step) => typeof step.ms === 'number'));
});

test('aresta condicional segue o ramo ímpar', async () => {
  const graph = new StateGraph<FakeState>('ramo')
    .addNode('decidir', () => ({}))
    .addNode('par', () => ({ branch: 'par' }))
    .addNode('impar', () => ({ branch: 'impar' }))
    .setEntry('decidir')
    .addConditionalEdge('decidir', (state) => (state.value % 2 === 0 ? 'par' : 'impar'))
    .addEdge('par', END)
    .addEdge('impar', END);
  const impar = await graph.run({ value: 3, path: [], trace: [] });
  assert.equal(impar.state.branch, 'impar');
  assert.deepEqual(impar.state.trace, ['decidir', 'impar']);
  const par = await graph.run({ value: 4, path: [], trace: [] });
  assert.equal(par.state.branch, 'par');
});

test('ciclo é interrompido com erro explícito', async () => {
  const graph = new StateGraph<FakeState>('ciclo', 4)
    .addNode('loop', () => ({}))
    .setEntry('loop')
    .addEdge('loop', 'loop');
  await assert.rejects(() => graph.run({ value: 0, path: [], trace: [] }), /excedeu 4 passos/);
});

test('erro em um nó é registrado no passo e propagado', async () => {
  const graph = new StateGraph<FakeState>('erro')
    .addNode('explode', () => {
      throw new Error('falha proposital');
    })
    .setEntry('explode');
  await assert.rejects(() => graph.run({ value: 0, path: [], trace: [] }), /falha proposital/);
});

test('grafo sem entry point falha na hora de rodar', async () => {
  const graph = new StateGraph<FakeState>('vazio').addNode('x', () => ({}));
  await assert.rejects(() => graph.run({ value: 0, path: [], trace: [] }), /sem entry point/);
});
