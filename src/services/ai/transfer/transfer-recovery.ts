/**
 * Attente technique et REPRISE AUTOMATIQUE après un incident d'ENVOI de
 * document au fournisseur IA — lot 113R (carte #717).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE FILE : LA FILE DURABLE, ET SA SUSPENSION EXISTANTE
 *
 * Un document dont l'envoi au fournisseur est refusé (401/403) ou impossible
 * (429, 5xx, réseau) n'est ni en échec ni « en cours » : son travail T1 est
 * SUSPENDU (`AI_SUSPENDED`, `payload.aiSuspension`, mécanisme du lot 87A) —
 * reprises espacées et bornées (5 min, 15 min, puis toutes les heures) ;
 * au-delà, attente LONGUE (`parked`) : le travail reste en file, le système
 * garde la responsabilité de la reprise et l'exploitation est alertée.
 *
 * Ce module ne crée aucune seconde file. Il :
 *   · tient l'ALERTE d'exploitation unique de l'incident (ouverte, mise à
 *     jour, résolue au rétablissement) ;
 *   · RATTACHE les documents HISTORIQUES en échec à cause de cet incident
 *     (y compris ceux que leur compteur exclut de la reprise ordinaire) :
 *     un travail suspendu leur est confié, sans facturation ;
 *   · VÉRIFIE le rétablissement par une sonde d'envoi réelle (petit fichier
 *     de test, `transfer-probe`) au plus une fois par
 *     `AI_TRANSFER_PROBE_MIN_INTERVAL_MINUTES` (15 min par défaut) — ou dès
 *     qu'un changement d'état de T1 (réactivation) est postérieur à la
 *     dernière vérification ; une réactivation SEULE ne libère rien : un 403
 *     encore présent reste visible ;
 *   · LIBÈRE les travaux suspendus quand la sonde réussit (prochaine prise
 *     échelonnée), déduplication et règles d'éligibilité de la file
 *     inchangées, aucun crédit consommé deux fois (la facturation reste celle
 *     du travail d'origine).
 *
 * Appelé par la reprise serveur (`analysis-recovery`, sous son bail en base).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';

type Row = Record<string, unknown>;

export const TRANSFER_ALERT_CODE = 'T1_ATTACHMENT_TRANSFER_BLOCKED';
const CONDITION_KEY = 'transfer:gemini:files_api';
const CAUSES = ['TRANSFER_ACCESS_DENIED', 'TRANSFER_UNAVAILABLE'];
/** Origine des travaux confiés à la file pour un document historique. */
export const TRANSFER_RECOVERY_ORIGIN = 'transfer-recovery';

function dbDisponible(): boolean {
  return !(process.env.NODE_ENV === 'test' && !process.env.DATABASE_URL);
}

export function transferProbeMinIntervalMs(): number {
  const n = Number(process.env.AI_TRANSFER_PROBE_MIN_INTERVAL_MINUTES);
  const min = Number.isFinite(n) && n >= 5 ? Math.min(Math.floor(n), 1440) : 15;
  return min * 60_000;
}

function releaseStaggerSeconds(): number {
  const n = Number(process.env.AI_TRANSFER_RELEASE_STAGGER_SECONDS);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 600) : 10;
}

/**
 * Incident d'envoi constaté par une suspension (file) : alerte unique de la
 * condition, sévérité critique dès qu'un travail a épuisé ses reprises
 * rapprochées. Ne lève jamais.
 */
