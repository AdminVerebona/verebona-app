/**
 * Lot 113AD (Trello #725, §2 B — D11, R13 / R14) — RÉEXAMEN T3 par l'IA d'une
 * divergence de périodes que les documents ne déclarent pas : mémoire,
 * demandes, et PHASE du passage T3 du compte (file durable de consolidation).
 *
 * ══════════════════════════════════════════════════════════════════════════
 *   demande  `requestRelationReviews` — posée par la synchronisation des
 *            cartes PERIOD-CONFLICT (après un passage T3, une correction, le
 *            contrôle COH-OPS-PERIOD-RESOLUTION), SANS appel IA, seulement si
 *            le prompt T3 effectif porte la branche ET le marqueur : une ligne
 *            PENDING par divergence jamais examinée. La question est alors
 *            DIFFÉRÉE (au plus `PERIOD_RELATION_MAX_WAIT_HOURS`) ;
 *   phase    `runPeriodRelationPhase` — passage T3 du compte (hors verrou,
 *            jamais à la consultation) : capacité → divergence encore
 *            présente ? → budget (plafonds EXISTANTS du rapprochement
 *            sémantique, par passage et par 24 h ; éligibilité et plafond de
 *            coût du compte appliqués par la passerelle) → appel T3 →
 *            VALIDATION stricte (toute sortie invalide = abstention) →
 *            mémoire → cartes resynchronisées (question si le classement
 *            n'explique pas la divergence, fermeture sinon) ;
 *   lecture  `loadRelationStates` — état de chaque divergence relu par la
 *            résolution (`resolvePeriods`), SOUS la décision de l'utilisateur.
 * Une paire déjà classée n'est JAMAIS renvoyée à l'IA (une ligne par
 * empreinte et par compte). Aucune période de document n'est modifiée.
 *
 * CARTE #766 (E07) — INCIDENT TECHNIQUE ≠ AMBIGUÏTÉ MÉTIER (règle remplacée) :
 *   · une demande en attente (budget épuisé, file en retard) ou en échec technique (panne, quota, 403 /
 *     429, délai dépassé) ne devient PLUS une question au bout de `PERIOD_RELATION_MAX_WAIT_HOURS` :
 *     ce délai n'est plus qu'un seuil de SUPERVISION (demande « en retard », signalée au BO) ;
 *   · reprises BORNÉES : `PERIOD_RELATION_MAX_ATTEMPTS` appels par cycle, espacés de `RETRY_AFTER_HOURS` ;
 *     essais épuisés → état `FAILED` (jamais une question ; la divergence reste affichée comme telle) ;
 *     un nouveau cycle peut être réarmé (`rearmFailedRelationReviews`, par la synchronisation des cartes
 *     ou le contrôle COH-OPS-PERIOD-RESOLUTION), au plus un par `REARM_AFTER_HOURS` et tant que le total
 *     des appels de la divergence reste sous `PERIOD_RELATION_MAX_TOTAL_CALLS` ; au-delà : blocage
 *     signalé au BO, plus aucun appel ;
 *   · version du prompt T3 ILLISIBLE (incident) : les demandes restent en attente — elles ne sont plus
 *     closes « indisponibles » (ce qui ramenait la question) ; branche réellement retirée ou coupure
 *     volontaire (configuration) : comportement 113AA inchangé ;
 *   · la question n'est posée que lorsque T3 a réellement travaillé sans expliquer la divergence.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type postgres from 'postgres';
import { EXPLAINING_RELATIONS, PERIOD_RELATION_CONTRACT_VERSION, type ExplainingRelation } from './relation-contract';
import type { AiPeriodRelation, PeriodConflict } from './resolution';

type Sql = postgres.Sql | postgres.TransactionSql;
type Row = Record<string, unknown>;

/**
 * Carte #766 (E07) — règle remplacée : seuil de SUPERVISION (heures) au-delà duquel une demande de
 * réexamen toujours en attente est signalée « en retard » au BO. Ce n'est plus un délai au bout duquel la
 * question est posée à l'utilisateur. Paramètre centralisé, à valider par le PO.
 */
