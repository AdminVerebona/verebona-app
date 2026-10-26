/**
 * Niveau M3 de la consolidation T3 des Opérations — rapprochement par l'IA
 * (lot 42, CDC Opérations V1 C6.1, C6.2, C7 ; NFR-OP-005 ; CDC 15 §25).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * QUAND LE MODÈLE EST-IL APPELÉ ?
 *
 * UNIQUEMENT pour un candidat T1 actif en attente « M3_REQUIRED » : M0 à M2
 * n'ont rien tranché, aucune contradiction, et des Opérations restent
 * plausibles. Le modèle reçoit au plus `OPERATION_MATCH_MAX_CANDIDATES` (5)
 * Opérations : au-delà, examen PROGRESSIF par lots classés (lot 53, retour PO
 * D7, `m3-progress.ts`) — le lot courant (`t3_detail.m3Batch`) d'abord, les
 * suivants aux cycles suivants ; jamais d'abandon (l'ancien statut
 * TOO_MANY_CANDIDATES n'est plus produit, les traces antérieures sont
 * reprises). Les Opérations rejetées par l'utilisateur (REJECTED) n'en font
 * jamais partie (C6.3).
 *
 * Une fois par EMPREINTE de contexte (`m3-context.ts`) : la consolidation
 * enregistre l'empreinte courante (`t3_detail.m3Fingerprint`), la phase
 * enregistre son évaluation (`t3_detail.m3`). Contexte inchangé = aucun
 * rappel (le passage horaire ne rappelle jamais le modèle sans changement).
 *
 * COÛT BORNÉ
 *   · `T3_OPERATION_MATCH_MAX_CALLS_PER_PASS` (défaut 5) appels par passage
 *     et par compte ;
 *   · `T3_OPERATION_MATCH_MAX_CALLS_PER_DAY` (défaut 30) appels par compte
 *     sur 24 h glissantes (lu dans `ai_usage_event`, traces de la passerelle) ;
 *   · plafond mensuel de coût du compte (passerelle, lot 22) ;
 *   au-delà : DEFERRED, repris au passage suivant (plafond de passage) ou
 *   le lendemain (plafond journalier, plafond mensuel atteint). Ces plafonds
 *   d'APPELS sont distincts du plafond des cartes « À traiter » réexaminées
 *   (D20, `rearbitration-budget.ts`). Lot 53 (D7) : les candidats dus sont
 *   servis du plus anciennement tenté au plus récent (aucune famine), chaque
 *   report porte son motif et sa date de reprise (BO › Opérations › En
 *   attente T3, colonne « Rapprochement IA »).
 *
 * GOUVERNANCE DU PROMPT
 * La branche « BRANCHE TASK = OPERATION_MATCH » doit figurer dans la version
 * EFFECTIVE du prompt maître T3 (version BO active, sinon fichier du dépôt).
 * Absente (version BO antérieure au lot 42) : aucun appel, statut
 * PROMPT_UNAVAILABLE avec la version tracée — les cas restent en attente,
 * sans erreur, et sont repris dès qu'une autre version est activée
 * (procédure BO : « Repartir du texte livré avec l’application » puis
 * « Activer »).
 *
 * Traces : chaque appel passe par la passerelle (BO › Exécutions IA,
 * `operation_code = t3_operation_match`), dans le contexte du travail de file
 * T3 ; aucune écriture métier ici — le verdict est appliqué par la
 * reconsolidation du document (`applyM3Verdict`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { envNumber } from '@/lib/env-number';
import {
  OPERATION_MATCH_MAX_CANDIDATES, callOperationMatchModel, translateOperationMatch,
  type OperationMatchCall,
} from '@/services/ai/reconciliation/master/operation-match';
import type { T3OperationMatchOutput } from '@/services/ai/reconciliation/master/t3-contract';
import type { StoredM3 } from './m3-context';
import { semanticReevaluationAt } from './retro';

const OPERATION_MATCH_OPERATION = 't3_operation_match';
const OPERATION_MATCH_TASK = 'OPERATION_MATCH';

/**
 * Appels M3 par passage et par compte (`T3_OPERATION_MATCH_MAX_CALLS_PER_PASS`,
 * 0 à 50 ; défaut 5 : un passage T3 reste court dans la file, chaque appel
 * pouvant parcourir la chaîne de modèles).
 */
