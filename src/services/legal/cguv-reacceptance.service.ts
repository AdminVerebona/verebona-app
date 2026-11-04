/**
 * Réacceptation des CGUV — lot 102B (règles : `lib/legal/reacceptance-gate`),
 * fiabilisée au lot 104A (P1-E).
 *
 * Une réacceptation est due quand la DERNIÈRE version substantielle entrée en
 * vigueur (`requires_reacceptance`, version courante ou archivée, date d'effet
 * passée) n'a été acceptée par l'utilisateur ni elle-même ni via une version
 * publiée après elle. Une version non substantielle ne déclenche jamais rien.
 * Manifeste du site public jamais lu (site pas encore livré) → aucune
 * réacceptation exigée (phase de transition, lot 102B).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 104A — TROIS ISSUES, JAMAIS D'ACCEPTATION IMPLICITE
 *
 *   · `not_required` : rien à accepter → aucune restriction ;
 *   · `required`     : écran dédié, écritures métier refusées (403
 *                      CGUV_REACCEPTANCE_REQUIRED) jusqu'à l'acceptation ;
 *   · `unavailable`  : contrôle IMPOSSIBLE (base injoignable, ou version
 *                      substantielle due sans version en vigueur à présenter)
 *                      → écritures métier refusées TEMPORAIREMENT (503
 *                      CGUV_CHECK_UNAVAILABLE), Supervision, journal. Avant le
 *                      lot 104A, ce cas valait « non requis » : une version
 *                      substantielle ne protégeait plus rien pendant la panne.
 * Les accès indispensables (lecture, export RGPD, déconnexion, textes,
 * acceptation, résiliation, rétractation, suppression, sécurité, BO) restent
 * ouverts dans tous les cas : la garde n'est appelée que pour les écritures
 * hors liste d'autorisation (`isApiAllowedDuringReacceptance`).
 *
 * Cache : seul un « non requis » est mis en cache (par instance), au plus
 * REACCEPTANCE_NOT_REQUIRED_CACHE_MS et jamais au-delà de l'entrée en
 * vigueur de la prochaine version substantielle connue. Il est oublié à
 * l'acceptation (`forgetReacceptanceCache`) et à toute évolution du
 * référentiel (`onCguvReferentialChanged` : import, activation, saisie BO) —
 * les autres instances suivent au plus tard à l'expiration.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { serverCacheDelete, serverCacheGet, serverCacheSet } from '@/lib/server-cache';
import type { AcceptanceChannel } from '@/lib/legal/public-legal';
import {
  CGUV_CHECK_UNAVAILABLE_CODE, NO_REACCEPTANCE, REACCEPTANCE_UNAVAILABLE, type ReacceptanceState,
} from '@/lib/legal/reacceptance-gate';
import { recordAcceptance } from './legal-acceptances.service';
import { getPublicCurrentCguv } from './cguv-referential.service';

/** Durée de cache d'un « réacceptation non requise » (par instance). */
export const REACCEPTANCE_NOT_REQUIRED_CACHE_MS = 60_000;
/** Intervalle minimal entre deux signalements Supervision « contrôle impossible » (par instance). */
export const REACCEPTANCE_UNAVAILABLE_REPORT_INTERVAL_MS = 5 * 60_000;
export const REACCEPTANCE_UNAVAILABLE_FINGERPRINT = 'other:legal-reacceptance:unavailable';

/** Génération du référentiel (par instance) : changée à chaque évolution, elle invalide tous les « non requis ». */
let referentialGeneration = 0;
const cacheKey = (userId: number) => `legal-gate:v2:${referentialGeneration}:${userId}`;

export type ReacceptanceDecision =
  | { status: 'not_required' }
  | { status: 'required'; substantialVersionCode: string }
  | { status: 'unavailable'; reason: 'CHECK_FAILED' | 'NO_CURRENT_VERSION'; detail: string };

interface GateRow {
  substantial_code: string | null;
  accepted: boolean | null;
  has_current: boolean;
  next_effective_at: Date | string | null;
}

