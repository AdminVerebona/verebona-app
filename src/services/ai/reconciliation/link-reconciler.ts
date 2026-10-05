/**
 * Réconciliation des liaisons — usage IA n°2, CDC §4.2.3 et §4.1.7, CDC 15
 * §25, T3-07.
 *
 * `equipment-auto-link.service.ts` portait autrefois deux appels directs au
 * SDK, convergés ici derrière la passerelle (un modèle du référentiel, un
 * prompt gouverné, une sortie validée, un coût mesuré, l'idempotence du §5.7).
 *
 * Lot 16b-3 (retrait de l'ancien moteur) : l'opération historique
 * `reconcile_links` et son prompt sont SUPPRIMÉS. Le départage passe toujours
 * par le prompt maître T3 (`t3_link_ambiguity`, TASK=LINK_AMBIGUITY) : marge
 * minimale, abstention explicite et monde fermé (`master/link-ambiguity`).
 */
import { reconcileLinksMaster, type LinkAmbiguity } from './master/link-ambiguity';

export { LINK_MIN_MARGIN } from './master/link-ambiguity';

/**
 * Seuils de rétention (repris à l'identique de l'existant), définis avec les
 * règles T3-07 dans `master/link-ambiguity` — la marge s'y calcule parmi les
 * candidats AU-DESSUS de ces seuils — et réexportés ici pour les appelants.
 */
export { LINK_SCORE_THRESHOLDS } from './master/link-ambiguity';

export interface LinkMatch {
  id: number;
  score: number;
  reason: string;
}

export interface ReconcileLinksResult {
  documents: LinkMatch[];
  agendaItems: LinkMatch[];
  suppliers: LinkMatch[];
  matches: LinkMatch[];
  /**
   * CDC 15 T3-07 : abstentions explicites — marge insuffisante, égalité ou
   * identifiant hors liste. Aucune liaison automatique pour ces candidats.
   */
  ambiguities: LinkAmbiguity[];
}

export interface ReconcileLinksInput {
  accountId: number;
  userId?: number;
  /** Candidats par section et contexte du sujet (`master/link-ambiguity`). */
  variables: Record<string, unknown>;
  /** Sources concernées — trace et clé d'idempotence (§5.7). */
  sourceIds?: number[];
}

/**
 * Appelle le master T3 pour départager des liaisons que le déterminisme n'a
 * pas tranchées.
 *
 * ⚠️ NE LÈVE JAMAIS (sauf interruption d'une exécution de file) : une panne
 * fournisseur dégrade vers le déterministe seul, section par section. Les
 * rattachements déterministes s'appliquent dans tous les cas.
 */
export async function reconcileLinks(
  input: ReconcileLinksInput,
): Promise<ReconcileLinksResult> {
  return reconcileLinksMaster(input);
}

/** Filtre les correspondances au-dessus du seuil, du meilleur score au moins bon. */
export function retainAbove(matches: LinkMatch[], threshold: number): LinkMatch[] {
  return matches.filter((m) => m.score >= threshold).sort((a, b) => b.score - a.score);
}
