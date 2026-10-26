/**
 * Message d'un contrôle de schéma (lot 69, ticket « diagnostics codés en
 * dur » ; lot 75A, ticket « Diagnostics réels — incohérences résiduelles »
 * §3). Pur.
 *
 * Les contrôles « éléments attendus présents ? » restent prudents (illisible
 * ⇒ fonctionnalité désactivée, comportement inchangé), mais leur journal
 * n'affirme QUE ce qui a été constaté. Il ne conclut JAMAIS « migration non
 * appliquée » : l'absence d'une colonne ne prouve pas que la migration n'a
 * pas été exécutée (autre schéma courant, droits, migration partielle,
 * objet supprimé à la main…).
 *
 *   État constaté                      Diagnostic
 *   ─────────────────────────────────  ───────────────────────────────────────
 *   toutes les colonnes présentes      « Schéma conforme »
 *   certaines colonnes absentes        « Schéma incomplet » + liste exacte
 *                                      (ou n/N quand le contrôle ne fait que
 *                                      compter : il ne dit pas lesquelles)
 *   aucune colonne attendue trouvée    « Aucun élément attendu trouvé », sans
 *                                      présumer la cause
 *   vérification en échec              « Vérification impossible » + cause
 *   résultat indéterminé               « État du schéma indéterminé »
 */
export interface SchemaProbeOutcome {
  /** Préfixe du journal, ex. `[agenda]`. */
  scope: string;
  /** Migration de référence, ex. `0223` (contexte seulement, jamais une conclusion). */
  migration: string;
  /** Colonnes (ou objets) attendus, pour le contexte. */
  expected: readonly string[];
  /** Nombre trouvé (contrôle par comptage) ; null / absent si inconnu. */
  found?: number | null;
  /** Éléments absents, quand le contrôle les connaît exactement ; null / absent si inconnu. */
  missing?: readonly string[] | null;
  /** Erreur de la requête de contrôle. */
  error?: unknown;
  /** Effet sur l'application (phrase terminée par un point). */
  consequence: string;
}

/** État constaté par un contrôle de schéma (voir le tableau ci-dessus). */
type SchemaProbeState = 'conforme' | 'incomplet' | 'aucun_element' | 'verification_impossible' | 'indetermine';

const errText = (e: unknown) => String((e as { message?: unknown })?.message ?? e ?? 'erreur inconnue').slice(0, 200);
const hasError = (p: Pick<SchemaProbeOutcome, 'error'>) => p.error !== undefined && p.error !== null;
const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/** Classe le résultat d'un contrôle sans rien présumer. Pur. */
export function schemaProbeState(p: Pick<SchemaProbeOutcome, 'expected' | 'found' | 'missing' | 'error'>): SchemaProbeState {
  if (hasError(p)) return 'verification_impossible';
  const total = p.expected.length;
  if (Array.isArray(p.missing)) {
    if (p.missing.length === 0) return 'conforme';
    return p.missing.length >= total ? 'aucun_element' : 'incomplet';
  }
  if (isCount(p.found)) {
    if (p.found >= total) return 'conforme';
    return p.found === 0 ? 'aucun_element' : 'incomplet';
  }
  return 'indetermine';
}

/**
 * Éléments absents d'après des drapeaux de présence (un par élément attendu,
 * même ordre) ; `null` si le résultat n'est pas exploitable (ligne absente,
 * drapeau non booléen) — jamais « tout absent » par défaut. Pur.
 */
export function missingFromPresenceFlags(expected: readonly string[], flags: readonly unknown[] | null | undefined): string[] | null {
  if (!flags || flags.length !== expected.length || flags.some((f) => typeof f !== 'boolean')) return null;
  return expected.filter((_, i) => flags[i] === false);
}

export function schemaNotReadyMessage(p: SchemaProbeOutcome): string {
  const ref = `(migration de référence ${p.migration})`;
  const fin = `${p.consequence} Voir /api/health.`;
  switch (schemaProbeState(p)) {
    case 'verification_impossible':
      return `${p.scope} ⚠️ Vérification du schéma (migration ${p.migration}) impossible : ${errText(p.error)}. `
        + `État du schéma non constaté. Par prudence : ${fin}`;
    case 'conforme':
      return `${p.scope} Schéma conforme ${ref} : ${p.expected.length}/${p.expected.length} élément${p.expected.length > 1 ? 's' : ''} attendu${p.expected.length > 1 ? 's' : ''} présent${p.expected.length > 1 ? 's' : ''}.`;
    case 'aucun_element':
      return `${p.scope} ⚠️ Aucun élément attendu trouvé ${ref} parmi ${p.expected.join(', ')}. `
        + `Cause non déterminée par ce contrôle. ${fin}`;
    case 'incomplet': {
      if (Array.isArray(p.missing)) {
        const n = p.missing.length;
        return `${p.scope} ⚠️ Schéma incomplet ${ref} : ${p.missing.join(', ')} absent${n > 1 ? 's' : ''} `
          + `(${p.expected.length - n}/${p.expected.length} présent${p.expected.length - n > 1 ? 's' : ''}). ${fin}`;
      }
      return `${p.scope} ⚠️ Schéma incomplet ${ref} : ${p.found}/${p.expected.length} des éléments attendus présents parmi ${p.expected.join(', ')} `
        + `(contrôle par comptage : éléments absents non identifiés). ${fin}`;
    }
    default:
      return `${p.scope} ⚠️ État du schéma indéterminé ${ref} : le contrôle n'a pas fourni de résultat exploitable pour ${p.expected.join(', ')}. `
        + `Par prudence : ${fin}`;
  }
}

/**
 * Nombre lu d'un contrôle par comptage (`SELECT COUNT(*) AS n`) ; `null` si
 * le résultat n'est pas exploitable (ligne absente, valeur non entière) —
 * jamais 0 par défaut, qui ferait conclure « aucun élément trouvé ». Pur.
 */
export function probeCount(rows: ReadonlyArray<{ n?: unknown }> | null | undefined): number | null {
  const v = rows?.[0]?.n;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return isCount(n) ? n : null;
}
