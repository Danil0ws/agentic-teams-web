import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Catalog, discountTier } from '../src/tools/catalog.ts';
import { KnowledgeBase } from '../src/tools/kb.ts';
import { tokenize, formatBrl, normalize } from '../src/utils/text.ts';

const catalogPath = fileURLToPath(new URL('../data/catalog.csv', import.meta.url));
const faqPath = fileURLToPath(new URL('../data/faq.md', import.meta.url));

const catalog = Catalog.load(catalogPath);
const kb = KnowledgeBase.load(faqPath);
const flat = (value: string): string => value.replace(/\u00a0/g, ' ');

test('catálogo carrega os SKUs do CSV com preço numérico', () => {
  const items = catalog.all();
  assert.equal(items.length, 9);
  const copilot = catalog.get('TL-COPILOT-C');
  assert.ok(copilot);
  assert.equal(copilot?.precoMensal, 190);
  assert.equal(copilot?.categoria, 'ia');
});

test('busca por linguagem natural encontra o SKU certo', () => {
  const byName = catalog.search('quanto custa o copilot', 3);
  assert.equal(byName[0]?.item.sku, 'TL-COPILOT-C');

  const bySku = catalog.search('TL-PHONE-STD', 3);
  assert.equal(bySku[0]?.item.sku, 'TL-PHONE-STD');

  const byCategory = catalog.search('telefonia pstn', 3);
  assert.ok(byCategory.some((hit) => hit.item.sku === 'TL-PHONE-STD'));
});

test('faixas de desconto seguem o FAQ (0%, 10%, 15%)', () => {
  assert.equal(discountTier(5), 0);
  assert.equal(discountTier(20), 0.1);
  assert.equal(discountTier(99), 0.1);
  assert.equal(discountTier(100), 0.15);
});

test('orçamento calcula subtotal, desconto e total', () => {
  const quote = catalog.quote([{ sku: 'TL-M365-PREM', qtd: 25 }]);
  assert.equal(quote.assentos, 25);
  assert.equal(quote.descontoPct, 0.1);
  assert.equal(quote.subtotal, 3625);
  assert.equal(quote.descontoTotal, 362.5);
  assert.equal(quote.total, 3262.5);
  assert.ok(flat(formatBrl(quote.total)).includes('3.262,50'));
});

test('orçamento avisa SKU inexistente e estoque insuficiente', () => {
  const quote = catalog.quote([
    { sku: 'TL-NAO-EXISTE', qtd: 2 },
    { sku: 'TL-COPILOT-C', qtd: 500 },
  ]);
  assert.equal(quote.linhas.length, 1);
  assert.equal(quote.avisos.length, 2);
  assert.equal(quote.linhas[0]?.estoqueSuficiente, false);
});

test('base de conhecimento indexa as seções do markdown', () => {
  assert.ok(kb.sections.length >= 7);
  const sla = kb.search('qual o sla de disponibilidade mensal', 2);
  assert.equal(sla[0]?.section.titulo.toUpperCase(), 'SLA E SUPORTE');

  const lgpd = kb.search('como vocês tratam dados pessoais e LGPD', 2);
  assert.equal(lgpd[0]?.section.titulo, 'Seguranca e LGPD');
});

test('tokenização ignora stopwords e acentos', () => {
  const tokens = tokenize('Qual é o PRÊÇO do Copilot para 25 usuários?');
  assert.ok(tokens.includes('copilot'));
  assert.ok(!tokens.includes('para'));
  assert.equal(normalize('Segurança'), 'seguranca');
});