export const PERIOD_RELATION_MAX_WAIT_HOURS = 24;
/** Carte #766 (E07) : total des appels IA permis pour UNE divergence, tous cycles confondus (à valider par le PO). */
export const PERIOD_RELATION_MAX_TOTAL_CALLS = 9;
/** Carte #766 (E07) : délai minimal entre deux cycles d'essais d'une même divergence (heures ; à valider par le PO). */
export const REARM_AFTER_HOURS = 24;
/** Nouvel essai après un échec technique de l'appel (heures), au plus `PERIOD_RELATION_MAX_ATTEMPTS` appels. */
const RETRY_AFTER_HOURS = 6;
export const PERIOD_RELATION_MAX_ATTEMPTS = 3;
/** Demandes examinées par passage (au-delà : passage suivant). */
const REQUESTS_PER_PASS = 20;

const tableMissing = (e: unknown) => (e as { code?: string })?.code === '42P01';
const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

/** État relu par la résolution, avec la preuve citée d'un classement retenu. */
export type RelationState = AiPeriodRelation & { citation?: { fileId: number; excerpt: string } | null };

/**
 * États des divergences touchant ces documents (une requête ; table absente : aucun — comportement 113AA).
 * OBSOLETE / UNAVAILABLE : non relus (la divergence peut être redemandée).
 */
export async function loadRelationStates(sql: Sql, accountId: number, fileIds: readonly number[]): Promise<RelationState[]> {
  const ids = [...new Set(fileIds)].filter((x) => Number.isSafeInteger(x) && x > 0);
  if (!ids.length) return [];
  let r: Row[] = [];
  try {
    r = (await sql.unsafe(
      `SELECT fingerprint, status, relation, replacing_file_id, confidence, evidence,
              (requested_at > now() - make_interval(hours => ${PERIOD_RELATION_MAX_WAIT_HOURS})) AS fresh,
              (status = 'AI_FAILED' AND (retry_at IS NULL OR attempts >= ${PERIOD_RELATION_MAX_ATTEMPTS})) AS exhausted,
              (ai_calls < ${PERIOD_RELATION_MAX_TOTAL_CALLS}) AS rearmable
         FROM business_period_relation_reviews
        WHERE account_id = $1 AND file_ids && $2::int[] AND status NOT IN ('OBSOLETE', 'UNAVAILABLE')`,
      [accountId, `{${ids.join(',')}}`] as never[],
    )) as unknown as Row[];
  } catch (e) {
    if (!tableMissing(e)) throw e;
    return [];
  }
  return r.map((x): RelationState => {
    const fingerprint = String(x.fingerprint);
    const status = String(x.status);
    const relation = x.relation == null ? null : String(x.relation);
    if (status === 'DECIDED' && x.confidence === 'certain' && relation && (EXPLAINING_RELATIONS as readonly string[]).includes(relation)) {
      const ev = (Array.isArray(x.evidence) ? x.evidence : []) as Array<{ fileId?: unknown; excerpt?: unknown }>;
      const c = ev.find((e) => Number.isSafeInteger(Number(e?.fileId)) && typeof e?.excerpt === 'string');
      return {
        fingerprint, state: 'DECIDED', relation: relation as ExplainingRelation,
        replacingFileId: x.replacing_file_id == null ? null : Number(x.replacing_file_id),
        citation: c ? { fileId: Number(c.fileId), excerpt: String(c.excerpt) } : null,
      };
    }
    // Carte #766 (E07) — règle remplacée : un incident technique n'est jamais une ambiguïté métier.
    //   · essais épuisés après des échecs techniques : FAILED (aucune question) ;
    //   · demande en attente ou nouvel essai planifié : AWAITING, quel que soit son âge (`late` : supervision).
    if (status === 'AI_FAILED' && x.exhausted === true) return { fingerprint, state: 'FAILED', ...(x.rearmable === true ? { rearmable: true } : {}) };
    if (status === 'PENDING' || status === 'AI_FAILED') return { fingerprint, state: 'AWAITING', ...(x.fresh === true ? {} : { late: true }) };
    // T3 a travaillé : abstention, sortie refusée, confiance insuffisante, ou contradiction certaine.
    return { fingerprint, state: 'EXAMINED', ...(status === 'DECIDED' && x.confidence === 'certain' && relation === 'CONTRADICTION' ? { contradiction: true } : {}) };
  });
}

