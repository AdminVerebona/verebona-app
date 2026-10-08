/**
 * Rejeu automatique des documents en échec INVALID_OUTPUT — lot 33D (ticket
 * « réussite malgré les désalignements », §29, §30, cas 8).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * APRÈS LE DÉPLOIEMENT D'UN CORRECTIF, SANS ACTION DE L'UTILISATEUR
 *
 * Tâche planifiée interne `t1-invalid-output-replay` (au démarrage, puis
 * toutes les heures tant qu'il reste du travail) :
 *   1. clôt les rejeux précédents d'après l'état du document (analysé →
 *      SUCCEEDED ; de nouveau en échec → FAILED_AGAIN, nouvelle signature) ;
 *   2. retrouve les documents `ANALYSIS_FAILED` dont l'échec est une sortie
 *      invalide de FORME — d'après leur diagnostic (`ai_call_diagnostics`),
 *      ou, pour les échecs antérieurs au lot 33, d'après le motif enregistré
 *      (« Sortie non conforme au schéma… ») ;
 *   3. les remet dans la file T1 EXISTANTE (`enqueueFileAnalyses`), au plus
 *      `MAX_PER_RUN` par passage.
 *
 * Bornes et idempotence :
 *   · un rejeu par document ET par version de résolution
 *     (`OUTPUT_RESOLUTION_VERSION`, contrainte unique 0285) — relancer la
 *     tâche, ou la lancer sur deux instances, ne crée aucun second rejeu ;
 *   · une signature que la version courante ne résout pas (3 rejeux de
 *     nouveau en échec sur la même signature, aucun succès) n'est plus
 *     rejouée : les documents restants sont marqués SKIPPED ;
 *   · sorties tronquées et réponses vides exclues (l'information manque :
 *     ce n'est pas un défaut de forme) ;
 *   · l'analyse elle-même est idempotente (faits, échéances et liaisons
 *     remplacés, jamais dupliqués — même chemin qu'une relance utilisateur),
 *     et le job T1 borne ses reprises (failure-policy : 2 échecs au plus).
 *
 * Variable : `AI_INVALID_OUTPUT_REPLAY=off` arrête le rejeu (la tâche reste
 * listée). Arrêt de la tâche : `SCHEDULED_TASK_T1_INVALID_OUTPUT_REPLAY=off`.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'crypto';

/**
 * Version de la résolution des sorties. À INCRÉMENTER à chaque correctif qui
 * rend exploitables des sorties auparavant rejetées : les documents en échec
 * seront rejoués une fois avec la nouvelle version.
 */
export const OUTPUT_RESOLUTION_VERSION = '33d.1';

export const MAX_PER_RUN = 25;
/** Rejeux de nouveau en échec sur une même signature au-delà desquels elle n'est plus rejouée. */
export const UNRESOLVED_SIGNATURE_THRESHOLD = 3;

type Row = Record<string, unknown>;

/** Motifs d'échec (texte enregistré sur le document) d'une sortie invalide de FORME. */
const LEGACY_FORMAT_REASON = /(Sortie non conforme au sch[ée]ma|Sortie non parsable|Sortie de la branche|INVALID_OUTPUT)/;
/** Motifs d'une sortie incomplète (tronquée, vide) : jamais rejoués. */
const LEGACY_INCOMPLETE_REASON = /(Structure JSON incompl[èe]te|Sortie tronqu[ée]e|r[ée]ponse vide|Aucune structure JSON)/i;

/**
 * Signature d'un échec antérieur au lot 33, tirée du motif enregistré :
 * chemins et messages du validateur, sans indices ni valeurs. Pure.
 */
export function legacySignature(reason: string): string {
  const coeur = reason
    .replace(/^[\s\S]*?Sortie non conforme au sch[ée]ma[^.]*\.\s*/, '')
    .replace(/Extrait\s*:[\s\S]*$/, '')
    .replace(/\.\d+(?=\.|\s|:)/g, '.*')
    .replace(/\d+/g, '#')
    .slice(0, 400);
  return createHash('sha256').update(`legacy|${coeur}`).digest('hex').slice(0, 16);
}

export interface ReplayCandidate {
  fileId: number;
  accountId: number;
  failReason: string | null;
  family: string | null;
  subtype: string | null;
  signature: string | null;
}

