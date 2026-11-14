/**
 * Lot 113AC (Trello #725, §3 « Reprise ») — REQUALIFICATION T1 CIBLÉE des documents déjà analysés pour
 * le contrat `t1-business-periods-v2` (bloc 28 du guide du PO).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI. La reprise sans IA (COH-DOC-BUSINESS-PERIODS, COH-OPS-CONTRACT-DATES v3,
 * COH-OPS-PERIOD-RESOLUTION) n'exploite que ce que les extractions PERSISTÉES contiennent. Un document
 * analysé avant le bloc 28 n'a pas de qualification v2 (pertinence, effet contractuel, sens des bornes,
 * relation déclarée) : ses périodes restent sous les règles prudentes et ses divergences sont seulement
 * signalées (PERIOD_DIVERGENCE_UNQUALIFIED). Seule une nouvelle analyse T1 peut l'apporter.
 *
 * PÉRIMÈTRE. Documents du compte (non supprimés, non regroupés), analysés (`ANALYZED`, extraction
 * présente), SANS fait actif `period.relevance` — ce fait, rendu TOUJOURS par le bloc 28, prouve la
 * qualification v2 (`t1-v2.ts`). Un compte non éligible au traitement (lecture seule, suspendu, essai
 * échu — même contrôle que la file) est écarté du lot et compté à part.
 *
 * GARANTIES.
 *   · Jamais à la consultation : seule une action EXPLICITE du PO depuis BO › Exploitation lance la
 *     requalification (rattrapage « business-periods-v2-requalification », motif obligatoire, audit).
 *   · Inactive tant que le bloc 28 n'est pas actif : l'état du contrat dans le registre de conformité
 *     (`contractConformityState`) doit être « satisfait » ; sinon le bouton est désactivé (raison
 *     affichée) et le serveur refuse l'application — la simulation (estimation) reste possible.
 *   · Par lots : une application met en file AU PLUS `REQUALIFICATION_BATCH_SIZE` documents. Arrêt :
 *     ne pas relancer (et, au besoin, l'arrêt d'urgence de la file IA, existant) ; reprise : relancer —
 *     le lot suivant est choisi de la même façon.
 *   · Idempotente : un document déjà qualifié v2 sort du périmètre ; un document dont la demande est EN
 *     COURS (travail T1 de cette origine dans `ai_job_queue`, table jamais purgée) n'est jamais redemandé ;
 *     terminé sans qualification v2, il est repris de façon bornée (carte #766, E13 — voir plus bas).
 *   · Supervision existante : travaux T1 techniques non facturés (`processingVisibility: TECHNICAL`,
 *     `billable: false`) visibles dans BO › File d'attente IA ; plafonds, arrêt d'urgence et quotas de
 *     la file inchangés ; corrections de l'utilisateur protégées par `planRefresh` (113W).
 *   · Rapport avant / après : recensement par état avant et après la mise en file, estimation de coût.
 *
 * CARTE #766 (E13) — NOUVELLE TENTATIVE CONTRÔLÉE (règle remplacée : « jamais redemandé ») :
 *   un document déjà demandé dont le travail est TERMINÉ sans qualification v2 n'est plus abandonné. On
 *   distingue : travail en cours ; succès complet (qualifié v2) ; SORTIE INCOMPLÈTE (travail réussi, sans
 *   `period.relevance`) ; ERREUR TECHNIQUE (travail échoué ou annulé) ; ÉCHEC DÉFINITIF (plafond de
 *   `REQUALIFICATION_MAX_ATTEMPTS` demandes atteint). Les deux états intermédiaires sont REPRIS par les
 *   lots suivants — après les documents jamais demandés, dans la même taille de lot (coût borné), et
 *   seulement si le contrat est « satisfait » (même garde que la première demande). Au plafond : plus
 *   aucune demande, le document est listé « bloqué » dans le rapport BO. Aucune boucle : chaque demande
 *   est une action explicite du PO, comptée par document. Les corrections restent protégées (`planRefresh`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type postgres from 'postgres';
import { RELEVANCE_FACT_KEY, T1_BUSINESS_PERIODS_V2_CONTRACT } from './t1-v2';

type Sql = postgres.Sql;
type Row = Record<string, unknown>;

/** Origine des travaux T1 de la requalification (déclencheur tracé, clé d'idempotence). */
export const REQUALIFICATION_ORIGIN = 'business-periods-v2-requalification';
/** Documents mis en file par application (un lot). Paramètre centralisé. */
export const REQUALIFICATION_BATCH_SIZE = 100;
/** Fenêtre de l'estimation de coût (jours d'exécutions T1 observées). */
export const REQUALIFICATION_COST_WINDOW_DAYS = 30;
/** Carte #766 (E13) : demandes de requalification permises par document, première comprise (à valider par le PO). */
export const REQUALIFICATION_MAX_ATTEMPTS = 3;
/** Carte #766 (E13) : documents bloqués listés dans le rapport BO (au plus). */
export const REQUALIFICATION_BLOCKED_SAMPLE = 50;

