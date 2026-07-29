/**
 * Réconciliation des liaisons — opération `reconcile_links`, usage IA n°2.
 * CDC §4.2.3 et §4.1.7, critère d'acceptation n°4.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE CE FICHIER REMPLACE
 *
 * `equipment-auto-link.service.ts` portait DEUX appels directs au SDK Gemini,
 * avec leur propre modèle codé en dur (`gemini-2.5-flash`), leurs propres
 * prompts — l'un lu dans un `.txt`, l'autre écrit en dur dans le fichier —,
 * leur propre parsing JSON et leurs propres seuils. Aucun n'apparaissait dans
 * le suivi des coûts, aucun n'était couvert par la gouvernance des prompts,
 * aucun ne respectait le référentiel des modèles.
 *
 * L'opération `reconcile_links` était déclarée dans le référentiel depuis le
 * lot 1, mais rien ne l'implémentait : ni prompt, ni schéma de sortie, ni
 * appelant. C'est le `link-reconciler.ts` que l'audit signalait comme non écrit.
 *
 * Les deux appels convergent ici, derrière la gateway : un seul modèle, issu du
 * référentiel ; un seul prompt, versionné et gouverné ; une sortie validée par
 * schéma ; un coût mesuré ; l'idempotence du §5.7.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { z } from 'zod';
import { AiGateway } from '../gateway/ai-gateway';
import { isAiGatewayError } from '../gateway/errors';

/** Seuils de rétention, repris à l'identique de l'existant pour ne pas changer le comportement. */
export const LINK_SCORE_THRESHOLDS = {
  /** Rattachement d'un équipement à des documents, agendas et fournisseurs. */
  equipmentToObjects: 0.4,
  /** Rattachement d'un document à un équipement. */
  documentToEquipment: 0.5,
} as const;

const MatchSchema = z.object({
  id: z.number().int().positive(),
  score: z.number().min(0).max(1),
  reason: z.string().max(300).optional().default(''),
});

/** Sortie de `reconcile_links` — déclarée `ReconcileLinksOutput` au référentiel. */
export const ReconcileLinksOutput = z.object({
  documents: z.array(MatchSchema).optional().default([]),
  agendaItems: z.array(MatchSchema).optional().default([]),
  suppliers: z.array(MatchSchema).optional().default([]),
  matches: z.array(MatchSchema).optional().default([]),
});

export type LinkMatch = z.infer<typeof MatchSchema>;
export type ReconcileLinksResult = z.infer<typeof ReconcileLinksOutput>;

const EMPTY: ReconcileLinksResult = { documents: [], agendaItems: [], suppliers: [], matches: [] };

export interface ReconcileLinksInput {
  accountId: number;
  userId?: number;
  /** Variables du prompt versionné `reconcile_links_v1`. */
  variables: Record<string, unknown>;
  /** Sources concernées — trace et clé d'idempotence (§5.7). */
  sourceIds?: number[];
}

/**
 * Appelle le modèle pour départager des liaisons que le déterminisme n'a pas
 * tranchées.
 *
 * ⚠️ NE LÈVE JAMAIS. Le comportement d'origine était déjà celui-ci : les deux
 * appels étaient encadrés d'un `try/catch` documenté « non-blocking », et
 * l'absence de clé d'API produisait simplement un résultat vide. Les
 * rattachements déterministes s'appliquent dans tous les cas.
 *
 * Cette tolérance est ce qui rend la migration sûre : un prompt non encore
 * semé en base, une opération désactivée au référentiel ou une panne
 * fournisseur dégradent vers le déterministe seul, exactement comme avant.
 */
export async function reconcileLinks(
  input: ReconcileLinksInput,
): Promise<ReconcileLinksResult> {
  try {
    const res = await AiGateway.execute({
      useCaseCode: 'DATA_RECONCILIATION',
      operationCode: 'reconcile_links',
      accountId: input.accountId,
      userId: input.userId,
      sourceIds: input.sourceIds,
      promptVariables: input.variables,
      outputSchema: ReconcileLinksOutput,
    });
    return res.data;
  } catch (e) {
    // Une erreur de gateway est journalisée avec son code : c'est ce qui permet
    // de distinguer « prompt absent » de « fournisseur indisponible » sans
    // ouvrir les traces.
    const detail = isAiGatewayError(e) ? `${e.code} — ${e.message}` : (e as Error).message;
    console.warn(`[reconcile-links] Départage modèle indisponible (${detail}) — déterministe seul.`);
    return EMPTY;
  }
}

/** Filtre les correspondances au-dessus du seuil, du meilleur score au moins bon. */
export function retainAbove(matches: LinkMatch[], threshold: number): LinkMatch[] {
  return matches.filter((m) => m.score >= threshold).sort((a, b) => b.score - a.score);
}