export async function noteTransferIncident(p: { cause: string; parked: boolean; jobId: number; transfer: Record<string, unknown> | null }): Promise<void> {
  if (!dbDisponible()) return;
  try {
    const stock = await countSuspended();
    const { raiseConditionAlert } = await import('../alerts/alerts.repository');
    const t = p.transfer ?? {};
    const reponse = [t.httpStatus ? `HTTP ${t.httpStatus}` : null, t.providerStatus, t.providerReason].filter(Boolean).join(' ');
    await raiseConditionAlert({
      kind: 'anomaly', code: TRANSFER_ALERT_CODE, treatment: 'T1', severity: p.parked || stock.parked > 0 ? 'critical' : 'warning',
      message: `T1 : envoi des documents au fournisseur ${p.cause === 'TRANSFER_ACCESS_DENIED' ? 'refusé' : 'impossible'}${reponse ? ` (${reponse})` : ''} — ${stock.suspended} document(s) en attente technique${stock.parked > 0 ? `, dont ${stock.parked} après épuisement des reprises rapprochées` : ''}. Reprise automatique dès le rétablissement vérifié ; test d’envoi : BO › Fournisseur IA.`,
      details: { cause: p.cause, lastJobId: p.jobId, transfer: t, suspended: stock.suspended, parked: stock.parked },
      drilldownHref: '/admin/ai-provider#envoi-fichiers',
      conditionKey: CONDITION_KEY,
      fallbackDedupeKey: `ai:transfer:${new Date().toISOString().slice(0, 10)}`,
    });
  } catch { /* alerte best effort : jamais bloquante */ }
}

