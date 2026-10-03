/** Remove acentos e normaliza para comparação de tokens. */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

const STOPWORDS = new Set([
  'a', 'o', 'os', 'as', 'de', 'da', 'do', 'das', 'dos', 'e', 'ou', 'que', 'qual', 'quais',
  'para', 'por', 'com', 'sem', 'um', 'uma', 'no', 'na', 'nos', 'nas', 'em', 'me', 'te',
  'se', 'ja', 'mais', 'menos', 'muito', 'tem', 'ter', 'ser', 'sao', 'esta', 'estao',
  'isso', 'esse', 'essa', 'este', 'esta', 'eu', 'voce', 'nos', 'quero', 'preciso',
  'por favor', 'favor', 'the', 'and', 'for', 'with', 'how', 'what',
]);

/** Tokeniza texto livre em termos relevantes (sem acento, sem stopwords). */
export function tokenize(text: string): string[] {
  return normalize(text)
    .replace(/[^a-z0-9\s.-]/g, ' ')
    .split(/[\s.]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

/** Pontuação BM25-lite: combina cobertura dos termos da consulta com o campo. */
export function scoreText(queryTokens: string[], haystack: string, weight = 1): number {
  const target = normalize(haystack);
  let score = 0;
  for (const token of queryTokens) {
    if (!target.includes(token)) continue;
    const occurrences = target.split(token).length - 1;
    score += (1 + Math.log(occurrences)) * (token.length > 4 ? 1.4 : 1);
  }
  return score * weight;
}

export function formatBrl(value: number): string {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
