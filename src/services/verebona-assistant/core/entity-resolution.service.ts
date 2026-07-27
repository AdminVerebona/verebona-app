/**
 * Résolution d'entités conversationnelles — CDC §13.3 / §16.4.
 *
 * Résout « il/elle/le deuxième/celui-là » à partir des entités présentées au tour
 * précédent et du contexte de page (assetId courant). N'invente jamais d'entité :
 * en cas d'ambiguïté, signale qu'une clarification est nécessaire (§20).
 */
import type { ConversationRefs } from '../types/machine';
import type { PageContext } from '../types/contracts';

export interface ResolvedEntityRef {
  type: 'asset' | 'document' | 'agenda' | 'supplier';
  id: string | number;
  source: 'pronoun' | 'ordinal' | 'page_context' | 'explicit';
}

export interface EntityResolutionResult {
  resolved: ResolvedEntityRef[];
  ambiguous: boolean;
}

const ORDINALS: Record<string, number> = {
  'premier': 1, 'première': 1, 'deuxième': 2, 'second': 2, 'troisième': 3,
  'quatrième': 4, 'cinquième': 5, 'dernier': -1, 'dernière': -1,
};

export function resolveEntities(
  message: string,
  refs: ConversationRefs,
  page?: PageContext,
): EntityResolutionResult {
  const resolved: ResolvedEntityRef[] = [];
  const lower = message.toLowerCase();

  // Ordinal : « le deuxième »
  for (const [word, pos] of Object.entries(ORDINALS)) {
    if (lower.includes(word)) {
      const list = refs.lastPresentedEntities;
      const target = pos === -1 ? list[list.length - 1] : list.find((e) => e.position === pos);
      if (target) resolved.push({ type: target.type as ResolvedEntityRef['type'], id: target.id, source: 'ordinal' });
    }
  }

  // Pronom : « il/elle/le/la/celui-ci » → dernière entité unique présentée
  if (/\b(il|elle|le|la|celui|celle|ça|cela)\b/.test(lower) && refs.lastPresentedEntities.length === 1) {
    const e = refs.lastPresentedEntities[0];
    resolved.push({ type: e.type as ResolvedEntityRef['type'], id: e.id, source: 'pronoun' });
  }

  // Contexte de page (§16.4)
  if (resolved.length === 0 && page?.assetId) {
    resolved.push({ type: 'asset', id: page.assetId, source: 'page_context' });
  }

  // Ambiguïté : pronom mais plusieurs candidats présentés.
  const ambiguous =
    /\b(il|elle|le|la|celui|celle)\b/.test(lower) && refs.lastPresentedEntities.length > 1 && resolved.length === 0;

  return { resolved, ambiguous };
}
