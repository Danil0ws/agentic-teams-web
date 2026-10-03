import { readFileSync } from 'node:fs';
import { scoreText, tokenize } from '../utils/text.ts';

export interface CatalogItem {
  sku: string;
  nome: string;
  categoria: string;
  precoMensal: number;
  estoque: number;
  descricao: string;
}

export interface CatalogHit {
  item: CatalogItem;
  score: number;
}

export interface QuoteLine {
  sku: string;
  nome: string;
  qtd: number;
  unitario: number;
  subtotal: number;
  estoqueSuficiente: boolean;
}

export interface Quote {
  moeda: 'BRL';
  linhas: QuoteLine[];
  assentos: number;
  subtotal: number;
  descontoPct: number;
  descontoTotal: number;
  total: number;
  avisos: string[];
}

/** Parser CSV mínimo com suporte a campos entre aspas. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((line) => line.length > 1);
}

/** Faixas de desconto por volume de assentos (ver data/faq.md). */
export function discountTier(assentos: number): number {
  if (assentos >= 100) return 0.15;
  if (assentos >= 20) return 0.1;
  return 0;
}

export class Catalog {
  private readonly items: CatalogItem[];

  private constructor(items: CatalogItem[]) {
    this.items = items;
  }

  static load(path: string): Catalog {
    const rows = parseCsv(readFileSync(path, 'utf8'));
    const [header, ...body] = rows;
    const index = new Map(header.map((column, position) => [column.trim(), position]));
    const items = body.map((row) => ({
      sku: (row[index.get('sku') ?? 0] ?? '').trim(),
      nome: (row[index.get('nome') ?? 1] ?? '').trim(),
      categoria: (row[index.get('categoria') ?? 2] ?? '').trim(),
      precoMensal: Number((row[index.get('preco_mensal_brl') ?? 3] ?? '0').replace(',', '.')),
      estoque: Number(row[index.get('estoque') ?? 4] ?? '0'),
      descricao: (row[index.get('descricao') ?? 5] ?? '').trim(),
    }));
    return new Catalog(items);
  }

  static fromItems(items: CatalogItem[]): Catalog {
    return new Catalog(items);
  }

  all(): CatalogItem[] {
    return [...this.items];
  }

  get(sku: string): CatalogItem | undefined {
    return this.items.find((item) => item.sku.toLowerCase() === sku.toLowerCase());
  }

  /** Busca por SKU, nome, categoria e descrição. */
  search(query: string, limit = 3): CatalogHit[] {
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    return this.items
      .map((item) => {
        const score =
          scoreText(tokens, item.sku, 2.5) +
          scoreText(tokens, item.nome, 2) +
          scoreText(tokens, item.categoria, 1.2) +
          scoreText(tokens, item.descricao, 0.6);
        return { item, score };
      })
      .filter((hit) => hit.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }

  /** Monta orçamento com validação de SKU, estoque e desconto por volume. */
  quote(request: Array<{ sku: string; qtd: number }>): Quote {
    const avisos: string[] = [];
    const linhas: QuoteLine[] = [];
    for (const entry of request) {
      const item = this.get(entry.sku);
      if (!item) {
        avisos.push(`SKU "${entry.sku}" não encontrado no catálogo.`);
        continue;
      }
      const qtd = Math.max(1, Math.trunc(entry.qtd));
      const estoqueSuficiente = item.estoque >= qtd;
      if (!estoqueSuficiente) avisos.push(`${item.nome}: estoque atual de ${item.estoque} assentos, pedido de ${qtd}.`);
      linhas.push({ sku: item.sku, nome: item.nome, qtd, unitario: item.precoMensal, subtotal: qtd * item.precoMensal, estoqueSuficiente });
    }
    const assentos = linhas.reduce((total, linha) => total + linha.qtd, 0);
    const subtotal = linhas.reduce((total, linha) => total + linha.subtotal, 0);
    const descontoPct = discountTier(assentos);
    const descontoTotal = Number((subtotal * descontoPct).toFixed(2));
    const total = Number((subtotal - descontoTotal).toFixed(2));
    return { moeda: 'BRL', linhas, assentos, subtotal: Number(subtotal.toFixed(2)), descontoPct, descontoTotal, total, avisos };
  }
}
