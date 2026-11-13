/**
 * Lot 113AM (Trello #739) — journal de la garde d'admission des
 * rattachements (`document_asset_link_admissions`, migration 1660).
 *
 * Écrit par les primitives `linkDocumentToAsset` et
 * `ASSET_LINK_SLOT.writeAuto` après chaque décision de la garde sur une
 * écriture AUTOMATIQUE (admise et écrite, ou refusée), et par le rattrapage
 * BO (réparé / restauré). Ne lève JAMAIS : un journal indisponible (migration
 * absente, base en panne) n'empêche ni n'autorise une écriture — la garde,
 * elle, s'applique toujours.
 *
 * Aucune valeur lue dans le document (adresse, extrait) n'est journalisée :
 * natures de preuve, rôles qualifiés, provenances et scores seulement.
 */
import { justificationDigest, LINK_ADMISSION_VERSION, type AdmissionDecision, type LinkJustification } from './admission';

type Exec = { unsafe: (q: string, p?: never[]) => Promise<unknown> };

let etat: { ready: boolean; at: number } | null = null;

/** Table 1660 présente ? (relu toutes les 5 min tant qu'elle manque). */
export async function linkAdmissionJournalReady(exec?: Exec): Promise<boolean> {
  if (etat && (etat.ready || Date.now() - etat.at < 300_000)) return etat.ready;
  let ready = false;
  try {
    const x = exec ?? (await import('@/db')).pgClient as unknown as Exec;
    const r = (await x.unsafe(`SELECT to_regclass('document_asset_link_admissions') IS NOT NULL AS t`)) as Array<{ t: boolean }>;
    ready = r?.[0]?.t === true;
  } catch { ready = false; }
  etat = { ready, at: Date.now() };
  return ready;
}

/** Remise à zéro du cache (tests). */
export function resetLinkAdmissionJournalCache(): void { etat = null; }

export interface AdmissionRecord {
  accountId: number;
  fileId: number;
  target: { assetId?: number | null; equipmentId?: number | null; substructureId?: number | null };
  writeKind: 'LINK' | 'PRIMARY_COLUMN';
  origin: string;
  role?: string | null;
  justification: LinkJustification | null | undefined;
  decision: AdmissionDecision;
  linkId?: number | null;
  detail?: Record<string, unknown>;
}

const borne = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null)) as T;

async function businessExecutionId(): Promise<string | null> {
  try { return (await import('@/services/ai/business-execution/context')).currentBusinessExecutionId(); } catch { return null; }
}

/** Journalise une décision de la garde (dédoublonnée). Ne lève jamais. */
export async function recordLinkAdmission(r: AdmissionRecord, exec?: Exec): Promise<void> {
  try {
    if (!(await linkAdmissionJournalReady(exec))) return;
    const x = exec ?? (await import('@/db')).pgClient as unknown as Exec;
    const j = r.justification ?? null;
    const issue = r.decision.admitted ? 'ADMITTED' : 'REFUSED';
    await x.unsafe(`
      INSERT INTO document_asset_link_admissions
        (account_id, file_id, asset_id, equipment_id, substructure_id, link_id, write_kind, step, rule, origin, link_role,
         decision, reason_code, decisive_proof, proofs, rejected, digest, guard_version, detail, business_execution_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16::jsonb, $17, $18, $19::jsonb, $20)
      ON CONFLICT (file_id, COALESCE(asset_id, 0), COALESCE(equipment_id, 0), COALESCE(substructure_id, 0), write_kind, step, decision, reason_code, digest)
        WHERE run_id IS NULL
      DO UPDATE SET occurrences = document_asset_link_admissions.occurrences + 1, last_seen_at = now(),
                    link_id = COALESCE(EXCLUDED.link_id, document_asset_link_admissions.link_id),
                    business_execution_id = COALESCE(EXCLUDED.business_execution_id, document_asset_link_admissions.business_execution_id)`,
    [
      r.accountId, r.fileId, r.target.assetId ?? null, r.target.equipmentId ?? null, r.target.substructureId ?? null, r.linkId ?? null,
      r.writeKind, j?.step ?? 'OTHER', j?.rule?.slice(0, 200) ?? null, r.origin, r.role ?? null,
      issue, r.decision.reasonCode, JSON.stringify(borne(r.decision.decisiveProof)), JSON.stringify(borne(j?.proofs ?? [])),
      JSON.stringify(borne(r.decision.rejected)), justificationDigest(j), LINK_ADMISSION_VERSION, JSON.stringify(borne(r.detail ?? {})),
      await businessExecutionId(),
    ] as never[]);
  } catch (e) {
    console.warn(`[rattachement] journal de la garde non écrit (document ${r.fileId}) :`, (e as Error).message);
  }
}

/** Trace console structurée (supervision des journaux), toujours émise pour un refus. */
export function logLinkRefusal(r: Pick<AdmissionRecord, 'accountId' | 'fileId' | 'target' | 'writeKind' | 'justification' | 'decision'>): void {
  console.info(JSON.stringify({
    event: 'document_asset_link.refused', accountId: r.accountId, fileId: r.fileId,
    assetId: r.target.assetId ?? null, equipmentId: r.target.equipmentId ?? null, writeKind: r.writeKind,
    step: r.justification?.step ?? null, rule: r.justification?.rule ?? null, reason: r.decision.reasonCode,
    proofs: (r.justification?.proofs ?? []).map((p) => `${p.kind}${p.identifierKind ? `:${p.identifierKind}` : ''}${p.addressRole ? `:${p.addressRole}` : ''}`),
  }));
}
