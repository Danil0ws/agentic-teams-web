import { readFileSync } from 'node:fs';
import { scoreText, tokenize } from '../utils/text.ts';

export interface KbSection {
  id: string;
  titulo: string;
  corpo: string;
}

export interface KbHit {
  section: KbSection;
  score: number;
}

/** Carrega o FAQ em markdown: cada "## " vira uma seção endereçável. */
export class KnowledgeBase {
  readonly sections: KbSection[];

  private constructor(sections: KbSection[]) {
    this.sections = sections;
  }

  static load(path: string): KnowledgeBase {
    return KnowledgeBase.fromMarkdown(readFileSync(path, 'utf8'));
  }

  static fromMarkdown(markdown: string): KnowledgeBase {
    const sections: KbSection[] = [];
    let current: KbSection | undefined;
    for (const line of markdown.split('\n')) {
      const heading = /^##\s+(.*)$/.exec(line);
      if (heading) {
        if (current) sections.push({ ...current, corpo: current.corpo.trim() });
        const titulo = heading[1].trim();
        current = { id: titulo.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), titulo, corpo: '' };
        continue;
      }
      if (current) current.corpo += `${line}\n`;
    }
    if (current) sections.push({ ...current, corpo: current.corpo.trim() });
    return new KnowledgeBase(sections);
  }

  search(query: string, limit = 2): KbHit[] {
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    return this.sections
      .map((section) => ({ section, score: scoreText(tokens, `${section.titulo} ${section.corpo}`, 1) }))
      .filter((hit) => hit.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }
}
