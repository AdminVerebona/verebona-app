/**
 * Lot 91D — contrat `t1-value-decisions-v1` (demande IA historique
 * `82B-t1-omissions-extract`) : T1 qualifie les valeurs significatives des
 * unités sources (montants, dates, identifiants) qu'il lit.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ACTIVATION PRUDENTE
 *
 * Le schéma de sortie T1 (v6) ACCEPTE toujours `valueDecisions[]` (champ
 * facultatif, additif). Mais le code ne l'EXPLOITE que si la version
 * EFFECTIVE du prompt maître T1 (version BO active, sinon fichier du dépôt)
 * porte le marqueur `t1-value-decisions-v1` — texte collé par le PO
 * (docs/exploitation/prompts-a-appliquer-par-le-po.md). Sans lui :
 *   · aucune décision n'est persistée (aucune décision simulée) ;
 *   · COH-DOC-EXTRACT-CHAIN garde exactement ses constats d'avant
 *     (`pendingContract: 82B-t1-omissions-extract`), aucun réexamen ;
 *   · rien n'est bloqué (analyse, faits, Opérations, TCO inchangés).
 * Coupure d'urgence : `T1_VALUE_DECISIONS_ENABLED=0`.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Marqueur exact recherché dans le texte du prompt maître T1. */
export const T1_VALUE_DECISIONS_CONTRACT = 't1-value-decisions-v1';
/** Demande IA d'origine (constats en attente du contrat). */
export const T1_OMISSIONS_PENDING_CONTRACT = '82B-t1-omissions-extract';
/** Opération T1 (registre IA) dont le prompt porte le contrat. */
const T1_ANALYZE_OPERATION = 't1_analyze_document';

/** Le texte d'un prompt porte-t-il le contrat ? (pure, simple recherche du marqueur) */
export function promptCarriesValueDecisions(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.includes(T1_VALUE_DECISIONS_CONTRACT);
}

export interface ValueDecisionsCapability {
  /** Contrat porté par la version effective (et non coupé). */
  carried: boolean;
  /** Version du prompt maître T1 effective (null : illisible). */
  version: string | null;
  reason: 'CARRIED' | 'MARKER_MISSING' | 'DISABLED' | 'UNREADABLE';
}

/** Coupure d'urgence : `T1_VALUE_DECISIONS_ENABLED=0`. Pure. */
export const valueDecisionsEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  (env.T1_VALUE_DECISIONS_ENABLED ?? '1').trim() !== '0';

let cache: { at: number; value: ValueDecisionsCapability } | null = null;
const CACHE_MS = 60_000;

/** Réservé aux tests : vide le cache de disponibilité. */
export function __resetValueDecisionsCapabilityCacheForTests(): void { cache = null; }

/**
 * Le prompt T1 effectif porte-t-il le contrat ? Même résolution que la
 * passerelle (version BO active, texte de la version de configuration,
 * sinon fichier du dépôt) ; lecture seule ; cache de 60 s ; ne lève pas.
 */
export async function valueDecisionsCapability(): Promise<ValueDecisionsCapability> {
  if (!valueDecisionsEnabled()) return { carried: false, version: null, reason: 'DISABLED' };
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  let value: ValueDecisionsCapability;
  try {
    const [{ resolveOperationConfig }, loader, { getOperation }] = await Promise.all([
      import('@/services/ai/config/config-resolver'),
      import('@/services/ai/prompts/prompt-loader'),
      import('@/services/ai/registry/operations'),
    ]);
    const op = getOperation(T1_ANALYZE_OPERATION);
    const cfg = await resolveOperationConfig(T1_ANALYZE_OPERATION);
    const configured = cfg.promptArchitecture === 'master' && cfg.masterPromptText?.trim() ? cfg.masterPromptText : null;
    const text = configured ?? await loader.loadMasterTemplate(op.masterPromptCode!, op.useCaseCode);
    const version = loader.masterPromptVersionOf({
      masterPromptCode: op.masterPromptCode!, configuredText: configured, configVersionId: cfg.configVersionId,
      promptVersionId: configured ? cfg.masterPromptVersionId ?? null : null,
    });
    const carried = promptCarriesValueDecisions(text);
    value = { carried, version, reason: carried ? 'CARRIED' : 'MARKER_MISSING' };
  } catch (e) {
    console.error('[t1-value-decisions] version du prompt T1 illisible :', (e as Error).message);
    value = { carried: false, version: null, reason: 'UNREADABLE' };
  }
  cache = { at: Date.now(), value };
  return value;
}
