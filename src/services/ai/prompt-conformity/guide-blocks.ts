/**
 * Lot 99B — blocs de texte OFFICIELS du guide du PO
 * (`docs/exploitation/prompts-a-appliquer-par-le-po.md`).
 *
 * Le guide balise chaque bloc à coller :
 *
 *   <!-- l89c:bloc id="…" prompt="t3" action="insert-before" anchor="…" -->
 *   ```text
 *   …texte exact…
 *   ```
 *
 * Ces blocs sont rejoués contre les validateurs réels par les tests des lots
 * 89C, 91D, 97A et 98A (`l89c-guide-prompts.test.ts`…). La mise en conformité
 * automatique les réutilise TELS QUELS : aucune copie dans le code, aucun
 * texte généré. Lecture seule, aucune base. Guide illisible : aucun bloc
 * (la correction automatique est alors refusée, défaut de CODE).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type GuideBlockAction = 'insert-before' | 'replace-line' | 'replace-from-to';

export interface GuideBlock {
  id: string;
  /** Prompt visé (`t1`, `t3`, `t4`, `t6`). */
  prompt: string;
  action: GuideBlockAction;
  /** Ligne repère (insert-before, replace-line). */
  anchor: string | null;
  /** Bornes du remplacement (replace-from-to) : `from` incluse, `to` exclue. */
  from: string | null;
  to: string | null;
  text: string;
  /** Empreinte du texte du bloc (entre dans l'empreinte du contexte d'un essai). */
  sha256: string;
}

const RE_BLOC = /<!-- l89c:bloc ([^>]*?) -->\s*\n```text\n([\s\S]*?)\n```/g;
const ACTIONS: readonly GuideBlockAction[] = ['insert-before', 'replace-line', 'replace-from-to'];

/** Blocs balisés d'un texte de guide (pur). Un bloc mal balisé est ignoré. */
export function parseGuideBlocks(markdown: string): GuideBlock[] {
  const out: GuideBlock[] = [];
  for (const m of markdown.replace(/\r\n?/g, '\n').matchAll(RE_BLOC)) {
    const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
    const action = attrs.action as GuideBlockAction;
    if (!attrs.id || !attrs.prompt || !ACTIONS.includes(action)) continue;
    out.push({
      id: attrs.id, prompt: attrs.prompt, action,
      anchor: attrs.anchor ?? null, from: attrs.from ?? null, to: attrs.to ?? null,
      text: m[2], sha256: createHash('sha256').update(m[2]).digest('hex'),
    });
  }
  return out;
}

/** Chemin du guide : dépôt (process.cwd), puis relatif au module (tests, outils). */
export function guidePathCandidates(): string[] {
  return [
    join(process.cwd(), 'docs', 'exploitation', 'prompts-a-appliquer-par-le-po.md'),
    join(__dirname, '..', '..', '..', '..', 'docs', 'exploitation', 'prompts-a-appliquer-par-le-po.md'),
  ];
}

let cache: { blocks: GuideBlock[]; path: string | null } | null = null;
let override: string | null = null;

/** Tests seulement : texte de guide substitué (`null` : lecture réelle). */
export function __setGuideTextForTests(text: string | null): void { override = text; cache = null; }

/** Blocs officiels du guide (mémorisés : le guide est un fichier du dépôt). */
export function loadGuideBlocks(): { blocks: GuideBlock[]; path: string | null } {
  if (override !== null) return { blocks: parseGuideBlocks(override), path: 'test' };
  if (cache) return cache;
  for (const p of guidePathCandidates()) {
    try {
      if (existsSync(p)) { cache = { blocks: parseGuideBlocks(readFileSync(p, 'utf8')), path: p }; return cache; }
    } catch { /* chemin suivant */ }
  }
  cache = { blocks: [], path: null };
  return cache;
}

/** Bloc officiel par identifiant, ou `null`. */
export function guideBlock(id: string): GuideBlock | null {
  return loadGuideBlocks().blocks.find((b) => b.id === id) ?? null;
}
