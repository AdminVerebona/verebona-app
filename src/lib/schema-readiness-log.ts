/**
 * Message d'un contrôle de schéma non concluant (lot 69, ticket
 * « diagnostics codés en dur »). Pur.
 *
 * Les contrôles « colonnes de la migration N présentes ? » restent
 * prudents (illisible ⇒ fonctionnalité désactivée, comportement inchangé),
 * mais leur journal ne doit plus AFFIRMER ce qu'il n'a pas constaté :
 *   · requête en échec → « vérification impossible », pas « migration non
 *     appliquée » (la cause peut être une connexion, un droit…) ;
 *   · une partie seulement des colonnes trouvée → « n/N présentes », sans
 *     déclarer absentes celles qui existent ;
 *   · colonnes absentes CONNUES (ou aucune trouvée) → elles seules sont citées.
 */
export interface SchemaProbeOutcome {
  /** Préfixe du journal, ex. `[agenda]`. */
  scope: string;
  /** Migration attendue, ex. `0223`. */
  migration: string;
  /** Colonnes (ou objets) attendus, pour le contexte. */
  expected: readonly string[];
  /** Nombre trouvé (contrôle par comptage) ; null si inconnu. */
  found?: number | null;
  /** Colonnes absentes, quand le contrôle les connaît exactement. */
  missing?: readonly string[] | null;
  /** Erreur de la requête de contrôle. */
  error?: unknown;
  /** Effet sur l'application (phrase terminée par un point). */
  consequence: string;
}

const errText = (e: unknown) => String((e as { message?: unknown })?.message ?? e ?? 'erreur inconnue').slice(0, 200);

export function schemaNotReadyMessage(p: SchemaProbeOutcome): string {
  if (p.error !== undefined && p.error !== null) {
    return `${p.scope} ⚠️ Vérification du schéma (migration ${p.migration}) impossible : ${errText(p.error)}. `
      + `Par prudence : ${p.consequence} Voir /api/health.`;
  }
  const missing = p.missing ?? (p.found === 0 ? p.expected : null);
  if (missing && missing.length) {
    return `${p.scope} ⚠️ MIGRATION ${p.migration} NON APPLIQUÉE : ${missing.join(', ')} absent${missing.length > 1 ? 's' : ''}. `
      + `${p.consequence} Voir /api/health.`;
  }
  if (typeof p.found === 'number') {
    return `${p.scope} ⚠️ MIGRATION ${p.migration} INCOMPLÈTE : ${p.found}/${p.expected.length} des éléments attendus présents (${p.expected.join(', ')}). `
      + `${p.consequence} Voir /api/health.`;
  }
  return `${p.scope} ⚠️ MIGRATION ${p.migration} NON APPLIQUÉE OU INCOMPLÈTE : au moins un élément absent parmi ${p.expected.join(', ')}. `
    + `${p.consequence} Voir /api/health.`;
}