/** Lecture unique : version substantielle due, acceptation, version en vigueur, prochaine entrée en vigueur. */
async function readGate(userId: number): Promise<GateRow> {
  const rows = await pgClient<GateRow[]>`
    WITH s AS (
      SELECT version_code, published_at
        FROM legal_document_versions
       WHERE document_type = 'CGVU'
         AND requires_reacceptance
         AND status IN ('CURRENT', 'ARCHIVED')
         AND COALESCE(effective_at, published_at) <= now()
         -- Tant que le manifeste du site public n'a jamais été lu : aucune
         -- réacceptation exigée (phase de transition, lot 102B).
         AND EXISTS (SELECT 1 FROM legal_manifest_sync_state m
                      WHERE m.document_type = 'CGVU' AND m.last_success_at IS NOT NULL)
       ORDER BY published_at DESC NULLS LAST
       LIMIT 1
    )
    SELECT s.version_code AS substantial_code,
           CASE WHEN s.version_code IS NULL THEN NULL ELSE EXISTS (
             SELECT 1
               FROM legal_acceptances la
               JOIN legal_document_versions v ON v.id = la.legal_document_version_id
              WHERE la.user_id = ${userId}
                AND v.document_type = 'CGVU'
                AND v.published_at >= s.published_at
                AND la.acceptance_context <> 'IMMEDIATE_START_REQUEST'
           ) END AS accepted,
           EXISTS (SELECT 1 FROM legal_document_versions c WHERE c.document_type = 'CGVU' AND c.status = 'CURRENT') AS has_current,
           (SELECT min(COALESCE(n.effective_at, n.published_at))
              FROM legal_document_versions n
             WHERE n.document_type = 'CGVU' AND n.requires_reacceptance
               AND n.status IN ('CURRENT', 'ARCHIVED', 'PUBLISHED')
               AND COALESCE(n.effective_at, n.published_at) > now()) AS next_effective_at
      FROM (SELECT 1) AS one
      LEFT JOIN s ON true`;
  return rows[0] ?? { substantial_code: null, accepted: null, has_current: false, next_effective_at: null };
}

/** Pur : décision à partir de la lecture. Version due sans version en vigueur → contrôle impossible (rien de fiable à présenter). */
export function decideReacceptance(row: Pick<GateRow, 'substantial_code' | 'accepted' | 'has_current'>): ReacceptanceDecision {
  if (!row.substantial_code || row.accepted === true) return { status: 'not_required' };
  if (!row.has_current) {
    return { status: 'unavailable', reason: 'NO_CURRENT_VERSION', detail: `version substantielle ${row.substantial_code} due mais aucune version des CGUV en vigueur à présenter` };
  }
  return { status: 'required', substantialVersionCode: row.substantial_code };
}

/** Pur : durée de cache d'un « non requis » — jamais au-delà de la prochaine entrée en vigueur substantielle. */
export function notRequiredCacheMs(nextEffectiveAt: Date | string | null, now: number = Date.now()): number {
  if (!nextEffectiveAt) return REACCEPTANCE_NOT_REQUIRED_CACHE_MS;
  const at = new Date(nextEffectiveAt).getTime();
  if (Number.isNaN(at)) return REACCEPTANCE_NOT_REQUIRED_CACHE_MS;
  return Math.max(0, Math.min(REACCEPTANCE_NOT_REQUIRED_CACHE_MS, at - now));
}

/* ── Supervision du « contrôle impossible » (regroupée, limitée) ─────────── */

let lastUnavailableReportAt = 0;
let unavailableOpen = false;
let supervisionInFlight: Promise<void> = Promise.resolve();

function superviseUnavailable(userId: number, d: Extract<ReacceptanceDecision, { status: 'unavailable' }>): void {
  // Journal sans secret : identifiant interne, code stable, cause technique courte.
  console.error(`[legal] ${CGUV_CHECK_UNAVAILABLE_CODE} utilisateur=${userId} cause=${d.reason} — ${d.detail.slice(0, 200)} (écritures métier suspendues)`);
  const now = Date.now();
  if (unavailableOpen && now - lastUnavailableReportAt < REACCEPTANCE_UNAVAILABLE_REPORT_INTERVAL_MS) return;
  lastUnavailableReportAt = now;
  unavailableOpen = true;
  supervisionInFlight = (async () => {
    try {
      const { reportAnomaly } = await import('@/services/admin/anomaly.service');
      await reportAnomaly({
        domain: 'other',
        fingerprint: REACCEPTANCE_UNAVAILABLE_FINGERPRINT,
        title: 'CGUV : contrôle de réacceptation impossible — écritures des utilisateurs suspendues',
        detail: {
          code: CGUV_CHECK_UNAVAILABLE_CODE,
          cause: d.reason,
          detail: d.detail.slice(0, 300),
          effet: 'Les écritures métier sont refusées temporairement (503). Lecture, export RGPD, déconnexion, lecture des CGUV, acceptation, résiliation, rétractation et suppression restent possibles.',
          action: d.reason === 'NO_CURRENT_VERSION'
            ? 'Aucune version des CGUV en vigueur : BO › CGUV › « Relire le manifeste » (ou saisie de secours).'
            : 'Vérifier la base de données ; l’alerte se résout seule au premier contrôle réussi.',
        },
      });
    } catch { /* base injoignable : le journal console suffit */ }
  })();
}

function superviseRecovered(): void {
  if (!unavailableOpen) return;
  unavailableOpen = false;
  supervisionInFlight = (async () => {
    try {
      const { autoResolveAnomaly } = await import('@/services/admin/anomaly.service');
      await autoResolveAnomaly(REACCEPTANCE_UNAVAILABLE_FINGERPRINT, { origin: 'legal_reacceptance_gate', cause: 'contrôle de réacceptation de nouveau possible' });
    } catch { /* sans effet */ }
  })();
}