/**
 * Demandes de réexamen des divergences JAMAIS examinées (ni demandées) d'un événement de référence (aucun
 * appel IA). Une ligne OBSOLETE / UNAVAILABLE (divergence disparue puis revenue, branche retirée puis
 * remise) redevient PENDING ; toute autre ligne n'est jamais rouverte. Rend les empreintes demandées.
 */
export async function requestRelationReviews(sql: Sql, accountId: number, operationId: number, conflicts: readonly PeriodConflict[]): Promise<string[]> {
  const nouvelles = conflicts.filter((c) => c.review === 'NONE');
  const out: string[] = [];
  for (const c of nouvelles) {
    const r = (await sql.unsafe(
      `INSERT INTO business_period_relation_reviews (account_id, operation_id, period_kind, fingerprint, file_ids, period_ids, status, contract_version)
       SELECT $1::int, $2::bigint, $3::text, $4::text, $5::int[], $6::bigint[], 'PENDING', $7::text
        WHERE EXISTS (SELECT 1 FROM business_operations o WHERE o.id = $2::bigint AND o.account_id = $1::int)
       ON CONFLICT (account_id, fingerprint) DO UPDATE
          SET status = 'PENDING', operation_id = EXCLUDED.operation_id, file_ids = EXCLUDED.file_ids, period_ids = EXCLUDED.period_ids,
              requested_at = now(), updated_at = now(), attempts = 0, retry_at = NULL, error = NULL
        WHERE business_period_relation_reviews.status IN ('OBSOLETE', 'UNAVAILABLE')
       RETURNING fingerprint`,
      [accountId, operationId, c.kind, c.fingerprint, `{${c.fileIds.join(',')}}`, `{${c.periodIds.join(',')}}`, PERIOD_RELATION_CONTRACT_VERSION] as never[],
    )) as unknown as Row[];
    if (r.length) out.push(c.fingerprint);
  }
  return out;
}

/**
 * Carte #766 (E07) — réarme un NOUVEAU cycle d'essais pour les divergences en échec technique dont les
 * essais sont épuisés (aucun appel IA ici) : au plus un cycle par `REARM_AFTER_HOURS`, et seulement tant
 * que le total des appels de la divergence reste sous `PERIOD_RELATION_MAX_TOTAL_CALLS`. Rend les
 * empreintes réarmées. Bornée au compte et à l'événement de référence.
 */
export async function rearmFailedRelationReviews(sql: Sql, accountId: number, operationId: number, fingerprints: readonly string[]): Promise<string[]> {
  const fps = [...new Set(fingerprints)];
  if (!fps.length) return [];
  const r = (await sql.unsafe(
    `UPDATE business_period_relation_reviews
        SET status = 'PENDING', attempts = 0, retry_at = NULL, requested_at = now(), updated_at = now()
      WHERE account_id = $1 AND operation_id = $2 AND fingerprint = ANY($3::text[]) AND status = 'AI_FAILED'
        AND (retry_at IS NULL OR attempts >= ${PERIOD_RELATION_MAX_ATTEMPTS}) AND ai_calls < ${PERIOD_RELATION_MAX_TOTAL_CALLS}
        AND updated_at <= now() - make_interval(hours => ${REARM_AFTER_HOURS})
      RETURNING fingerprint`,
    [accountId, operationId, fps] as never[],
  )) as unknown as Row[];
  if (r.length) console.info(JSON.stringify({ event: 't3.period_relation.rearmed', accountId, operationId, count: r.length }));
  return r.map((x) => String(x.fingerprint));
}

/** Prédicat SQL « le compte a une demande de réexamen à traiter » (balayage horaire du passage T3). */
export const RELATION_REVIEW_PENDING_SQL = (alias: string) => `
  (${alias}.status = 'PENDING' OR (${alias}.status = 'AI_FAILED' AND ${alias}.retry_at <= now() AND ${alias}.attempts < ${PERIOD_RELATION_MAX_ATTEMPTS}))`;

interface Pending { id: number; operationId: number; fingerprint: string; periodIds: number[]; attempts: number }