export function operationMatchCallsPerPass(): number {
  return Math.min(50, Math.floor(envNumber('T3_OPERATION_MATCH_MAX_CALLS_PER_PASS', 5, { min: 0 })));
}
/** Appels M3 par compte sur 24 h glissantes (`T3_OPERATION_MATCH_MAX_CALLS_PER_DAY`, 0 à 1000 ; défaut 30). */
export function operationMatchCallsPerDay(): number {
  return Math.min(1000, Math.floor(envNumber('T3_OPERATION_MATCH_MAX_CALLS_PER_DAY', 30, { min: 0 })));
}

/** Candidats examinés par passage (borne de lecture). */
const OPERATION_MATCH_SCAN_LIMIT = 50;
const HEURE = 3_600_000;

/**
 * Lot 56A : candidats que la phase M3 peut (ré)évaluer — attente M3
 * (`M3_REQUIRED`) et question M3 encore ouverte dans « À traiter »
 * (`ARBITRATION_REQUIRED` / `M3_AMBIGUOUS` : verdict sémantique incertain).
 * Une question fondée sur des références exactes (CERTAIN) n'en fait pas
 * partie ; une question répondue par l'utilisateur non plus (décision M0).
 */
const M3_SUBJECT_SQL = `((c.t3_outcome = 'HOLD_UNRESOLVED' AND c.t3_reason = 'M3_REQUIRED')
    OR (c.t3_outcome = 'ARBITRATION_REQUIRED' AND c.t3_reason = 'M3_AMBIGUOUS'))`;

/**
 * Prédicat SQL (alias `c`) des candidats dont le niveau M3 reste à évaluer :
 * jamais évalué, contexte changé, report échu, prompt indisponible alors que
 * la version effective a changé (`$n` = version effective, ou NULL : clause
 * ignorée).
 */
export function M3_PENDING_SQL(promptVersionParam: string): string {
  return `c.status = 'ACTIVE' AND ${M3_SUBJECT_SQL} AND NOT c.t3_pending
    AND c.t3_detail ? 'm3Fingerprint'
    AND (c.t3_detail->'m3' IS NULL
         -- Lot 56A : question M3 ouverte, verdict obtenu avec une AUTRE version du prompt — réexaminée une fois.
         OR (c.t3_outcome = 'ARBITRATION_REQUIRED' AND c.t3_detail->'m3'->>'status' = 'DONE' AND ${promptVersionParam}::text IS NOT NULL
             AND c.t3_detail->'m3'->>'promptVersion' IS DISTINCT FROM ${promptVersionParam}::text)
         OR c.t3_detail->'m3'->>'fingerprint' IS DISTINCT FROM c.t3_detail->>'m3Fingerprint'
         OR (c.t3_detail->'m3'->>'status' IN ('DEFERRED', 'ERROR')
             AND COALESCE((c.t3_detail->'m3'->>'retryAfter')::timestamptz, now()) <= now())
         OR c.t3_detail->'m3'->>'status' = 'TOO_MANY_CANDIDATES'
         OR (c.t3_detail->'m3'->>'status' = 'PROMPT_UNAVAILABLE' AND ${promptVersionParam}::text IS NOT NULL
             AND c.t3_detail->'m3'->>'promptVersion' IS DISTINCT FROM ${promptVersionParam}::text)
         -- Lot 87B (CODE-06) : réévaluation sémantique T3 ouverte — verdict antérieur à la demande écarté, nouvel appel.
         OR (c.t3_detail->'semanticReevaluation' IS NOT NULL AND NOT (c.t3_detail->'semanticReevaluation' ? 'doneAt')
             AND COALESCE(c.t3_detail->'m3'->>'at', '') < COALESCE(c.t3_detail->'semanticReevaluation'->>'at', '')
             AND COALESCE(c.t3_detail->'m3'->>'status', '') NOT IN ('DEFERRED', 'ERROR')))`;
}

interface OperationMatchPromptStatus {
  available: boolean;
  version: string | null;
}

/**
 * La version EFFECTIVE du prompt maître T3 porte-t-elle la branche
 * OPERATION_MATCH ? Même résolution que la passerelle (version BO active,
 * texte de la version de configuration, sinon fichier du dépôt). Ne lève pas.
 */