export interface RequalificationAvailability {
  available: boolean;
  /** État du contrat `t1-business-periods-v2` dans le registre de conformité. */
  contractState: string;
  /** Explication affichée au BO (à valider par le PO). */
  reason: string;
}

/** Disponibilité (pure) : seul un contrat « satisfait » rend la requalification possible. */
export function availabilityFrom(state: string, cause: string | null): RequalificationAvailability {
  if (state === 'SATISFIED') {
    return { available: true, contractState: state, reason: `Le contrat ${T1_BUSINESS_PERIODS_V2_CONTRACT} est actif dans le prompt T1 (étape 28 du guide).` };
  }
  return {
    available: false, contractState: state,
    reason: `Inactif : le contrat ${T1_BUSINESS_PERIODS_V2_CONTRACT} est « ${STATE_LABELS[state] ?? state} » dans BO › Configuration IA › Conformité des prompts`
      + `${cause ? ` (${cause})` : ''}. Activez d’abord le bloc 28 du guide des prompts : une requalification sans lui ne produirait aucune qualification v2.`,
  };
}

const STATE_LABELS: Record<string, string> = {
  ABSENT: 'absent', OBSOLETE: 'obsolète', INCOMPLETE: 'incomplet', INCOMPATIBLE: 'incompatible', UNKNOWN: 'illisible',
};

/** État du contrat sur le prompt T1 effectif (lecture seule ; ne lève pas). */
export async function requalificationAvailability(): Promise<RequalificationAvailability> {
  const { contractConformityState } = await import('@/services/ai/prompt-conformity/service');
  const s = await contractConformityState(T1_BUSINESS_PERIODS_V2_CONTRACT);
  return availabilityFrom(s.state, s.cause);
}

export interface RequalificationCensus {
  /** À requalifier : analysés, sans sortie v2, jamais demandés. */
  toRequalify: number;
  /** Demandés, travail T1 en attente ou en cours. */
  requestedPending: number;
  /** Demandés, désormais qualifiés v2. */
  requestedQualified: number;
  /** Carte #766 (E13) : demandés, travail RÉUSSI mais sortie incomplète (sans qualification v2) — repris, de façon bornée. */
  requestedIncomplete: number;
  /** Carte #766 (E13) : demandés, travail en ERREUR TECHNIQUE (échoué ou annulé) — repris, de façon bornée. */
  requestedFailed: number;
  /** Carte #766 (E13) : plafond de demandes atteint, toujours sans qualification v2 — ÉCHEC DÉFINITIF, jamais redemandé. */
  requestedExhausted: number;
  /** Qualifiés v2 sans requalification (analysés après l'activation du bloc). */
  qualifiedOtherwise: number;
}

const BASE_SQL = (accountFilter: string) => `
  SELECT f.id AS file_id, f.account_id,
         EXISTS (SELECT 1 FROM document_facts df WHERE df.file_id = f.id AND df.account_id = f.account_id AND df.status = 'active'
                   AND COALESCE(df.raw_key, df.fact_key) = '${RELEVANCE_FACT_KEY}') AS qualified,
         (SELECT j.status FROM ai_job_queue j WHERE j.treatment = 'T1' AND j.account_id = f.account_id AND j.target_id = f.id::text
             AND j.trigger_code = '${REQUALIFICATION_ORIGIN}' ORDER BY j.id DESC LIMIT 1) AS job_status,
         (SELECT count(*)::int FROM ai_job_queue j WHERE j.treatment = 'T1' AND j.account_id = f.account_id AND j.target_id = f.id::text
             AND j.trigger_code = '${REQUALIFICATION_ORIGIN}') AS attempts
    FROM asset_files f
   WHERE f.deleted_at IS NULL AND f.grouped_into_file_id IS NULL AND f.analysis_state = 'ANALYZED'
     AND EXISTS (SELECT 1 FROM document_extractions x WHERE x.file_id = f.id AND x.account_id = f.account_id)
     ${accountFilter}`;