async function pendingRequests(sql: Sql, accountId: number, limit: number): Promise<Pending[]> {
  const r = (await sql.unsafe(
    `SELECT r.id, r.operation_id, r.fingerprint, r.period_ids, r.attempts FROM business_period_relation_reviews r
      WHERE r.account_id = $1 AND ${RELATION_REVIEW_PENDING_SQL('r')} ORDER BY r.id LIMIT $2`,
    [accountId, limit] as never[],
  )) as unknown as Row[];
  return r.map((x) => ({
    id: Number(x.id), operationId: Number(x.operation_id), fingerprint: String(x.fingerprint),
    periodIds: (Array.isArray(x.period_ids) ? x.period_ids : []).map(Number), attempts: Number(x.attempts ?? 0),
  }));
}

/** Appels IA du compte sur 24 h glissantes (budget). */
async function callsLastDay(sql: Sql, accountId: number): Promise<number> {
  const [r] = (await sql.unsafe(
    `SELECT COALESCE(sum(ai_calls), 0)::int AS n FROM business_period_relation_reviews
      WHERE account_id = $1 AND last_call_at > now() - interval '24 hours'`, [accountId] as never[],
  )) as unknown as Row[];
  return Number(r?.n ?? 0);
}

async function complete(sql: Sql, id: number, r: {
  status: string; relation?: string | null; replacingFileId?: number | null; confidence?: string | null; evidence?: unknown; reason?: string | null;
  aiOutput?: unknown; validation?: Record<string, unknown>; deciderVersion?: string | null; traceId?: string | null; called?: boolean; error?: string | null;
  retry?: boolean;
}): Promise<void> {
  await sql.unsafe(
    `UPDATE business_period_relation_reviews
        SET status = $2::text, relation = COALESCE($3::text, relation), replacing_file_id = $4::int, confidence = COALESCE($5::text, confidence),
            evidence = COALESCE($6::text::jsonb, evidence), reason = COALESCE($7::text, reason), ai_output = COALESCE($8::text::jsonb, ai_output),
            validation = COALESCE($9::text::jsonb, validation), decider_version = COALESCE($10::text, decider_version), ai_trace_id = COALESCE($11::text, ai_trace_id),
            ai_calls = ai_calls + CASE WHEN $12::boolean THEN 1 ELSE 0 END, attempts = attempts + CASE WHEN $12::boolean THEN 1 ELSE 0 END,
            last_call_at = CASE WHEN $12::boolean THEN now() ELSE last_call_at END, error = $13::text,
            retry_at = CASE WHEN $14::boolean THEN now() + make_interval(hours => ${RETRY_AFTER_HOURS}) ELSE NULL END,
            decided_at = CASE WHEN $2::text IN ('PENDING', 'AI_FAILED') THEN decided_at ELSE now() END, updated_at = now()
      WHERE id = $1`,
    [id, r.status, r.relation ?? null, r.replacingFileId ?? null, r.confidence ?? null, json(r.evidence), r.reason ? r.reason.slice(0, 300) : null,
      json(r.aiOutput), json(r.validation), r.deciderVersion ?? null, r.traceId ?? null, r.called === true, r.error ? r.error.slice(0, 500) : null,
      r.retry === true] as never[],
  );
}

/** Contexte brut d'une paire (lecture seule, bornée au compte) ; null : une période n'est plus active. */
async function loadRawContext(sql: Sql, accountId: number, operationId: number, periodIds: readonly number[], kind: string, today: string):
  Promise<import('./relation-contract').RawRelationContext | null> {
  const p = (await sql.unsafe(
    `SELECT id, file_id, start_on, end_on, end_open, user_locked, evidence->>'quote' AS quote FROM document_business_periods
      WHERE account_id = $1 AND id = ANY($2::bigint[]) AND status = 'ACTIVE' ORDER BY id`,
    [accountId, `{${periodIds.join(',')}}`] as never[],
  )) as unknown as Row[];
  if (p.length !== 2) return null;
  const [o] = (await sql.unsafe(
    `SELECT type_code, technical_label, provider FROM business_operations WHERE id = $1 AND account_id = $2`, [operationId, accountId] as never[],
  )) as unknown as Row[];
  const { loadDocuments } = await import('@/services/business-operations/semantic/load');
  const docs = await loadDocuments(sql as postgres.Sql, accountId, p.map((x) => Number(x.file_id)));
  return {
    today, periodKind: kind,
    operation: { typeCode: (o?.type_code as string | null) ?? null, label: (o?.technical_label as string | null) ?? null, provider: (o?.provider as string | null) ?? null },
    periods: p.map((x) => ({
      periodId: Number(x.id), fileId: Number(x.file_id), start: (x.start_on as string | null) ?? null, end: (x.end_on as string | null) ?? null,
      openEnded: x.end_open === true, quote: (x.quote as string | null) ?? null, userCorrected: x.user_locked === true,
    })),
    documents: docs.map((d) => ({ id: d.id, type: d.type, title: d.title, date: d.date, provider: d.provider, references: d.references, excerpts: d.excerpts })),
  };
}