export async function operationMatchPromptStatus(): Promise<OperationMatchPromptStatus> {
  try {
    const [{ resolveOperationConfig }, loader, { getOperation }] = await Promise.all([
      import('@/services/ai/config/config-resolver'),
      import('@/services/ai/prompts/prompt-loader'),
      import('@/services/ai/registry/operations'),
    ]);
    const op = getOperation(OPERATION_MATCH_OPERATION);
    const cfg = await resolveOperationConfig(OPERATION_MATCH_OPERATION);
    const configured = cfg.promptArchitecture === 'master' && cfg.masterPromptText?.trim() ? cfg.masterPromptText : null;
    const text = configured ?? await loader.loadMasterTemplate(op.masterPromptCode!, op.useCaseCode);
    const version = loader.masterPromptVersionOf({
      masterPromptCode: op.masterPromptCode!, configuredText: configured, configVersionId: cfg.configVersionId,
      promptVersionId: configured ? cfg.masterPromptVersionId ?? null : null,
    });
    return { available: loader.inspectMasterTemplate(text).branches.includes(OPERATION_MATCH_TASK), version };
  } catch (e) {
    console.error('[t3-operations] version du prompt T3 illisible (M3) :', (e as Error).message);
    return { available: false, version: null };
  }
}

export interface OperationMatchDeps {
  /** Appel du modèle (défaut : passerelle réelle). */
  callModel?: (p: OperationMatchCall) => Promise<T3OperationMatchOutput>;
  /** État du prompt (défaut : version effective). */
  promptStatus?: () => Promise<OperationMatchPromptStatus>;
  /** Appels M3 du compte sur 24 h (défaut : `ai_usage_event`). */
  callsLastDay?: (accountId: number) => Promise<number>;
  maxCallsPerPass?: number;
  maxCallsPerDay?: number;
  now?: () => Date;
}

export interface OperationMatchPhaseResult {
  examined: number;
  calls: number;
  deferred: number;
  unavailable: number;
  /** Toujours 0 depuis le lot 53 (D7 : examen progressif) — conservé pour la forme des rapports. */
  tooMany: number;
  errors: number;
  /** Lot 53 (D7) : contexte disparu entre deux passages — candidat remis en consolidation. */
  requeued?: number;
  /** Lot 53 (D7) : reports par motif (PASS_CAP, DAILY_CAP, COST_CAP_REACHED, AI_BLOCKED). */
  deferredReasons?: Record<string, number>;
  /** Lot 53 (D7) : candidats dus non servis ce passage (au-delà de la borne de lecture). */
  notServed?: number;
  /** Documents dont un candidat a reçu un verdict : à reconsolider. */
  files: number[];
}

async function defaultCallsLastDay(accountId: number): Promise<number> {
  const { pgClient } = await import('@/db');
  const [r] = (await pgClient.unsafe(
    `SELECT count(*)::int AS n FROM ai_usage_event
      WHERE account_id = $1 AND operation_code = $2 AND created_at > now() - interval '24 hours'`,
    [accountId, OPERATION_MATCH_OPERATION] as never[],
  )) as unknown as Array<{ n: number }>;
  return Number(r?.n ?? 0);
}

async function store(candidateId: number, m3: StoredM3): Promise<void> {
  const { pgClient } = await import('@/db');
  await pgClient.unsafe(
    `UPDATE document_operation_candidates SET t3_detail = jsonb_set(COALESCE(t3_detail, '{}'::jsonb), '{m3}', $2::jsonb) WHERE id = $1`,
    [candidateId, JSON.stringify(m3)] as never[],
  );
}

/** Une évaluation est-elle due pour ce candidat ? (pure, même règle que `M3_PENDING_SQL`) */
export function m3Due(
  detail: Record<string, unknown> | null, now: Date, promptVersion: string | null,
  /** Lot 56A : le candidat porte une question M3 ouverte (ARBITRATION_REQUIRED / M3_AMBIGUOUS). */
  openQuestion = false,
): boolean {
  const fp = detail?.m3Fingerprint;
  if (typeof fp !== 'string') return false;
  const m3 = (detail?.m3 ?? null) as StoredM3 | null;
  if (!m3) return true;
  if (m3.fingerprint !== fp) return true;
  // Lot 87B (CODE-06) : réévaluation sémantique T3 ouverte — un verdict antérieur à la demande ne compte plus.
  const demande = semanticReevaluationAt(detail);
  if (demande && m3.status !== 'DEFERRED' && m3.status !== 'ERROR' && (!m3.at || m3.at < demande)) return true;
  // Lot 56A : question ouverte évaluée par une autre version du prompt — réexamen (une fois par version).
  if (openQuestion && m3.status === 'DONE') return promptVersion !== null && m3.promptVersion !== promptVersion;
  if (m3.status === 'DEFERRED' || m3.status === 'ERROR') return !m3.retryAfter || Date.parse(m3.retryAfter) <= now.getTime();
  if (m3.status === 'PROMPT_UNAVAILABLE') return promptVersion !== null && m3.promptVersion !== promptVersion;
  // Lot 53 (D7) : trace « trop de candidats » du lot 42 — reprise par l'examen progressif.
  if (m3.status === 'TOO_MANY_CANDIDATES') return true;
  return false;
}