/**
 * Classement d'un document (pur). Carte #766 (E13) : un travail terminé sans qualification v2 est une sortie
 * incomplète (réussi) ou une erreur technique (échoué, annulé) tant que le plafond de demandes n'est pas
 * atteint ; au plafond, c'est un échec définitif. `attempts` : demandes déjà faites (défaut : 1 dès qu'un travail existe).
 */
export function censusBucket(r: { qualified: boolean; jobStatus: string | null; attempts?: number }): keyof RequalificationCensus {
  if (r.jobStatus == null) return r.qualified ? 'qualifiedOtherwise' : 'toRequalify';
  if (r.qualified) return 'requestedQualified';
  if (r.jobStatus === 'PENDING' || r.jobStatus === 'RUNNING') return 'requestedPending';
  if ((r.attempts ?? 1) >= REQUALIFICATION_MAX_ATTEMPTS) return 'requestedExhausted';
  return r.jobStatus === 'DONE' ? 'requestedIncomplete' : 'requestedFailed';
}

export async function requalificationCensus(sql: Sql, accountId: number | null): Promise<RequalificationCensus> {
  const out: RequalificationCensus = {
    toRequalify: 0, requestedPending: 0, requestedQualified: 0, requestedIncomplete: 0, requestedFailed: 0, requestedExhausted: 0, qualifiedOtherwise: 0,
  };
  const rows = (await sql.unsafe(
    `SELECT b.qualified, b.job_status, LEAST(b.attempts, ${REQUALIFICATION_MAX_ATTEMPTS}) AS attempts, count(*)::int AS n
       FROM (${BASE_SQL(accountId ? 'AND f.account_id = $1' : '')}) b GROUP BY 1, 2, 3`,
    (accountId ? [accountId] : []) as never[],
  )) as unknown as Row[];
  for (const r of rows) {
    out[censusBucket({ qualified: r.qualified === true, jobStatus: (r.job_status as string | null) ?? null, attempts: Number(r.attempts ?? 0) })] += Number(r.n);
  }
  return out;
}

/** Carte #766 (E13) : documents à reprendre (sortie incomplète ou erreur technique, sous le plafond). */
export const retryableOf = (c: RequalificationCensus): number => c.requestedIncomplete + c.requestedFailed;

export interface BlockedDocument { fileId: number; accountId: number; lastStatus: string; attempts: number }

/**
 * Carte #766 (E13) — documents BLOQUÉS (plafond de demandes atteint, toujours sans qualification v2), pour le
 * rapport BO : au plus `REQUALIFICATION_BLOCKED_SAMPLE`, ordre stable. Lecture seule.
 */
export async function blockedRequalifications(sql: Sql, accountId: number | null): Promise<BlockedDocument[]> {
  const rows = (await sql.unsafe(
    `SELECT b.file_id, b.account_id, b.job_status, b.attempts FROM (${BASE_SQL(accountId ? 'AND f.account_id = $1' : '')}) b
      WHERE NOT b.qualified AND b.job_status IS NOT NULL AND b.job_status NOT IN ('PENDING', 'RUNNING') AND b.attempts >= ${REQUALIFICATION_MAX_ATTEMPTS}
      ORDER BY b.account_id, b.file_id LIMIT ${REQUALIFICATION_BLOCKED_SAMPLE}`,
    (accountId ? [accountId] : []) as never[],
  )) as unknown as Row[];
  return rows.map((r) => ({ fileId: Number(r.file_id), accountId: Number(r.account_id), lastStatus: String(r.job_status), attempts: Number(r.attempts) }));
}

/**
 * Carte #766 (E13) : le lot comprend aussi les documents À REPRENDRE (dernier travail de cette origine terminé
 * sans qualification v2, sous le plafond de demandes), APRÈS les documents jamais demandés.
 *
 * Prochain lot (ordre stable : compte, document) — documents « à requalifier » seulement, hors document
 * déjà en cours d'analyse T1 (toute origine) et hors compte non éligible au traitement (lecture seule,
 * suspendu, essai échu : la file les refuserait ; ils ne bloquent jamais les lots suivants). L'éligibilité
 * est lue UNE fois par compte, jamais par document.
 */