export interface PeriodRelationPhaseResult {
  processed: number;
  aiCalls: number;
  /** Événements de référence dont les cartes ont été resynchronisées. */
  operations: number[];
  outcomes: Record<string, number>;
  /** Capacité absente (bloc 29 non collé, coupure) : aucune demande traitée par l'IA. */
  unavailable?: string;
}

const todayParis = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(d);

/**
 * Phase du passage T3 du compte (file de consolidation) : traite les demandes de réexamen en attente, par
 * lot borné. Ne lève que l'annulation coopérative ; tout autre échec est tracé sur la demande.
 */
export async function runPeriodRelationPhase(accountId: number, opts: {
  sql?: Sql; now?: () => Date; beforeCall?: (what: string) => Promise<void> | void;
  decider?: import('./relation-decider').RelationDecider; dailyMax?: number; passMax?: number; limit?: number;
} = {}): Promise<PeriodRelationPhaseResult> {
  const out: PeriodRelationPhaseResult = { processed: 0, aiCalls: 0, operations: [], outcomes: {} };
  const [{ pgClient }, deciderMod, contract, m3, svc] = await Promise.all([
    import('@/db'), import('./relation-decider'), import('./relation-contract'), import('@/services/business-operations/consolidation/m3'), import('./service'),
  ]);
  const sql = opts.sql ?? pgClient;
  let demandes: Pending[];
  try { demandes = await pendingRequests(sql, accountId, opts.limit ?? REQUESTS_PER_PASS); } catch (e) { if (tableMissing(e)) return out; throw e; }
  if (!demandes.length) return out;
  const now = opts.now ?? (() => new Date());
  const decider = opts.decider ?? deciderMod.relationDecider();
  const parJour = opts.dailyMax ?? m3.operationMatchCallsPerDay();
  const parPassage = opts.passMax ?? m3.operationMatchCallsPerPass();
  const compter = (s: string) => { out.outcomes[s] = (out.outcomes[s] ?? 0) + 1; };
  const touchees = new Set<number>();

  const cap = await decider.capability();
  if (!cap.available && cap.contractState === 'UNREADABLE') {
    // Carte #766 (E07) : version du prompt T3 illisible = INCIDENT, pas une configuration — les demandes
    // restent en attente (aucune clôture « indisponible », donc aucune question ramenée par une panne).
    out.unavailable = 'UNREADABLE';
    console.warn(JSON.stringify({ event: 't3.period_relation.capability_unreadable', accountId, pending: demandes.length }));
    return out;
  }
  if (!cap.available) {
    // Branche retirée (ou coupure) : les demandes sont closes « indisponibles » et la question revient (113AA).
    for (const d of demandes) {
      await complete(sql, d.id, { status: 'UNAVAILABLE', reason: cap.reason, validation: { contractState: cap.contractState ?? null } });
      touchees.add(d.operationId);
      compter('UNAVAILABLE');
      out.processed++;
    }
    out.unavailable = cap.contractState ?? cap.reason;
  } else {
    for (const d of demandes) {
      // La divergence existe-t-elle encore (correction, réanalyse, décision de l'utilisateur, avenant reçu) ?
      const res = (await svc.operationsPeriodResolution(sql, accountId, [d.operationId])).get(d.operationId);
      // Carte #766 (E06) : une paire dont l'ordre n'est pas prouvé est examinée comme une divergence.
      const conflit = [...(res?.conflicts ?? []), ...(res?.uncertain ?? [])].find((c) => c.fingerprint === d.fingerprint) ?? null;
      const raw = conflit ? await loadRawContext(sql, accountId, d.operationId, conflit.periodIds, conflit.kind, todayParis(now())) : null;
      if (!conflit || !raw) {
        await complete(sql, d.id, { status: 'OBSOLETE', reason: conflit ? 'PERIOD_GONE' : 'DIVERGENCE_GONE' });
        touchees.add(d.operationId);
        compter('OBSOLETE');
        out.processed++;
        continue;
      }
      // Budget : plafonds existants du rapprochement sémantique (par passage, par 24 h et par compte) — la demande reste en attente.
      if (out.aiCalls >= parPassage || (await callsLastDay(sql, accountId)) >= parJour) { compter('DEFERRED_BUDGET'); break; }
      const b = contract.buildRelationInput(raw);
      await opts.beforeCall?.('T3 relation entre périodes divergentes — décision sémantique');
      out.aiCalls++;
      out.processed++;
      touchees.add(d.operationId);
      let answer: { output: unknown; traceId: string | null };
      try {
        answer = await decider.decide({ accountId, fileIds: [b.scope.documents.D1, b.scope.documents.D2], input: b.input });
      } catch (e) {
        const { isExecutionCancelled } = await import('@/services/ai/queue/execution-control');
        if (isExecutionCancelled(e)) throw e;
        const dernier = d.attempts + 1 >= PERIOD_RELATION_MAX_ATTEMPTS;
        await complete(sql, d.id, {
          status: 'AI_FAILED', reason: 'AI_CALL_FAILED', error: String((e as Error)?.message ?? e), deciderVersion: cap.version, called: true,
          retry: !dernier,
        });
        // Carte #766 (E07) : journalisation de l'incident (jamais une question ; supervision BO).
        console.warn(JSON.stringify({
          event: 't3.period_relation.failed', accountId, operationId: d.operationId, reviewId: d.id, attempt: d.attempts + 1,
          exhausted: dernier, error: String((e as Error)?.message ?? e).slice(0, 200),
        }));
        compter('AI_FAILED');
        continue;
      }
      const commun = { aiOutput: answer.output ?? null, deciderVersion: cap.version, traceId: answer.traceId, called: true };
      const v = contract.validateRelation(answer.output, b.scope);
      if (!v.ok) {
        // Toute sortie invalide vaut abstention : comportement 113AA, motif tracé.
        await complete(sql, d.id, { ...commun, status: 'REJECTED', reason: `INVALID_DECISION:${v.problems[0]?.issue ?? 'SCHEMA'}`, validation: { valid: false, problems: v.problems } });
        compter('REJECTED');
        continue;
      }
      const dec = v.decision;
      const evidence = dec.evidence.map((e) => ({ document: e.document, fileId: b.scope.documents[e.document], excerpt: e.excerpt }));
      const base = { ...commun, relation: dec.relation, confidence: dec.confidence, reason: dec.reason, validation: { valid: true, ignored: v.ignored } };
      if (dec.relation === 'ABSTAIN') {
        await complete(sql, d.id, { ...base, status: 'ABSTAINED', evidence });
        compter('ABSTAINED');
      } else if (v.ignored === 'NOT_CERTAIN') {
        await complete(sql, d.id, { ...base, status: 'NOT_CERTAIN', evidence });
        compter('NOT_CERTAIN');
      } else {
        // Classement certain (CONTRADICTION comprise : la question reste posée). Preuve retenue d'abord.
        const cite = v.effect?.citation;
        const estCitee = (x: (typeof evidence)[number]) => !!cite && x.fileId === cite.fileId && x.excerpt === cite.excerpt;
        const ordre = [...evidence.filter(estCitee), ...evidence.filter((x) => !estCitee(x))];
        await complete(sql, d.id, { ...base, status: 'DECIDED', replacingFileId: v.effect?.replacingFileId ?? null, evidence: ordre });
        compter(`DECIDED_${dec.relation}`);
      }
      console.info(JSON.stringify({ event: 't3.period_relation', accountId, operationId: d.operationId, reviewId: d.id, relation: dec.relation, confidence: dec.confidence }));
    }
  }
  // Cartes resynchronisées : question si rien n'explique la divergence, fermeture sinon.
  out.operations = [...touchees].sort((a, b) => a - b);
  if (out.operations.length) {
    const { syncPeriodConflictCards } = await import('./conflict-cards');
    await syncPeriodConflictCards(accountId, { operationIds: out.operations });
  }
  return out;
}
