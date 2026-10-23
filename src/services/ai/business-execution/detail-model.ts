/**
 * Détail d'une exécution métier — lot 84D (CDC Pilotage IA V2 P3 : BO-03,
 * BO-10, LOG-08). PUR, sans import serveur : formes JSON et règles de
 * présentation partagées par la route et l'écran.
 *
 * Le détail présente le traitement, l'objet, l'état final, CE QUI MANQUE, les
 * causes (établies ou inconnues — jamais devinées), les tentatives et appels
 * (statut de capture de chaque échange : le contenu lui-même reste derrière
 * l'accès existant `AI_MODEL_OUTPUT_ADMIN_IDS`), les écritures (rapports
 * d'exécution) et la relance EXISTANTE applicable (aucun nouvel outil).
 */
import type { BusinessExecutionDto } from './dto';

export interface ExecutionCallView {
  id: number;
  createdAt: string;
  operationCode: string | null;
  model: string | null;
  modelRank: string | null;
  status: string;
  errorCode: string | null;
  callKind: string | null;
  durationMs: number | null;
  /** null : tarif inconnu (jamais zéro). */
  costMicros: number | null;
  traceId: string | null;
  /** Statut de la capture à la source (CAPTURED, PARTIAL, NOT_CAPTURED…) ; null : appel antérieur à la capture. */
  captureStatus: string | null;
  promptStatus: string | null;
  responseStatus: string | null;
  promptChars: number | null;
  responseChars: number | null;
}