/**
 * Phase M3 d'un passage T3 de compte (hors transaction métier). Rend les
 * documents à reconsolider (verdict obtenu). Ne lève pas, sauf interruption
 * d'exécution (arrêt d'urgence, annulation du travail).
 */
export async function runOperationMatchPhase(
  accountId: number,
  opts: OperationMatchDeps & { beforeCall?: (what: string) => Promise<void> } = {},
): Promise<OperationMatchPhaseResult> {
  const res: OperationMatchPhaseResult = { examined: 0, calls: 0, deferred: 0, unavailable: 0, tooMany: 0, errors: 0, files: [] };
  const now = opts.now ?? (() => new Date());
  const { pgClient } = await import('@/db');
  const [existe] = (await pgClient.unsafe(
    `SELECT 1 FROM document_operation_candidates c
      WHERE c.account_id = $1 AND c.status = 'ACTIVE' AND ${M3_SUBJECT_SQL} LIMIT 1`,
    [accountId] as never[],
  )) as unknown as unknown[];
  if (!existe) return res;

  const prompt = await (opts.promptStatus ?? operationMatchPromptStatus)();
  // Lot 53 (D7) : le plus anciennement tenté d'abord (jamais tenté en tête) —
  // un candidat reporté par un plafond ne peut pas être dépassé indéfiniment.
  const lignes = (await pgClient.unsafe(
    `SELECT c.id, c.file_id, c.t3_detail, c.t3_outcome = 'ARBITRATION_REQUIRED' AS question, count(*) OVER () AS total FROM document_operation_candidates c
      WHERE c.account_id = $1 AND ${M3_PENDING_SQL('$3')}
      ORDER BY (c.t3_detail->'m3'->>'at') NULLS FIRST, c.id LIMIT $2`,
    [accountId, OPERATION_MATCH_SCAN_LIMIT, prompt.version] as never[],
  )) as unknown as Array<{ id: number; file_id: number; t3_detail: Record<string, unknown> | null; question: boolean; total: number | string }>;
  const dus = lignes.filter((l) => m3Due(l.t3_detail, now(), prompt.version, l.question === true));
  res.examined = dus.length;
  res.notServed = Math.max(0, Number(lignes[0]?.total ?? 0) - lignes.length);
  res.deferredReasons = {};
  const reporte = (motif: string) => { res.deferredReasons![motif] = (res.deferredReasons![motif] ?? 0) + 1; };
  if (!dus.length) return res;

  const parPassage = opts.maxCallsPerPass ?? operationMatchCallsPerPass();
  const parJour = opts.maxCallsPerDay ?? operationMatchCallsPerDay();
  const dejaJour = prompt.available ? await (opts.callsLastDay ?? defaultCallsLastDay)(accountId) : 0;
  const callModel = opts.callModel ?? callOperationMatchModel;
  const fichiers = new Set<number>();

  for (const l of dus) {
    const fp = String(l.t3_detail?.m3Fingerprint);
    const at = now().toISOString();
    if (!prompt.available) {
      // Version BO antérieure au lot 42 : aucun appel, aucune erreur — le cas reste en attente.
      await store(l.id, { status: 'PROMPT_UNAVAILABLE', fingerprint: fp, promptVersion: prompt.version, at });
      res.unavailable++;
      continue;
    }
    if (res.calls >= parPassage || dejaJour + res.calls >= parJour) {
      const journalier = dejaJour + res.calls >= parJour;
      // Lot 53 (D7) : un report n'est pas une tentative — `at` garde la dernière
      // tentative réelle (vide si aucune) pour que le reporté passe en tête au
      // cycle suivant ; `deferredAt` date le report.
      const derniere = (l.t3_detail?.m3 as StoredM3 | undefined)?.at ?? '';
      await store(l.id, {
        status: 'DEFERRED', fingerprint: fp, promptVersion: prompt.version, at: derniere, deferredAt: at,
        retryAfter: new Date(now().getTime() + (journalier ? 24 * HEURE : 0)).toISOString(),
        detail: journalier ? 'DAILY_CAP' : 'PASS_CAP',
        ...progressOf(l.t3_detail),
      });
      res.deferred++;
      reporte(journalier ? 'DAILY_CAP' : 'PASS_CAP');
      continue;
    }
    const ctx = await prepareContext(accountId, l.id);
    if (!ctx) continue;
    if (ctx.operationIds.length === 0 || ctx.plausible.length > OPERATION_MATCH_MAX_CANDIDATES) {
      // Lot 53 (D7) : contexte disparu ou trace antérieure au lot 53 — jamais
      // abandonné : le candidat est remis en consolidation, qui recalcule son
      // lot courant ; la trace dit pourquoi.
      await store(l.id, {
        status: 'DEFERRED', fingerprint: ctx.fingerprint, promptVersion: prompt.version, at, retryAfter: at,
        detail: 'CONTEXT_CHANGED', operationIds: ctx.operationIds,
      });
      await requeueCandidate(l.id);
      res.requeued = (res.requeued ?? 0) + 1;
      continue;
    }
    await opts.beforeCall?.('T3 Opérations — rapprochement sémantique (M3)');
    try {
      res.calls++;
      const out = await callModel({ accountId, fileId: ctx.fileId, variables: ctx.variables });
      const { verdict, warnings } = translateOperationMatch(out, new Set(ctx.operationIds));
      await store(l.id, {
        status: 'DONE', fingerprint: ctx.fingerprint, promptVersion: prompt.version, verdict, operationIds: ctx.operationIds, at,
        ...(warnings.length ? { warnings: warnings.map((w) => `${w.code}:${w.id}`) } : {}),
      });
      fichiers.add(Number(l.file_id));
    } catch (e) {
      const { isExecutionCancelled } = await import('@/services/ai/queue/execution-control');
      if (isExecutionCancelled(e)) throw e;
      const { isAiGatewayError } = await import('@/services/ai/gateway/errors');
      const code = isAiGatewayError(e) ? e.code : 'UNKNOWN';
      if (code === 'MASTER_PROMPT_INVALID') {
        await store(l.id, { status: 'PROMPT_UNAVAILABLE', fingerprint: ctx.fingerprint, promptVersion: prompt.version, at, detail: code });
        res.unavailable++;
        continue;
      }
      // Plafond de coût atteint, traitement arrêté, panne du fournisseur : repli
      // déterministe (le cas reste en attente), nouvel essai plus tard.
      const delai = code === 'COST_CAP_REACHED' ? 24 * HEURE : code === 'AI_BLOCKED' ? HEURE : 6 * HEURE;
      await store(l.id, {
        status: code === 'COST_CAP_REACHED' || code === 'AI_BLOCKED' ? 'DEFERRED' : 'ERROR', fingerprint: ctx.fingerprint,
        promptVersion: prompt.version, at, retryAfter: new Date(now().getTime() + delai).toISOString(), detail: String(code).slice(0, 80),
      });
      if (code === 'COST_CAP_REACHED' || code === 'AI_BLOCKED') { res.deferred++; reporte(String(code)); }
      else {
        res.errors++;
        console.warn(`[t3-operations] M3 indisponible pour le candidat ${l.id} (compte ${accountId}) : ${code} — attente.`);
      }
    }
  }
  res.files = [...fichiers].sort((a, b) => a - b);
  return res;
}

/** Progression de l'examen progressif recopiée dans la trace d'un report (diagnostic). */
function progressOf(detail: Record<string, unknown> | null): Pick<StoredM3, 'operationIds'> {
  const lot = detail?.m3Batch;
  return Array.isArray(lot) ? { operationIds: lot.map(Number).filter((n) => Number.isSafeInteger(n)) } : {};
}

/** Remet un candidat en consolidation T3 (recalcul du lot courant au passage suivant). */
async function requeueCandidate(candidateId: number): Promise<void> {
  const { pgClient } = await import('@/db');
  await pgClient.unsafe(`UPDATE document_operation_candidates SET t3_pending = true WHERE id = $1 AND status = 'ACTIVE'`, [candidateId] as never[]);
}

async function prepareContext(accountId: number, candidateId: number) {
  const { prepareOperationMatch } = await import('./consolidator');
  return prepareOperationMatch(accountId, candidateId);
}