async function countSuspended(): Promise<{ suspended: number; parked: number }> {
  const rows = (await pgClient.unsafe(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE (payload->'aiSuspension'->>'parked')::boolean IS TRUE)::int AS parked
       FROM ai_job_queue
      WHERE treatment = 'T1' AND status = 'PENDING'
        AND payload->'aiSuspension'->>'cause' = ANY($1::text[])
        AND payload->'aiSuspension'->>'resumedAt' IS NULL`,
    [CAUSES] as never[],
  )) as unknown as Row[];
  return { suspended: Number(rows[0]?.n ?? 0), parked: Number(rows[0]?.parked ?? 0) };
}

export interface TransferBlockedDocument {
  fileId: number; accountId: number | null; jobId: number; cause: string; count: number; parked: boolean;
  historical: boolean; since: string | null; nextAttemptAt: string | null;
  transfer: Record<string, unknown> | null;
}

export interface TransferStock {
  suspended: number;
  parked: number;
  /** Documents historiques en échec identifiés, non encore rattachés (éligibilité de la file appliquée au rattachement). */
  historicalPending: number;
  documents: TransferBlockedDocument[];
}

/** Stock en attente technique pour un incident d'envoi (BO, recette). */
export async function transferBlockedStock(limit = 50): Promise<TransferStock> {
  if (!dbDisponible()) return { suspended: 0, parked: 0, historicalPending: 0, documents: [] };
  const c = await countSuspended();
  const rows = (await pgClient.unsafe(
    `SELECT id, target_id, account_id, available_at, payload->'aiSuspension' AS s
       FROM ai_job_queue
      WHERE treatment = 'T1' AND status = 'PENDING'
        AND payload->'aiSuspension'->>'cause' = ANY($1::text[])
        AND payload->'aiSuspension'->>'resumedAt' IS NULL
      ORDER BY id LIMIT $2`,
    [CAUSES, Math.min(Math.max(1, limit), 200)] as never[],
  )) as unknown as Row[];
  const historiques = await historicalCandidates(500).catch(() => []);
  return {
    suspended: c.suspended, parked: c.parked, historicalPending: historiques.length,
    documents: rows.map((r) => {
      const s = (typeof r.s === 'string' ? JSON.parse(r.s) : r.s ?? {}) as Record<string, unknown>;
      return {
        fileId: Number(r.target_id), accountId: r.account_id == null ? null : Number(r.account_id), jobId: Number(r.id),
        cause: String(s.cause ?? ''), count: Number(s.count ?? 0), parked: s.parked === true, historical: s.historical === true,
        since: typeof s.at === 'string' ? s.at : null,
        nextAttemptAt: r.available_at ? new Date(String(r.available_at)).toISOString() : null,
        transfer: s.transfer && typeof s.transfer === 'object' ? s.transfer as Record<string, unknown> : null,
      };
    }),
  };
}

/**
 * Documents HISTORIQUES en échec dont le DERNIER échec T1 est un incident
 * d'envoi au fournisseur, sans travail vivant, compte éligible. Deux formes :
 *   · lot 113R et suivants : étape `attachment_transfer`, famille d'accès ou
 *     d'indisponibilité (jamais un fichier refusé) ;
 *   · antérieures (réponse du fournisseur PERDUE, non reconstructible) :
 *     diagnostic `INTERNAL_ERROR / request_build` dont le message est celui
 *     de l'ancienne Files API (« Upload Files API échoué : HTTP 401/403/429/
 *     5xx », « Suivi du fichier Files API impossible : HTTP … ») — la seule
 *     trace conservée ; aucun détail n'est fabriqué rétroactivement.
 */
async function historicalCandidates(limit: number): Promise<Array<{ fileId: number; accountId: number; cause: string; legacy: boolean; transfer: Record<string, unknown> | null; message: string | null }>> {
  const { processingEligibleSql } = await import('@/services/account/processing-eligibility');
  const rows = (await pgClient.unsafe(
    `SELECT f.id, f.account_id, d.failure_stage, d.failure_family, d.diagnostic->'transfer' AS transfer,
            d.diagnostic->'error'->>'message' AS message
       FROM asset_files f
       JOIN LATERAL (
         SELECT x.failure_stage, x.failure_family, x.diagnostic FROM ai_call_diagnostics x
          WHERE x.source_ids @> ARRAY[f.id]::int[] AND x.call_kind = 'analysis' AND x.outcome = 'FAILED'
            AND x.operation_code LIKE 't1\\_%'
          ORDER BY x.id DESC LIMIT 1
       ) d ON TRUE
      WHERE f.analysis_state = 'ANALYSIS_FAILED' AND f.deleted_at IS NULL AND f.account_id IS NOT NULL
        AND (
          (d.failure_stage = 'attachment_transfer'
            AND (d.failure_family IN ('AUTH_ERROR', 'RATE_LIMIT', 'PROVIDER_ERROR', 'NETWORK_ERROR', 'TIMEOUT')
                 OR d.diagnostic->'transfer'->>'providerStatus' = 'FAILED_PRECONDITION')
            AND COALESCE(d.diagnostic->'transfer'->>'step', '') <> 'source_download'
            AND COALESCE(d.diagnostic->'transfer'->>'kind', '') <> 'activation_failed')
          OR (d.failure_stage = 'request_build' AND d.failure_family = 'INTERNAL_ERROR'
            AND (d.diagnostic->'error'->>'message') ~ '(Upload Files API échoué|Suivi du fichier Files API impossible) : HTTP (401|403|429|5[0-9][0-9])')
        )
        AND NOT EXISTS (SELECT 1 FROM ai_job_queue q WHERE q.treatment = 'T1' AND q.target_type = 'asset_file'
                         AND q.target_id = f.id::text AND q.status IN ('PENDING', 'RUNNING'))
        AND ${processingEligibleSql('f.account_id')}
      ORDER BY f.id LIMIT $1`,
    [limit] as never[],
  )) as unknown as Row[];
  return rows.map((r) => {
    const transfer = (typeof r.transfer === 'string' ? JSON.parse(r.transfer) : r.transfer) as Record<string, unknown> | null;
    const message = r.message == null ? null : String(r.message);
    const legacy = String(r.failure_stage) !== 'attachment_transfer';
    const status = transfer?.httpStatus ?? Number(/HTTP (\d{3})/.exec(message ?? '')?.[1] ?? NaN);
    const acces = String(r.failure_family) === 'AUTH_ERROR' || transfer?.providerStatus === 'FAILED_PRECONDITION' || status === 401 || status === 403;
    return { fileId: Number(r.id), accountId: Number(r.account_id), cause: acces ? 'TRANSFER_ACCESS_DENIED' : 'TRANSFER_UNAVAILABLE', legacy, transfer, message };
  });
}

/**
 * Rattache les documents historiques bloqués à la file durable (travail
 * SUSPENDU, en attente longue, non facturé, reprise de la même exécution
 * métier). Mêmes contrôles de compte que la reprise serveur (crédit
 * d'analyse disponible, plafond IA du mois non atteint). Rend le nombre de
 * documents rattachés.
 */
async function adoptHistorical(limit = 100): Promise<number> {
  const candidats = await historicalCandidates(limit);
  if (candidats.length === 0) return 0;
  const [{ canConsumeAnalysis }, { costCapReachedFor }, { enqueueFileAnalyses }, { maxAiSuspensions, transferParkRecheckSeconds }] = await Promise.all([
    import('@/services/commercial-model.service'), import('../gateway/account-cost-cap'),
    import('../source-analysis/queue/t1-handler'), import('../queue/queue-policy'),
  ]);
  const parCompte = new Map<number, typeof candidats>();
  for (const c of candidats) parCompte.set(c.accountId, [...(parCompte.get(c.accountId) ?? []), c]);
  let n = 0;
  const delai = transferParkRecheckSeconds();
  for (const [accountId, docs] of parCompte) {
    try {
      const gate = await canConsumeAnalysis(accountId, 1);
      if (!gate.allowed || await costCapReachedFor(accountId)) continue;
    } catch { continue; }
    for (const d of docs) {
      const at = new Date().toISOString();
      const acceptes = await enqueueFileAnalyses([d.fileId], accountId, {
        origin: TRANSFER_RECOVERY_ORIGIN, billable: false, resume: true, processingVisibility: 'TECHNICAL',
        delaySeconds: delai,
        aiSuspension: {
          cause: d.cause, at, count: maxAiSuspensions(), until: new Date(Date.now() + delai * 1000).toISOString(),
          revisionId: null, resumedAt: null, decisions: [], parked: true, historical: true,
          message: d.legacy
            ? 'Document historique bloqué par un incident d’envoi au fournisseur (réponse du fournisseur non conservée à l’époque) — réexamen automatique après rétablissement vérifié.'
            : 'Document historique bloqué par un incident d’envoi au fournisseur — réexamen automatique après rétablissement vérifié.',
          ...(d.transfer ? { transfer: d.transfer } : { transfer: { legacyMessage: d.message, providerDetail: 'NOT_RETAINED_HISTORICALLY' } }),
        },
      }).catch(() => [] as number[]);
      n += acceptes.length;
    }
  }
  return n;
}

async function lastCheck(): Promise<{ id: number; at: number; ok: boolean } | null> {
  try {
    const rows = (await pgClient.unsafe(
      `SELECT id, created_at, ok FROM ai_provider_transfer_checks ORDER BY id DESC LIMIT 1`,
    )) as unknown as Row[];
    const r = rows[0];
    return r ? { id: Number(r.id), at: new Date(String(r.created_at)).getTime(), ok: Boolean(r.ok) } : null;
  } catch {
    return null;
  }
}

async function t1StateChangedAt(): Promise<number | null> {
  try {
    const rows = (await pgClient.unsafe(`SELECT updated_at FROM ai_treatment_state WHERE treatment = 'T1' LIMIT 1`)) as unknown as Row[];
    return rows[0]?.updated_at ? new Date(String(rows[0].updated_at)).getTime() : null;
  } catch {
    return null;
  }
}

/** Libère les travaux suspendus pour incident d'envoi (prochaine prise échelonnée). Rend leurs identifiants. */
async function releaseSuspended(checkId: number | null): Promise<number[]> {
  const rows = (await pgClient.unsafe(
    `WITH c AS (
       SELECT id, row_number() OVER (ORDER BY id) AS rn FROM ai_job_queue
        WHERE treatment = 'T1' AND status = 'PENDING'
          AND payload->'aiSuspension'->>'cause' = ANY($1::text[])
          AND payload->'aiSuspension'->>'resumedAt' IS NULL
          AND available_at > NOW()
     )
     UPDATE ai_job_queue q
        SET available_at = NOW() + (((c.rn - 1) * $2)::text || ' seconds')::interval,
            payload = jsonb_set(jsonb_set(q.payload, '{aiSuspension,releasedAt}', to_jsonb(NOW()::text)),
                                '{aiSuspension,releasedByCheckId}', to_jsonb($3::bigint))
       FROM c WHERE q.id = c.id
     RETURNING q.id`,
    [CAUSES, releaseStaggerSeconds(), checkId ?? 0] as never[],
  )) as unknown as Row[];
  return rows.map((r) => Number(r.id));
}

async function resolveTransferAlert(reason: string): Promise<void> {
  try {
    const { listAlerts, resolveAlerts } = await import('../alerts/alerts.repository');
    const ouvertes = await listAlerts({ status: 'open', codes: [TRANSFER_ALERT_CODE], limit: 20 });
    await resolveAlerts(ouvertes.map((a) => a.id), { code: 'TRANSFER_RESTORED', reason });
  } catch { /* best effort */ }
}

export interface TransferReexamination {
  adopted: number;
  suspended: number;
  probed: boolean;
  probeOk: boolean | null;
  checkId: number | null;
  released: number;
  /** Motif quand rien n'a été tenté (`no_stock`, `recent_check_failed`…). */
  skipped: string | null;
}

/**
 * Un tour de réexamen (reprise serveur). Ne lève jamais. `force` : sonde
 * immédiate (BO). Les documents ne sont libérés que sur une vérification
 * d'envoi RÉUSSIE (rétablissement vérifié).
 */
export async function reexamineTransferBlocked(opts: { force?: boolean } = {}): Promise<TransferReexamination> {
  const r: TransferReexamination = { adopted: 0, suspended: 0, probed: false, probeOk: null, checkId: null, released: 0, skipped: null };
  if (!dbDisponible()) return { ...r, skipped: 'no_database' };
  try {
    const { purgeOldTransferChecks, runTransferProbe } = await import('./transfer-probe');
    await purgeOldTransferChecks();
    r.adopted = await adoptHistorical().catch((e) => {
      console.warn('[transfer-recovery] rattachement des documents historiques impossible :', String((e as Error).message).slice(0, 200));
      return 0;
    });
    r.suspended = (await countSuspended()).suspended;
    if (r.suspended === 0) return { ...r, skipped: 'no_stock' };

    const last = await lastCheck();
    const changed = await t1StateChangedAt();
    const recent = last !== null && Date.now() - last.at < transferProbeMinIntervalMs();
    const reactivationDepuis = changed !== null && last !== null && changed > last.at;
    let ok: boolean;
    if (recent && !reactivationDepuis && !opts.force) {
      // Vérification récente (sonde ou test BO) : réutilisée, aucune sonde de plus.
      if (!last!.ok) return { ...r, skipped: 'recent_check_failed', checkId: last!.id, probeOk: false };
      ok = true;
      r.checkId = last!.id;
    } else {
      const probe = await runTransferProbe({ origin: 'auto_probe' });
      r.probed = true;
      r.checkId = probe.id;
      ok = probe.ok;
      if (!ok) {
        // Incident TOUJOURS présent (y compris après une réactivation de T1) : il reste visible.
        await noteTransferIncident({
          cause: probe.failure?.httpStatus === 401 || probe.failure?.httpStatus === 403 ? 'TRANSFER_ACCESS_DENIED' : 'TRANSFER_UNAVAILABLE',
          parked: false, jobId: 0, transfer: probe.failure ? { ...probe.failure, source: 'auto_probe', checkId: probe.id } : { localError: probe.localError },
        });
      }
    }
    r.probeOk = ok;
    if (!ok) return r;
    const ids = await releaseSuspended(r.checkId);
    r.released = ids.length;
    await resolveTransferAlert(`Envoi de fichier vérifié avec succès (vérification n° ${r.checkId ?? '?'}) : ${ids.length} document(s) remis en analyse.`);
    if (ids.length > 0) {
      const { nudgeQueueWorker } = await import('../queue/queue-worker');
      nudgeQueueWorker();
    }
    console.info(JSON.stringify({ event: 'ai.transfer.restored', checkId: r.checkId, released: ids.length, adopted: r.adopted }));
    return r;
  } catch (e) {
    console.warn('[transfer-recovery] réexamen impossible (non bloquant) :', String((e as Error).message).slice(0, 200));
    return { ...r, skipped: 'error' };
  }
}
