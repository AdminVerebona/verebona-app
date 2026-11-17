/**
 * CONTRÔLE FINAL DE DISPONIBILITÉ d'une activation — façade commune, lot 115,
 * carte Trello #786 (écarts E01 et E03).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL CONTRÔLE FINAL, POUR TOUTES LES ACTIVATIONS
 *
 * #771 (A03) avait posé le recontrôle transactionnel final sur la promotion
 * d'une candidate automatique et sur les surcouches de routage par type
 * d'appel. Il MANQUAIT sur les deux gestes qui remettent une configuration
 * ANCIENNE en service :
 *   · « Activer » / « Restaurer » une version déjà connue (réactivation d'une
 *     configuration historique) : les contrôles métier sont volontairement
 *     allégés (décision PO 06), et la disponibilité n'était pas relue ;
 *   · l'IMPORT d'un fichier de configuration, qui active la version importée
 *     dans la même transaction.
 * Une configuration historique pouvait donc remettre en service, sans un mot,
 * un modèle confirmé indisponible pour la clé active.
 *
 * Cette façade est le corps commun : les trois appelants (activation
 * manuelle, import, promotion d'une candidate) la partagent, chacun levant
 * son propre refus fonctionnel avec le message rendu ici.
 *
 *   · refus confirmé pour l'accès actif  → `BLOCKED_MODEL_UNAVAILABLE` ;
 *   · contrôle final IMPOSSIBLE (lecture en erreur, clé illisible) →
 *     `BLOCKED_MODEL_UNAVAILABLE` aussi (E01) : jamais une admission sans
 *     contrôle. Les preuves et la version restent intactes — rien n'est écrit.
 *
 * Aucun tarif, aucune qualification ici : disponibilité (#771, #786), tarif
 * (#770) et aptitude métier restent trois dimensions distinctes et
 * cumulatives, et les deux autres sont contrôlées ailleurs (sélection des
 * modèles, verrou A1).
 */
import type { OperationalCapability } from '../provider/probe-classification';

/** Exécuteur de requêtes de la transaction de l'appelant. */
type SqlLike = { unsafe: (query: string, params?: never[]) => Promise<unknown> };

/** Refus du contrôle final (code unique, message et détails pour le journal). */
export interface ActivationAvailabilityRefusal {
  code: 'BLOCKED_MODEL_UNAVAILABLE';
  message: string;
  model: string;
  /** Capacité réellement refusée, quand l'état la porte (migration 1816). */
  capability?: OperationalCapability;
  checkedAt?: string | null;
  /** Le contrôle final n'a pas pu être fait (jamais présenté comme « rien ne s'oppose »). */
  unverifiable?: true;
}

/**
 * Contrôle final de disponibilité des modèles d'une chaîne, DANS la
 * transaction de l'appelant. Rend `null` quand rien ne s'oppose, sinon le
 * premier refus (ordre stable : l'ordre des modèles transmis).
 *
 * `geste` est repris dans le message (« Activation annulée », « Import
 * annulé ») — textes à valider par le PO.
 */
export async function activationAvailabilityRefusal(
  sql: SqlLike, models: readonly string[], geste: string,
): Promise<ActivationAvailabilityRefusal | null> {
  const { operationalRefusalInTx } = await import('../provider/model-operational.service');
  for (const model of new Set(models)) {
    const verdict = await operationalRefusalInTx(sql, model);
    if (verdict.kind === 'refused') {
      return {
        code: 'BLOCKED_MODEL_UNAVAILABLE', model,
        ...(verdict.capability ? { capability: verdict.capability } : {}),
        checkedAt: verdict.checkedAt,
        message: `${geste} dans la transaction : « ${model} » est confirmé indisponible pour la clé active`
          + `${verdict.capability ? ` (capacité ${verdict.capability})` : ''}${verdict.error ? ` : ${verdict.error}` : ''}.`,
      };
    }
    // #786 (E01) : contrôle final impossible — le geste est refusé, la configuration et ses preuves conservées.
    if (verdict.kind === 'unverifiable') {
      return {
        code: 'BLOCKED_MODEL_UNAVAILABLE', model, unverifiable: true,
        message: `${geste} dans la transaction : la disponibilité de « ${model} » n’a pas pu être contrôlée (${verdict.detail}).`,
      };
    }
  }
  return null;
}

/** Modèles d'une entrée de configuration (principal et replis), sans doublon ni valeur vide. */
export function chainModelsOf(entries: ReadonlyArray<{ primaryModel?: string | null; fallback1?: string | null; fallback2?: string | null }>): string[] {
  const out: string[] = [];
  for (const e of entries) {
    for (const m of [e.primaryModel, e.fallback1, e.fallback2]) {
      if (m && !out.includes(m)) out.push(m);
    }
  }
  return out;
}
