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

/**
 * Lot 115F (Trello #792, écart P1-02) — CONTRAT RÉELLEMENT UTILISÉ PAR L'APPEL.
 *
 * Règle remplacée : les décisions d'une passe de RÉPARATION n'étaient
 * persistées que si la version effective du prompt T1 était ÉGALE à celle
 * enregistrée sur l'extraction (`document_extractions.prompt_version`) —
 * c'est-à-dire à celle de l'analyse d'ORIGINE. Un prompt publié entre
 * l'analyse et la reprise faisait donc écarter (`CONTRACT_NOT_CARRIED`) des
 * décisions pourtant rendues par un appel qui portait le contrat. Seul compte
 * désormais le contrat de l'appel qui vient d'être fait ; la version
 * enregistrée avec les décisions est celle qui les a produites, et un
 * changement de version est signalé (traçabilité), jamais bloquant. Pure.
 */
export function repairDecisionContract(cap: Pick<ValueDecisionsCapability, 'carried' | 'version'>, extractionPromptVersion: string | null): {
  carried: boolean;
  /** Version à enregistrer avec les décisions : celle de l'appel, à défaut celle de l'extraction. */
  promptVersion: string | null;
  /** La version de l'appel diffère de celle de l'analyse d'origine. */
  versionChanged: boolean;
} {
  return {
    carried: cap.carried,
    promptVersion: cap.version ?? extractionPromptVersion,
    versionChanged: cap.version !== null && extractionPromptVersion !== null && cap.version !== extractionPromptVersion,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// CARTE #854 (R1, P1-02 de #835) — CONTRAT FIGÉ PAR APPEL
//
// Règle remplacée : les décisions d'une reprise différée étaient jugées, à la
// persistance, sur `valueDecisionsCapability()` — config ACTIVE relue (cache
// 60 s) APRÈS l'appel. Analyse sous A, appel sous B, activation de C pendant
// le traitement : ni A ni C ne prouvent B. Désormais chaque appel porte la
// preuve du prompt qu'il a RÉELLEMENT consommé (`res.promptContract`, figée
// par la passerelle avant l'envoi) ; ses décisions sont validées selon CE
// contrat, jamais selon le prompt actif relu ni celui de l'analyse initiale.
//   · preuve absente / texte illisible : `EVIDENCE_MISSING` — rien n'est
//     accepté, aucune version de repli n'est inventée ;
//   · marqueur absent : `MARKER_MISSING` ; famille connue mais version non
//     supportée (`t1-value-decisions-v2`…) : `UNSUPPORTED_VERSION` ;
//   · coupure d'urgence (`T1_VALUE_DECISIONS_ENABLED=0`) : persistance
//     SUSPENDUE et dite (`persistenceSuspended`), contrat inchangé.
// ══════════════════════════════════════════════════════════════════════════

/** Versions du contrat dont le validateur serveur sait juger les décisions. */
export const SUPPORTED_VALUE_DECISIONS_CONTRACTS: readonly string[] = [T1_VALUE_DECISIONS_CONTRACT];
const FAMILLE_CONTRAT = /^t1-value-decisions-v\d+$/;

/** Preuve du prompt consommé, telle que la rend la passerelle (`AiGatewayResponse.promptContract`). */
export interface CallPromptEvidence {
  promptVersion: string;
  textFingerprint: string | null;
  configVersionId?: number | null;
  promptVersionId?: number | null;
  markers: readonly string[] | null;
  source?: string;
}

export type CallContractState = 'CARRIED' | 'MARKER_MISSING' | 'UNSUPPORTED_VERSION' | 'EVIDENCE_MISSING';

/** Contrat des décisions d'UN appel (pur, immuable une fois calculé). */
export interface CallDecisionContract {
  state: CallContractState;
  /** Version du contrat portée et supportée (null sinon). */
  contractVersion: string | null;
  /** Versions de la famille portées par le texte (supportées ou non). */
  markersFound: string[];
  promptVersion: string | null;
  promptFingerprint: string | null;
  configVersionId: number | null;
  /** Coupure d'urgence active : contrat inchangé, persistance suspendue. */
  persistenceSuspended: boolean;
}

/** Contrat d'un appel d'après la preuve figée par la passerelle (pure). */
export function decisionContractOfCall(
  evidence: CallPromptEvidence | null | undefined, env: Record<string, string | undefined> = process.env,
): CallDecisionContract {
  const suspendu = !valueDecisionsEnabled(env);
  if (!evidence || !evidence.promptVersion || !evidence.textFingerprint || !Array.isArray(evidence.markers)) {
    return {
      state: 'EVIDENCE_MISSING', contractVersion: null, markersFound: [], promptVersion: evidence?.promptVersion ?? null,
      promptFingerprint: evidence?.textFingerprint ?? null, configVersionId: evidence?.configVersionId ?? null, persistenceSuspended: suspendu,
    };
  }
  const famille = evidence.markers.filter((m) => FAMILLE_CONTRAT.test(m));
  const supporte = famille.find((m) => SUPPORTED_VALUE_DECISIONS_CONTRACTS.includes(m)) ?? null;
  return {
    state: supporte ? 'CARRIED' : famille.length > 0 ? 'UNSUPPORTED_VERSION' : 'MARKER_MISSING',
    contractVersion: supporte, markersFound: famille, promptVersion: evidence.promptVersion, promptFingerprint: evidence.textFingerprint,
    configVersionId: evidence.configVersionId ?? null, persistenceSuspended: suspendu,
  };
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
