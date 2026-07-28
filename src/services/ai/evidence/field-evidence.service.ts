/**
 * Écriture et lecture des preuves — CDC §5.4.2.
 *
 * Invariants :
 *  - une même preuve n'est jamais créée deux fois (CDC §5.7) : l'unicité porte
 *    sur (compte, bien, champ, source, localisation, valeur normalisée) ;
 *  - toute valeur appliquée automatiquement possède au moins une preuve
 *    (critère d'acceptation n°12).
 */
import { createHash } from 'crypto';
import { db, pgClient } from '@/db';
import { fieldEvidence } from '@/db/ai-schema';
import { and, eq, desc } from 'drizzle-orm';
import type { FieldEvidence, FieldEvidenceInput, EvidenceStatus } from './evidence.types';

function evidenceFingerprint(i: FieldEvidenceInput): string {
  return createHash('sha256').update(JSON.stringify({
    a: i.accountId, as: i.assetId, f: i.fieldKey,
    st: i.sourceType, si: i.sourceId, sv: i.sourceVersion ?? null,
    loc: i.location, nv: i.normalizedValue ?? String(i.value),
  })).digest('hex');
}

/** Insère une preuve, ou renvoie l'existante si elle est strictement identique. */
export async function recordEvidence(input: FieldEvidenceInput): Promise<number> {
  const fingerprint = evidenceFingerprint(input);

  const rows = await pgClient.unsafe(
    `INSERT INTO field_evidence (
       account_id, asset_id, field_key, value_json, normalized_value,
       source_type, source_id, source_version, source_location, evidence_excerpt,
       document_type, document_date, provider, model, prompt_version,
       confidence, authority_score, status, operation_trace_id, fingerprint
     ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,'active',$18,$19)
     ON CONFLICT (fingerprint) DO UPDATE SET extracted_at = field_evidence.extracted_at
     RETURNING id`,
    [
      input.accountId, input.assetId, input.fieldKey,
      JSON.stringify(input.value), input.normalizedValue ?? null,
      input.sourceType, input.sourceId, input.sourceVersion ?? null,
      JSON.stringify(input.location), input.excerpt,
      input.documentType ?? null, input.documentDate ?? null,
      input.provider ?? null, input.model ?? null, input.promptVersion ?? null,
      input.confidence, input.authorityScore,
      input.operationTraceId ?? null, fingerprint,
    ] as never[],
  );

  return (rows as unknown as Array<{ id: number }>)[0].id;
}

/** Preuves actives d'un champ, de la plus autoritaire à la moins autoritaire. */
export async function getActiveEvidence(
  accountId: number, assetId: number, fieldKey: string,
): Promise<FieldEvidence[]> {
  const rows = await db.select().from(fieldEvidence).where(and(
    eq(fieldEvidence.accountId, accountId),
    eq(fieldEvidence.assetId, assetId),
    eq(fieldEvidence.fieldKey, fieldKey),
    eq(fieldEvidence.status, 'active'),
  )).orderBy(desc(fieldEvidence.authorityScore), desc(fieldEvidence.documentDate));

  return rows as unknown as FieldEvidence[];
}

/** Marque des preuves comme dépassées lorsqu'une meilleure preuve est appliquée. */
export async function supersedeEvidence(ids: number[], status: EvidenceStatus = 'superseded'): Promise<void> {
  if (ids.length === 0) return;
  await pgClient.unsafe(
    `UPDATE field_evidence SET status = $1 WHERE id = ANY($2::int[])`,
    [status, ids] as never[],
  );
}
