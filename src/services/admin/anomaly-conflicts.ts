/**
 * Lot 113AQ (Trello #751) — diagnostic d'une anomalie de Supervision
 * IDENTITY_ATTRIBUTE_CONFLICT (anomalie BO #12) : contrat
 * `verebona.operation-attribute-conflicts/1` (Opération × attribut × rôle),
 * lecture chronologique des signalements, compteurs distincts.
 *
 * Lecture seule (aucune mutation, aucun appel IA, aucune reconsolidation) :
 * l'écran, la route et l'export 113AI lisent CE service, ils concordent.
 * Les autres familles d'anomalies ne sont pas concernées (`NOT_APPLICABLE`).
 */
import { getAnomaly } from './anomaly.service';
import type { ConflictDiagnostic } from '@/services/business-operations/diagnostics/attribute-conflicts-read';

export const IDENTITY_ATTRIBUTE_CONFLICT_CODE = 'IDENTITY_ATTRIBUTE_CONFLICT';

/** L'anomalie relève-t-elle du diagnostic des contradictions d'attributs ? */
export function isAttributeConflictAnomaly(a: { domain: string; technicalDetail: Record<string, unknown> | null }): boolean {
  return a.domain === 'other' && a.technicalDetail?.code === IDENTITY_ATTRIBUTE_CONFLICT_CODE;
}

export type AnomalyConflictResult =
  | { status: 'NOT_FOUND' }
  | { status: 'NOT_APPLICABLE' }
  | { status: 'OK'; diagnostic: ConflictDiagnostic };

export async function anomalyConflictDiagnostic(
  anomalyId: number, opts: { page?: number; pageSize?: number; scope?: 'alerting' | 'all' } = {},
): Promise<AnomalyConflictResult> {
  const a = await getAnomaly(anomalyId);
  if (!a) return { status: 'NOT_FOUND' };
  if (!isAttributeConflictAnomaly(a)) return { status: 'NOT_APPLICABLE' };
  const { readConflictDiagnostic } = await import('@/services/business-operations/diagnostics/attribute-conflicts-read');
  const diagnostic = await readConflictDiagnostic({
    page: opts.page, pageSize: opts.pageSize, scope: opts.scope,
    occurrences: a.occurrences.map((o) => ({ id: o.id, occurredAt: o.occurredAt, technicalDetail: o.technicalDetail })),
    occurrenceCount: a.occurrenceCount, anomalyStatus: a.status,
  });
  return { status: 'OK', diagnostic };
}