export interface ExecutionJobView {
  id: number;
  treatment: string;
  status: string;
  attempts: number;
  origin: string | null;
  triggerCode: string | null;
  lastError: string | null;
  businessResult: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ExecutionReportView {
  id: number;
  status: string;
  createdAt: string;
  failedSteps: string[];
  /** Écritures constatées par résultat (`write_result` des lignes du rapport). */
  writes: Record<string, number>;
  entryCount: number | null;
}

export type RelaunchKind = 'queue-retry' | 't1-completeness-retry' | 't6-supervision';

/** Relance EXISTANTE applicable (BO-03, BO-10) : route et bouton déjà en service. */
export interface RelaunchOption {
  kind: RelaunchKind;
  label: string;
  /** Route POST existante ; absente : renvoi vers l'écran qui porte l'action. */
  endpoint: string | null;
  body: Record<string, unknown> | null;
  href: string | null;
  note: string;
}

export interface BusinessExecutionDetailDto {
  readAt: string;
  execution: BusinessExecutionDto;
  /** Ce qui manque, en clair (vide : rien ne manque, ou issue non finale). */
  missing: string[];
  /** Cause ÉTABLIE (null : aucune, ou non établie — `causeUnknown`). */
  cause: string | null;
  causeUnknown: boolean;
  calls: ExecutionCallView[];
  /** Plus de `DETAIL_CALLS_MAX` appels : la liste affichée est partielle (l'export est complet). */
  callsTruncated: boolean;
  jobs: ExecutionJobView[];
  reports: ExecutionReportView[];
  relaunch: RelaunchOption[];
  /** L'administrateur courant peut-il lire les échanges capturés (prompt, réponse) ? */
  canReadContents: boolean;
}

/** Appels affichés au détail (l'export unitaire les donne tous). */
export const DETAIL_CALLS_MAX = 500;

/** Code d'une cause (« T1_VERIFICATION_INCOMPLETE : … » → T1_VERIFICATION_INCOMPLETE). */
export function causeCode(cause: string | null): string | null {
  const m = /^([A-Z0-9_]+)\s*:/.exec(cause ?? '') ?? /^([A-Z0-9_]{4,})$/.exec(cause ?? '');
  return m ? m[1] : null;
}

const MISSING_BY_CODE: Array<[RegExp, string]> = [
  [/^T1_VERIFICATION_INCOMPLETE$/, 'Pages ou couverture du document non vérifiées : l’exhaustivité de l’analyse n’est pas démontrée.'],
  [/^T1_UNRESOLVED$/, 'Informations présentes dans le document restées non structurées, incertaines ou écartées.'],
  [/^T1_INCOMPLETE(_FINAL)?$/, 'Une partie du document n’a pas été analysée.'],
  [/^T[13]_PERSISTENCE_PARTIAL$/, 'Écritures incomplètes : une partie des résultats n’a pas été enregistrée.'],
  [/^T4_(INCOMPLETE|PERSIST_PARTIAL|SYNC_FAILED)$/, 'Décision manquante ou enregistrement / synchronisation de l’Agenda partiels.'],
  [/^T2_CLAIMS_DISCARDED$/, 'Affirmations de la réponse écartées par la validation des preuves.'],
  [/^T6_FORMULATE_(INVALID|ERROR)$/, 'Aucun message de la mascotte généré (texte de secours affiché à l’utilisateur).'],
  [/^T[1-6]_(FAILED|REPORT_FAILED)$|^T6_EVALUATE_/, 'Aucun résultat métier exploitable n’a été produit.'],
];

/** Ce qui manque (pur) : tiré de la cause établie et des étapes en échec, jamais deviné. */
export function missingOf(x: Pick<BusinessExecutionDto, 'outcome' | 'cause' | 'native'>): string[] {
  if (x.outcome !== 'FAILED' && x.outcome !== 'INCOMPLETE') return [];
  const out: string[] = [];
  const code = causeCode(x.cause);
  const hit = code ? MISSING_BY_CODE.find(([re]) => re.test(code)) : undefined;
  if (hit) out.push(hit[1]);
  const steps = (x.native.detail as { failedSteps?: unknown } | null | undefined)?.failedSteps;
  if (Array.isArray(steps) && steps.length) out.push(`Étapes en échec : ${steps.map(String).join(', ')}.`);
  if (!out.length) out.push(x.outcome === 'FAILED' ? 'Aucun résultat métier exploitable n’a été produit.' : 'Au moins une partie ou un contrôle obligatoire reste non vérifié.');
  return out;
}

/** Cause non établie ? (issue en anomalie ou non déterminable sans cause enregistrée). */
export function isCauseUnknown(x: Pick<BusinessExecutionDto, 'outcome' | 'cause'>): boolean {
  return (x.outcome === 'FAILED' || x.outcome === 'INCOMPLETE' || x.outcome === 'UNDETERMINED') && !x.cause;
}

/**
 * Relances EXISTANTES applicables (pur) — aucune nouvelle relance (BO-03) :
 *   · travail de file en échec définitif (dernier travail FAILED) : relance de
 *     la File IA (`/api/admin/ai/queue/jobs/:id/retry`, MOD-006) ;
 *   · document T1 en vérification incomplète : reprise de complétude T1
 *     (`/api/admin/ai/t1-completeness/retry`, lot 53 D19) ;
 *   · évaluation T6 en échec : reprise explicite de la Supervision (lot 78C).
 * Une demande de l'assistant (T2) ou une génération de la mascotte (T6
 * FORMULATE) ne se rejoue pas : aucune relance proposée.
 */
export function relaunchOptions(
  x: Pick<BusinessExecutionDto, 'id' | 'treatment' | 'mode' | 'outcome' | 'objectType' | 'objectId' | 'native' | 'accountId'>,
  jobs: readonly Pick<ExecutionJobView, 'id' | 'status'>[],
): RelaunchOption[] {
  const out: RelaunchOption[] = [];
  const last = jobs.length ? jobs[jobs.length - 1] : null;
  if (last && last.status === 'FAILED') {
    out.push({
      kind: 'queue-retry', label: `Relancer le travail ${last.id} (File IA)`, endpoint: `/api/admin/ai/queue/jobs/${last.id}/retry`,
      body: { businessExecutionId: x.id }, href: null,
      note: 'Relance existante de la File IA : le travail en échec définitif repart du modèle principal (aucun doublon : refusée si le travail est vivant).',
    });
  }
  if (x.treatment === 'T1' && x.native.result === 'VERIFICATION_INCOMPLETE' && x.objectType === 'document' && x.objectId && /^\d+$/.test(x.objectId)) {
    out.push({
      kind: 't1-completeness-retry', label: 'Reprendre la vérification du document', endpoint: '/api/admin/ai/t1-completeness/retry',
      body: { fileId: Number(x.objectId), businessExecutionId: x.id }, href: null,
      note: 'Reprise existante de complétude T1 : relecture du fichier, rattachée à cette exécution (même identité).',
    });
  }
  if (x.treatment === 'T6' && x.mode === 'EVALUATE' && x.outcome === 'FAILED') {
    out.push({
      kind: 't6-supervision', label: 'Reprendre les évaluations T6 du compte (Supervision)', endpoint: null, body: null,
      href: '/admin/supervision', note: 'Reprise explicite existante des évaluations T6 en échec d’un compte (lot 78C), depuis la Supervision.',
    });
  }
  return out;
}