/** Tests : attend la fin du dernier signalement Supervision. */
export function flushReacceptanceSupervision(): Promise<void> {
  return supervisionInFlight;
}

/* ── API ─────────────────────────────────────────────────────────────────── */

/** Contrôle complet (garde et écran). Ne lève jamais. */
export async function checkReacceptance(userId: number, opts: { useCache?: boolean } = {}): Promise<ReacceptanceDecision> {
  if (opts.useCache !== false && serverCacheGet<boolean>(cacheKey(userId)) === false) return { status: 'not_required' };
  let decision: ReacceptanceDecision;
  let next: GateRow['next_effective_at'] = null;
  try {
    const row = await readGate(userId);
    next = row.next_effective_at;
    decision = decideReacceptance(row);
  } catch (e) {
    decision = { status: 'unavailable', reason: 'CHECK_FAILED', detail: (e as Error).message.replace(/\s+/g, ' ').slice(0, 200) };
  }
  if (decision.status === 'unavailable') {
    superviseUnavailable(userId, decision);
    return decision;
  }
  superviseRecovered();
  if (decision.status === 'not_required') {
    const ttl = notRequiredCacheMs(next);
    if (ttl > 0) serverCacheSet(cacheKey(userId), false, ttl);
  }
  return decision;
}

/**
 * Écriture métier à refuser ? (garde de session) `true` = réacceptation
 * requise, `false` = non requise. LÈVE `CGUV_CHECK_UNAVAILABLE` si le
 * contrôle est impossible : jamais un faux « non requis » (lot 104A).
 */
export async function isReacceptanceRequired(userId: number): Promise<boolean> {
  const d = await checkReacceptance(userId);
  if (d.status === 'unavailable') throw new Error(CGUV_CHECK_UNAVAILABLE_CODE);
  return d.status === 'required';
}

/** État complet (écran dédié, `/api/users/me`). Ne lève jamais. */
export async function getReacceptanceState(userId: number): Promise<ReacceptanceState> {
  const d = await checkReacceptance(userId, { useCache: false });
  if (d.status === 'not_required') return NO_REACCEPTANCE;
  if (d.status === 'unavailable') return REACCEPTANCE_UNAVAILABLE;
  try {
    const current = await getPublicCurrentCguv();
    if (!current) return REACCEPTANCE_UNAVAILABLE;
    return {
      required: true,
      status: 'required',
      versionCode: current.versionCode,
      permalinkUrl: current.permalinkUrl,
      changeSummary: current.changeSummary,
      effectiveAt: current.effectiveAt ? current.effectiveAt.toISOString() : null,
      substantialVersionCode: d.substantialVersionCode,
    };
  } catch (e) {
    superviseUnavailable(userId, { status: 'unavailable', reason: 'CHECK_FAILED', detail: (e as Error).message.slice(0, 200) });
    return REACCEPTANCE_UNAVAILABLE;
  }
}

export function forgetReacceptanceCache(userId: number): void {
  serverCacheDelete(cacheKey(userId));
}

/** Référentiel modifié (import, activation, saisie BO) : plus aucun « non requis » servi depuis le cache de cette instance. */
export function onCguvReferentialChanged(): void {
  referentialGeneration += 1;
}

export type AcceptCurrentResult =
  | { ok: true; versionCode: string; permalinkUrl: string; textSha256: string | null; acceptedAt: Date; alreadyRecorded: boolean }
  | { ok: false; code: 'NO_CURRENT_VERSION' | 'VERSION_CHANGED' | 'CGUV_PUBLIC_TEXT_UNAVAILABLE'; current?: { versionCode: string; permalinkUrl: string | null } };

/**
 * Acceptation explicite de la version EN VIGUEUR (celle affichée à l'écran,
 * §18) : contexte VERSION_UPDATE (réacceptation), canal, preuve complète.
 */
export async function acceptCurrentCguv(input: {
  userId: number;
  presentedVersionCode: string;
  channel: AcceptanceChannel;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<AcceptCurrentResult> {
  const current = await getPublicCurrentCguv();
  if (!current) return { ok: false, code: 'NO_CURRENT_VERSION' };
  if (current.versionCode !== input.presentedVersionCode) {
    return { ok: false, code: 'VERSION_CHANGED', current: { versionCode: current.versionCode, permalinkUrl: current.permalinkUrl } };
  }
  // Lot 108L : jamais d'acceptation d'un texte non consultable sur le site public.
  if (current.publicText !== 'VERIFIED') return { ok: false, code: 'CGUV_PUBLIC_TEXT_UNAVAILABLE' };
  const proof = await recordAcceptance({
    userId: input.userId,
    versionCode: current.versionCode,
    context: 'VERSION_UPDATE',
    channel: input.channel,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  });
  forgetReacceptanceCache(input.userId);
  return {
    ok: true, versionCode: proof.versionCode, permalinkUrl: proof.permalinkUrl, textSha256: proof.textSha256,
    acceptedAt: proof.acceptedAt, alreadyRecorded: proof.alreadyRecorded,
  };
}
