/**
 * Supervision de l'export RGPD « Mes données » — lot 103C (ticket P1, §3 F).
 *
 * UNE anomalie compacte (domaine « Exports / transmissions ») tant qu'il
 * existe au moins un export en échec définitif non suivi d'un succès, une
 * génération sans progrès (worker arrêté), une archive PARTIELLE récente ou
 * une dette du registre RGPD. Son détail (écran Supervision › anomalie)
 * liste chaque export : référence, étape, code stable, tentatives, durée,
 * volume, cause technique abrégée, reprise programmée, notification,
 * registre. Résolue automatiquement quand plus rien n'est en défaut.
 *
 * Une panne technique ne crée AUCUNE carte « À traiter » côté utilisateur :
 * l'utilisateur voit un état unique dans Mon compte, le support voit ceci.
 */
import { pgClient } from '@/db';

type Raw = Record<string, unknown>;

export const GDPR_SUPERVISION_LOOKBACK_DAYS = 7;
/** Génération sans progrès depuis ce délai (et sans nouvelle tentative programmée) : bloquée. */
export const GDPR_STUCK_MINUTES = 30;
/** Dette du registre signalée au-delà de ce délai (le worker la rejoue chaque minute). */
const REGISTRY_DEBT_MINUTES = 15;

export type GdprIssueKind = 'echec' | 'bloque' | 'partiel' | 'registre';

export interface GdprIssueRow {
  kind: GdprIssueKind;
  id: number;
  userId: number;
  correlationId: string | null;
  status: string;
  errorCode: string | null;
  step: string | null;
  attempts: number;
  errorMessage: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  progressAt: Date | null;
  nextAttemptAt: Date | null;
  sizeBytes: number | null;
  parts: number | null;
  missingCount: number;
  notified: boolean;
  registryPending: boolean;
  peakRssMb: number | null;
}

const LABELS: Record<GdprIssueKind, string> = { echec: 'en échec', bloque: 'bloquée(s)', partiel: 'partielle(s)', registre: 'registre non à jour' };

/** Pur : anomalie compacte à partir des lignes en défaut (null si aucune). */
export function gdprSupervisionCondition(rows: GdprIssueRow[]): { title: string; occurredAt: Date; detail: Record<string, unknown> } | null {
  if (!rows.length) return null;
  const counts: Record<GdprIssueKind, number> = { echec: 0, bloque: 0, partiel: 0, registre: 0 };
  for (const r of rows) counts[r.kind]++;
  const resume = (Object.keys(counts) as GdprIssueKind[]).filter((k) => counts[k] > 0).map((k) => `${counts[k]} ${LABELS[k]}`).join(', ');
  const occurredAt = new Date(Math.max(...rows.map((r) => (r.completedAt ?? r.progressAt ?? r.createdAt).getTime())));
  return {
    title: `Export RGPD « Mes données » : ${resume}`,
    occurredAt,
    detail: {
      resume: counts,
      exports: rows.slice(0, 20).map((r) => ({
        export: r.id,
        reference: r.correlationId ? r.correlationId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase() : null,
        correlation: r.correlationId,
        utilisateur: r.userId,
        nature: r.kind,
        statut: r.status,
        code: r.errorCode,
        etape: r.step,
        tentatives: r.attempts,
        dureeSecondes: r.startedAt ? Math.round(((r.completedAt ?? r.progressAt ?? new Date()).getTime() - r.startedAt.getTime()) / 1000) : null,
        volumeOctets: r.sizeBytes,
        parties: r.parts,
        manques: r.missingCount,
        picMemoireMo: r.peakRssMb,
        cause: r.errorMessage ? r.errorMessage.slice(0, 300) : null,
        reprise: r.nextAttemptAt ? `nouvelle tentative automatique le ${r.nextAttemptAt.toISOString()}` : (r.kind === 'echec' ? 'aucune (tentatives épuisées) — l’utilisateur peut relancer' : null),
        notification: r.notified ? 'envoyée' : 'non envoyée',
        registre: r.registryPending ? 'dette en attente de rejeu' : 'à jour',
      })),
      autres: Math.max(0, rows.length - 20),
      aide: 'Procédure : docs/exploitation/export-rgpd-fiabilisation.md (codes, étapes, reprise). Aucune donnée privée ici.',
    },
  };
}

/** Lignes en défaut (lecture seule). */
export async function collectGdprIssueRows(): Promise<GdprIssueRow[]> {
  const rows = await pgClient.unsafe<Raw[]>(
    `SELECT e.*,
            CASE
              WHEN e.status = 'error' THEN 'echec'
              WHEN e.status IN ('pending', 'generating') THEN 'bloque'
              WHEN e.status = 'ready' AND e.completeness = 'partial' THEN 'partiel'
              ELSE 'registre'
            END AS kind
       FROM gdpr_exports e
      WHERE e.created_at > now() - make_interval(days => $1)
        AND (
          (e.status = 'error' AND NOT EXISTS (
             SELECT 1 FROM gdpr_exports r WHERE r.user_id = e.user_id AND r.status IN ('ready', 'expired') AND r.created_at > e.created_at))
          OR (e.status IN ('pending', 'generating')
              AND coalesce(e.progress_at, e.created_at) < now() - make_interval(mins => $2)
              AND (e.next_attempt_at IS NULL OR e.next_attempt_at < now() - make_interval(mins => 10)))
          OR (e.status = 'ready' AND e.completeness = 'partial' AND e.expires_at > now())
          OR (e.registry_pending AND e.created_at < now() - make_interval(mins => $3))
        )
      ORDER BY e.id DESC
      LIMIT 200`,
    [GDPR_SUPERVISION_LOOKBACK_DAYS, GDPR_STUCK_MINUTES, REGISTRY_DEBT_MINUTES],
  );
  const d = (v: unknown) => (v == null ? null : new Date(v as string));
  return rows.map((r) => {
    const s = (r.summary ?? {}) as Raw;
    const metrics = ((s.metrics ?? (s.lastAttempt as Raw | undefined)) ?? {}) as Raw;
    return {
      kind: String(r.kind) as GdprIssueKind,
      id: Number(r.id),
      userId: Number(r.user_id),
      correlationId: (r.correlation_id as string | null) ?? null,
      status: String(r.status),
      errorCode: (r.error_code as string | null) ?? null,
      step: (r.step as string | null) ?? null,
      attempts: Number(r.attempt_count ?? 0),
      errorMessage: (r.error_message as string | null) ?? null,
      createdAt: new Date(r.created_at as string),
      startedAt: d(r.started_at),
      completedAt: d(r.completed_at),
      progressAt: d(r.progress_at),
      nextAttemptAt: d(r.next_attempt_at),
      sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes),
      parts: r.parts_count == null ? null : Number(r.parts_count),
      missingCount: Number(s.missingCount ?? 0),
      notified: r.notified_at != null,
      registryPending: Boolean(r.registry_pending),
      peakRssMb: metrics.peakRssMb == null ? null : Number(metrics.peakRssMb),
    };
  });
}