export type ReplayDecision =
  | { replay: true; signature: string; source: 'diagnostic' | 'fail_reason' }
  | { replay: false; reason: string; signature: string | null; source: 'diagnostic' | 'fail_reason' };

/** Le document doit-il être rejoué ? Pure (testée). */
export function decideReplay(c: ReplayCandidate, unresolved: ReadonlySet<string>): ReplayDecision {
  if (c.family) {
    const sig = c.signature ?? `${c.family}|${c.subtype ?? ''}`;
    if (c.family !== 'INVALID_OUTPUT') return { replay: false, reason: `échec ${c.family} (pas une sortie invalide)`, signature: sig, source: 'diagnostic' };
    if (c.subtype === 'OUTPUT_TRUNCATED' || c.subtype === 'EMPTY_RESPONSE') {
      return { replay: false, reason: `sortie incomplète (${c.subtype}) : pas un défaut de forme`, signature: sig, source: 'diagnostic' };
    }
    if (unresolved.has(sig)) return { replay: false, reason: 'signature non résolue par cette version', signature: sig, source: 'diagnostic' };
    return { replay: true, signature: sig, source: 'diagnostic' };
  }
  const reason = c.failReason ?? '';
  const sig = legacySignature(reason);
  if (!LEGACY_FORMAT_REASON.test(reason)) return { replay: false, reason: 'motif d’échec hors sortie invalide', signature: sig, source: 'fail_reason' };
  if (LEGACY_INCOMPLETE_REASON.test(reason)) return { replay: false, reason: 'sortie incomplète (tronquée ou vide)', signature: sig, source: 'fail_reason' };
  if (unresolved.has(sig)) return { replay: false, reason: 'signature non résolue par cette version', signature: sig, source: 'fail_reason' };
  return { replay: true, signature: sig, source: 'fail_reason' };
}

export function replayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(off|false|0|no|disabled)$/i.test((env.AI_INVALID_OUTPUT_REPLAY ?? '').trim());
}

export interface ReplayRunResult {
  version: string;
  closed: { succeeded: number; failedAgain: number };
  examined: number;
  enqueued: number;
  skipped: number;
  /** Rejeux encore en cours (documents en file ou en analyse). */
  pending: number;
  /** Il reste des candidats au-delà de la borne du passage. */
  more: boolean;
  disabled?: boolean;
}

async function tablesReady(): Promise<boolean> {
  const { pgClient } = await import('@/db');
  const r = (await pgClient.unsafe(
    `SELECT to_regclass('ai_output_replays') IS NOT NULL AS replays, to_regclass('ai_call_diagnostics') IS NOT NULL AS diags`,
  )) as unknown as Row[];
  return Boolean(r[0]?.replays) && Boolean(r[0]?.diags);
}