export async function nextRequalificationBatch(sql: Sql, accountId: number | null, limit: number, eligible: (accountId: number) => Promise<boolean>):
  Promise<{ batch: Array<{ fileId: number; accountId: number; retry: boolean }>; ineligibleAccounts: number[] }> {
  const filtre = accountId ? 'AND f.account_id = $1' : '';
  const params = (accountId ? [accountId] : []) as never[];
  const enAttente = `NOT b.qualified
        AND (b.job_status IS NULL OR (b.job_status NOT IN ('PENDING', 'RUNNING') AND b.attempts < ${REQUALIFICATION_MAX_ATTEMPTS}))
        AND NOT EXISTS (SELECT 1 FROM ai_job_queue j2 WHERE j2.treatment = 'T1' AND j2.account_id = b.account_id AND j2.target_id = b.file_id::text AND j2.status IN ('PENDING', 'RUNNING'))`;
  const comptes = (await sql.unsafe(
    `SELECT DISTINCT b.account_id FROM (${BASE_SQL(filtre)}) b WHERE ${enAttente} ORDER BY 1 LIMIT 500`, params,
  )) as unknown as Row[];
  const retenus: number[] = [];
  const ineligibleAccounts: number[] = [];
  for (const c of comptes.map((x) => Number(x.account_id))) (await eligible(c).catch(() => false) ? retenus : ineligibleAccounts).push(c);
  if (!retenus.length) return { batch: [], ineligibleAccounts };
  const rows = (await sql.unsafe(
    `SELECT b.file_id, b.account_id, (b.job_status IS NOT NULL) AS retry FROM (${BASE_SQL(filtre)}) b
      WHERE ${enAttente} AND b.account_id = ANY('{${retenus.join(',')}}'::int[])
      ORDER BY (b.job_status IS NOT NULL), b.account_id, b.file_id LIMIT ${Math.max(1, Math.min(limit, 1_000))}`,
    params,
  )) as unknown as Row[];
  return { batch: rows.map((r) => ({ fileId: Number(r.file_id), accountId: Number(r.account_id), retry: r.retry === true })), ineligibleAccounts };
}

export interface CostEstimate {
  /** Coût moyen observé d'une analyse T1 par document (micro-dollars), null : non estimable. */
  averageMicrosPerDocument: number | null;
  /** Estimation indicative pour les documents à requalifier (micro-dollars), null : non estimable. */
  estimatedMicros: number | null;
  windowDays: number;
  /** Documents analysés par T1 sur la fenêtre (base de la moyenne). */
  sampleDocuments: number;
}

/** Estimation (pure) : moyenne observée × nombre de documents ; jamais une moyenne sur zéro document. */
export function estimateCost(totalMicros: number, analysedDocuments: number, documents: number): Pick<CostEstimate, 'averageMicrosPerDocument' | 'estimatedMicros'> {
  if (analysedDocuments <= 0 || totalMicros <= 0) return { averageMicrosPerDocument: null, estimatedMicros: null };
  const moyenne = Math.round(totalMicros / analysedDocuments);
  return { averageMicrosPerDocument: moyenne, estimatedMicros: moyenne * documents };
}

/** Coût indicatif : rapport des coûts IA existant (T1, fenêtre glissante) ÷ documents analysés. Ne lève pas. */
export async function requalificationCostEstimate(sql: Sql, documents: number): Promise<CostEstimate> {
  const base: CostEstimate = { averageMicrosPerDocument: null, estimatedMicros: null, windowDays: REQUALIFICATION_COST_WINDOW_DAYS, sampleDocuments: 0 };
  try {
    const since = new Date(Date.now() - REQUALIFICATION_COST_WINDOW_DAYS * 86_400_000);
    const { getCostReport } = await import('@/services/ai/telemetry/cost-report.repository');
    const rapport = await getCostReport({ treatment: 'T1', since });
    const [n] = (await sql.unsafe(
      `SELECT count(DISTINCT asset_file_id)::int AS n FROM document_analysis_runs WHERE status = 'completed' AND created_at >= $1`,
      [since.toISOString()] as never[],
    )) as unknown as Row[];
    const docs = Number(n?.n ?? 0);
    return { ...base, sampleDocuments: docs, ...estimateCost(rapport.totals.functionalMicros + rapport.totals.technicalMicros, docs, documents) };
  } catch (e) {
    console.warn('[business-periods/requalification] estimation de coût indisponible', (e as Error)?.message);
    return base;
  }
}

export interface RequalificationDeps {
  availability: () => Promise<RequalificationAvailability>;
  /** Mise en file T1 (rend les identifiants acceptés) — `enqueueFileAnalyses` par défaut. */
  enqueue: (fileIds: number[], accountId: number) => Promise<number[]>;
  /** Compte éligible au traitement (même contrôle que la file, `checkAccountProcessingEligibility`). */
  eligible: (accountId: number) => Promise<boolean>;
}

