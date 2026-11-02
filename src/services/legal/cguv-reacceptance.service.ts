/**
 * Réacceptation des CGUV — lot 102B (règles : `lib/legal/reacceptance-gate`).
 *
 * Une réacceptation est due quand la DERNIÈRE version substantielle entrée en
 * vigueur (`requires_reacceptance`, version courante ou archivée, date d'effet
 * passée) n'a été acceptée par l'utilisateur ni elle-même ni via une version
 * publiée après elle. Une version non substantielle ne déclenche jamais rien.
 *
 * Jamais de blocage abusif : base injoignable → pas de blocage (journalisé) ;
 * manifeste du site public jamais lu (site pas encore livré) → aucune
 * réacceptation exigée.
 * Seul un « non requis » est mis en cache (60 s par instance) : après une
 * acceptation, aucune instance ne continue de refuser à tort.
 */
import { pgClient } from '@/db';
import { serverCacheDelete, serverCacheGet, serverCacheSet } from '@/lib/server-cache';
import type { AcceptanceChannel } from '@/lib/legal/public-legal';
import { NO_REACCEPTANCE, type ReacceptanceState } from '@/lib/legal/reacceptance-gate';
import { recordAcceptance } from './legal-acceptances.service';
import { getPublicCurrentCguv } from './cguv-referential.service';

/** Durée de cache d'un « réacceptation non requise » (par instance). */
export const REACCEPTANCE_NOT_REQUIRED_CACHE_MS = 60_000;

const cacheKey = (userId: number) => `legal-gate:v1:${userId}`;

interface GateRow { substantial_code: string; accepted: boolean }

/** Version substantielle en attente d'acceptation par cet utilisateur, ou null. */
async function pendingSubstantialVersion(userId: number): Promise<string | null> {
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
           EXISTS (
             SELECT 1
               FROM legal_acceptances la
               JOIN legal_document_versions v ON v.id = la.legal_document_version_id
              WHERE la.user_id = ${userId}
                AND v.document_type = 'CGVU'
                AND v.published_at >= s.published_at
                AND la.acceptance_context <> 'IMMEDIATE_START_REQUEST'
           ) AS accepted
      FROM s`;
  const r = rows[0];
  return r && !r.accepted ? r.substantial_code : null;
}

/** État complet (écran dédié, `/api/users/me`). Ne lève jamais. */
export async function getReacceptanceState(userId: number): Promise<ReacceptanceState> {
  try {
    const pending = await pendingSubstantialVersion(userId);
    if (!pending) return NO_REACCEPTANCE;
    const current = await getPublicCurrentCguv();
    if (!current) return NO_REACCEPTANCE;
    return {
      required: true,
      versionCode: current.versionCode,
      permalinkUrl: current.permalinkUrl,
      changeSummary: current.changeSummary,
      effectiveAt: current.effectiveAt ? current.effectiveAt.toISOString() : null,
      substantialVersionCode: pending,
    };
  } catch (e) {
    console.error('[legal] état de réacceptation illisible (aucun blocage) :', (e as Error).message);
    return NO_REACCEPTANCE;
  }
}

/** Écriture métier refusée ? (garde de session). Ne lève jamais. */
export async function isReacceptanceRequired(userId: number): Promise<boolean> {
  if (serverCacheGet<boolean>(cacheKey(userId)) === false) return false;
  try {
    const pending = await pendingSubstantialVersion(userId);
    if (!pending) serverCacheSet(cacheKey(userId), false, REACCEPTANCE_NOT_REQUIRED_CACHE_MS);
    return pending !== null;
  } catch (e) {
    console.error('[legal] contrôle de réacceptation impossible (aucun blocage) :', (e as Error).message);
    return false;
  }
}

export function forgetReacceptanceCache(userId: number): void {
  serverCacheDelete(cacheKey(userId));
}

export type AcceptCurrentResult =
  | { ok: true; versionCode: string; permalinkUrl: string; textSha256: string | null; acceptedAt: Date; alreadyRecorded: boolean }
  | { ok: false; code: 'NO_CURRENT_VERSION' | 'VERSION_CHANGED'; current?: { versionCode: string; permalinkUrl: string } };

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