export async function runInvalidOutputReplay(opts: { maxPerRun?: number; version?: string } = {}): Promise<ReplayRunResult> {
  const version = opts.version ?? OUTPUT_RESOLUTION_VERSION;
  const max = Math.max(1, Math.min(opts.maxPerRun ?? MAX_PER_RUN, 200));
  const res: ReplayRunResult = { version, closed: { succeeded: 0, failedAgain: 0 }, examined: 0, enqueued: 0, skipped: 0, pending: 0, more: false };
  if (!replayEnabled()) return { ...res, disabled: true };
  if (!(await tablesReady())) return res;
  const { pgClient } = await import('@/db');

  // ── 1. Clôture des rejeux précédents, d'après l'état du document ─────────
  const clos = (await pgClient.unsafe(
    `UPDATE ai_output_replays r
        SET status = CASE WHEN f.analysis_state = 'ANALYSIS_FAILED' THEN 'FAILED_AGAIN' ELSE 'SUCCEEDED' END,
            detail = CASE WHEN f.analysis_state = 'ANALYSIS_FAILED' THEN left(f.analysis_fail_reason, 300) ELSE f.analysis_state END,
            updated_at = NOW()
       FROM asset_files f
      WHERE r.file_id = f.id AND r.resolution_version = $1 AND r.status = 'ENQUEUED'
        AND f.analysis_state IS DISTINCT FROM 'UPLOADED' AND f.analysis_state IS DISTINCT FROM 'ANALYZING'
        AND NOT EXISTS (SELECT 1 FROM ai_job_queue j WHERE j.treatment = 'T1' AND j.target_type = 'asset_file'
                         AND j.target_id = f.id::text AND j.status IN ('PENDING', 'RUNNING'))
      RETURNING r.status`,
    [version] as never[],
  )) as unknown as Row[];
  res.closed.succeeded = clos.filter((x) => x.status === 'SUCCEEDED').length;
  res.closed.failedAgain = clos.filter((x) => x.status === 'FAILED_AGAIN').length;

  // Signatures que cette version ne résout pas : jamais rejouées à nouveau.
  const nonResolues = (await pgClient.unsafe(
    `SELECT signature FROM ai_output_replays
      WHERE resolution_version = $1 AND signature IS NOT NULL
      GROUP BY signature
     HAVING COUNT(*) FILTER (WHERE status = 'FAILED_AGAIN') >= $2
        AND COUNT(*) FILTER (WHERE status = 'SUCCEEDED') = 0`,
    [version, UNRESOLVED_SIGNATURE_THRESHOLD] as never[],
  )) as unknown as Row[];
  const unresolved = new Set(nonResolues.map((x) => String(x.signature)));

  // ── 2. Candidats : échecs non encore rejoués pour cette version ──────────
  const rows = (await pgClient.unsafe(
    `SELECT f.id, f.account_id, f.analysis_fail_reason,
            d.failure_family, d.failure_subtype, d.signature
       FROM asset_files f
       LEFT JOIN LATERAL (
         SELECT failure_family, failure_subtype, signature FROM ai_call_diagnostics x
          WHERE x.outcome = 'FAILED' AND x.call_kind = 'analysis' AND x.source_ids @> ARRAY[f.id]
          ORDER BY x.id DESC LIMIT 1) d ON TRUE
      WHERE f.analysis_state = 'ANALYSIS_FAILED' AND f.deleted_at IS NULL AND f.account_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM ai_output_replays r WHERE r.file_id = f.id AND r.resolution_version = $1)
        AND (d.failure_family IS NOT NULL OR f.analysis_fail_reason ~ $2)
      ORDER BY f.id
      LIMIT $3`,
    [version, LEGACY_FORMAT_REASON.source, max + 1] as never[],
  )) as unknown as Row[];
  res.more = rows.length > max;

  const { enqueueFileAnalyses } = await import('./queue/t1-handler');
  for (const r of rows.slice(0, max)) {
    res.examined++;
    const c: ReplayCandidate = {
      fileId: Number(r.id), accountId: Number(r.account_id), failReason: r.analysis_fail_reason == null ? null : String(r.analysis_fail_reason),
      family: r.failure_family == null ? null : String(r.failure_family),
      subtype: r.failure_subtype == null ? null : String(r.failure_subtype),
      signature: r.signature == null ? null : String(r.signature),
    };
    const d = decideReplay(c, unresolved);
    // Réservation AVANT la mise en file : la contrainte unique (0285) garantit
    // un seul rejeu, même avec deux instances.
    const reserve = (await pgClient.unsafe(
      `INSERT INTO ai_output_replays (file_id, account_id, resolution_version, signature, failure_source, status, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (file_id, resolution_version) DO NOTHING RETURNING id`,
      [c.fileId, c.accountId, version, d.signature, d.source, d.replay ? 'ENQUEUED' : 'SKIPPED', d.replay ? null : d.reason] as never[],
    )) as unknown as Row[];
    if (reserve.length === 0) continue;
    if (!d.replay) { res.skipped++; continue; }
    const acceptes = await enqueueFileAnalyses([c.fileId], c.accountId, { origin: 't1-invalid-output-replay' }).catch(() => [] as number[]);
    if (acceptes.includes(c.fileId)) {
      res.enqueued++;
    } else {
      // Refus de mise en file (déjà en file, déclencheur…) : constaté, sans rejeu.
      await pgClient.unsafe(
        `UPDATE ai_output_replays SET status = 'SKIPPED', detail = 'mise en file refusée ou déjà en file', updated_at = NOW() WHERE id = $1`,
        [Number(reserve[0].id)] as never[],
      );
      res.skipped++;
    }
  }

  const pend = (await pgClient.unsafe(
    `SELECT COUNT(*)::int AS n FROM ai_output_replays WHERE resolution_version = $1 AND status = 'ENQUEUED'`,
    [version] as never[],
  )) as unknown as Row[];
  res.pending = Number(pend[0]?.n ?? 0);
  return res;
}