export const defaultRequalificationDeps = (): RequalificationDeps => ({
  availability: requalificationAvailability,
  enqueue: async (fileIds, accountId) => {
    const { enqueueFileAnalyses } = await import('@/services/ai/source-analysis/queue/t1-handler');
    // Traitement technique, non facturé, reprise de la dernière exécution du document (même chemin que
    // la relance T1 ciblée de la récupération des montants, lot 108B).
    return enqueueFileAnalyses(fileIds, accountId, { origin: REQUALIFICATION_ORIGIN, billable: false, processingVisibility: 'TECHNICAL', resume: true });
  },
  eligible: async (accountId) => (await (await import('@/services/account/processing-eligibility')).checkAccountProcessingEligibility(accountId)).eligible,
});

export interface RequalificationReport {
  action: 'simulate' | 'apply';
  availability: RequalificationAvailability;
  batchSize: number;
  before: RequalificationCensus;
  estimate: CostEstimate;
  /** Lot choisi (simulation : celui qui serait mis en file). */
  batch: number[];
  /** Carte #766 (E13) : documents du lot qui sont des REPRISES (déjà demandés, travail terminé sans qualification v2). */
  batchRetries: number[];
  /** Carte #766 (E13) : documents bloqués (plafond de demandes atteint) — échantillon borné pour le diagnostic. */
  blocked: BlockedDocument[];
  maxAttempts: number;
  /** Comptes écartés du lot (non éligibles au traitement IA). */
  ineligibleAccounts: number[];
  /** Application : refus sans mise en file (contrat non actif). */
  refused?: 'CONTRACT_NOT_ACTIVE';
  /** Application : documents réellement mis en file / non acceptés par la file (déjà en file, compte non éligible). */
  queued?: number[];
  notAccepted?: number[];
  after?: RequalificationCensus;
}

/**
 * Simulation (estimation, rien n'est écrit) ou application d'UN lot (mise en file T1). L'application
 * revérifie le contrat (le bouton désactivé n'est qu'un confort) : jamais de travail sans le bloc 28.
 */
export async function runBusinessPeriodsRequalification(
  p: { apply: boolean; accountId: number | null; sql: Sql; log?: (m: string) => void; batchSize?: number },
  deps: RequalificationDeps = defaultRequalificationDeps(),
): Promise<RequalificationReport> {
  const log = p.log ?? (() => undefined);
  const taille = Math.max(1, Math.min(p.batchSize ?? REQUALIFICATION_BATCH_SIZE, 1_000));
  const [availability, before] = await Promise.all([deps.availability(), requalificationCensus(p.sql, p.accountId)]);
  // Carte #766 (E13) : le coût indicatif couvre aussi les reprises encore permises.
  const estimate = await requalificationCostEstimate(p.sql, before.toRequalify + retryableOf(before));
  const { batch: lot, ineligibleAccounts } = await nextRequalificationBatch(p.sql, p.accountId, taille, deps.eligible);
  const blocked = before.requestedExhausted > 0 ? await blockedRequalifications(p.sql, p.accountId) : [];
  const base: RequalificationReport = {
    action: p.apply ? 'apply' : 'simulate', availability, batchSize: taille, before, estimate, batch: lot.map((x) => x.fileId), ineligibleAccounts,
    batchRetries: lot.filter((x) => x.retry).map((x) => x.fileId), blocked, maxAttempts: REQUALIFICATION_MAX_ATTEMPTS,
  };
  log(`contrat ${T1_BUSINESS_PERIODS_V2_CONTRACT} : ${availability.contractState} ; à requalifier : ${before.toRequalify} ; à reprendre : ${retryableOf(before)} ; bloqués : ${before.requestedExhausted} ; lot : ${lot.length}`);
  if (!p.apply) return base;
  if (!availability.available) {
    log('application refusée : contrat T1 non actif');
    return { ...base, refused: 'CONTRACT_NOT_ACTIVE', queued: [], notAccepted: [], after: before };
  }
  const parCompte = new Map<number, number[]>();
  for (const x of lot) parCompte.set(x.accountId, [...(parCompte.get(x.accountId) ?? []), x.fileId]);
  const queued: number[] = [];
  const notAccepted: number[] = [];
  for (const [compte, fichiers] of parCompte) {
    const acceptes = new Set(await deps.enqueue(fichiers, compte).catch((e) => { log(`compte ${compte} : mise en file impossible (${(e as Error).message})`); return [] as number[]; }));
    for (const f of fichiers) (acceptes.has(f) ? queued : notAccepted).push(f);
    log(`compte ${compte} : ${acceptes.size}/${fichiers.length} document(s) mis en file`);
  }
  return { ...base, queued, notAccepted, after: await requalificationCensus(p.sql, p.accountId) };
}
