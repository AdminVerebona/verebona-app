/**
 * Empreinte d'un CONTEXTE de décision T3 assistée par l'IA — lot 99A (ticket
 * P1 « T3 — Supprimer les appels IA redondants », point A). Pure, testée.
 *
 * Deux passages dont l'empreinte est égale soumettraient au modèle EXACTEMENT
 * la même question, avec la même configuration : la décision mémorisée est
 * réutilisée, sans appel. L'empreinte couvre :
 *
 *   scope    compte, objet, champ (clé canonique) et version de cette mémoire ;
 *   evidence preuves disponibles, telles que le modèle les reçoit (identifiant,
 *            valeur, autorité calculée, type et date de document, origine,
 *            confiance, extrait / observation) : une preuve nouvelle, retirée
 *            ou modifiée change l'empreinte ;
 *   value    valeur en place et son origine (une saisie de l'utilisateur
 *            change l'empreinte) ;
 *   user     dernière résolution par l'utilisateur d'une carte du champ ;
 *   rules    règles métier : version de la matrice d'autorité, marge
 *            d'équivalence, demande du moteur déterministe (motif, valeur
 *            proposée, preuves retenues), version du contrat de sortie ;
 *   ai       configuration IA EFFECTIVE (prompt maître / version BO, mode et
 *            contrats d'exécution, version de configuration, modèles,
 *            raisonnement, plafond de sortie).
 *
 * Chaque composante est hachée séparément (`parts`) : à la réévaluation, la
 * composante qui a changé donne le MOTIF tracé. Aucune valeur en clair ni
 * extrait n'est conservé dans les composantes.
 */
import { createHash } from 'crypto';

/** Version de la mémoire : à incrémenter si la sémantique de l'empreinte change (toutes les entrées sont alors réévaluées). */
export const DECISION_MEMORY_VERSION = 't3dm-v1';

/** Version du contrat de sortie `t3_value_conflict` attendu par le code (traduction, protections). */
export const T3_VALUE_CONFLICT_CONTRACT = 't3-value-conflict-v1';

export interface FingerprintInput {
  accountId: number;
  objectType: 'ASSET' | 'EQUIPMENT' | 'ROOM';
  objectId: number;
  /** Clé canonique du champ. */
  fieldKey: string;
  /** Variables exactes transmises au modèle (`valueConflictVariables`). */
  variables: { EVIDENCES?: unknown; CURRENT_STATE?: unknown; FIELD?: unknown };
  currentValue: unknown;
  currentOrigin: string;
  /** Demande du moteur déterministe (décision `request_ai_review`). */
  request: { reasonCode: string; proposedValue: unknown; evidenceIds: number[]; confidence: string };
  rules: { authorityMatrixVersion: string; equivalenceMargin: number };
  /** Marqueur de la dernière résolution utilisateur d'une carte du champ (null : aucune). */
  userResolution: string | null;
  /** Signature de la configuration IA effective (`AiGateway.effectiveConfigSignature`). */
  aiConfigSignature: string;
}

export const FINGERPRINT_PARTS = ['scope', 'evidence', 'value', 'user', 'rules', 'ai'] as const;
export type FingerprintPart = (typeof FINGERPRINT_PARTS)[number];
export type FingerprintParts = Record<FingerprintPart, string>;

/** Motif tracé de la réévaluation, par composante modifiée. */
export const REEVALUATION_REASONS: Record<FingerprintPart, string> = {
  scope: 'SCOPE_CHANGED',
  evidence: 'EVIDENCE_CHANGED',
  value: 'VALUE_CHANGED',
  user: 'USER_RESOLUTION',
  rules: 'RULES_CHANGED',
  ai: 'AI_CONFIG_CHANGED',
};

/** Libellés français simples des motifs (BO, rapports). */
export const REEVALUATION_LABELS: Record<string, string> = {
  SCOPE_CHANGED: 'objet ou champ différent',
  EVIDENCE_CHANGED: 'preuve nouvelle, retirée ou modifiée',
  VALUE_CHANGED: 'valeur en place modifiée',
  USER_RESOLUTION: 'résolution par l’utilisateur',
  RULES_CHANGED: 'règle métier modifiée',
  AI_CONFIG_CHANGED: 'configuration IA modifiée (prompt, contrat, modèle)',
  FORCED: 'relance forcée',
  RETRY_AFTER_FAILURE: 'nouvelle tentative après un échec IA',
  FIRST_EVALUATION: 'première évaluation',
};

/** JSON canonique : clés triées, profondeur quelconque. */
export function canonicalJson(v: unknown): string {
  const canon = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(canon);
    if (x instanceof Date) return x.toISOString();
    if (x && typeof x === 'object') {
      return Object.fromEntries(Object.entries(x as Record<string, unknown>)
        .filter(([, val]) => val !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, val]) => [k, canon(val)]));
    }
    return x === undefined ? null : x;
  };
  return JSON.stringify(canon(v));
}

const h = (v: unknown): string => createHash('sha256').update(canonicalJson(v)).digest('hex').slice(0, 32);

/** Empreinte et composantes (pure). */
export function decisionFingerprint(p: FingerprintInput): { fingerprint: string; parts: FingerprintParts } {
  const parts: FingerprintParts = {
    scope: h({ v: DECISION_MEMORY_VERSION, a: p.accountId, t: p.objectType, o: p.objectId, f: p.fieldKey, rf: p.variables.FIELD ?? null }),
    evidence: h(p.variables.EVIDENCES ?? []),
    value: h({ value: p.currentValue ?? null, origin: p.currentOrigin }),
    user: p.userResolution ?? '',
    rules: h({
      ...p.rules, contract: T3_VALUE_CONFLICT_CONTRACT,
      request: { ...p.request, evidenceIds: [...p.request.evidenceIds].sort((a, b) => a - b) },
    }),
    ai: p.aiConfigSignature,
  };
  const fingerprint = createHash('sha256').update(canonicalJson(parts)).digest('hex');
  return { fingerprint, parts };
}

/** Motif(s) de réévaluation : composantes différentes (pure). Aucune entrée précédente → FIRST_EVALUATION. */
export function reevaluationReasons(previous: Partial<FingerprintParts> | null, next: FingerprintParts): string[] {
  if (!previous) return ['FIRST_EVALUATION'];
  const motifs = FINGERPRINT_PARTS.filter((k) => (previous[k] ?? '') !== next[k]).map((k) => REEVALUATION_REASONS[k]);
  return motifs.length ? motifs : ['RETRY_AFTER_FAILURE'];
}
