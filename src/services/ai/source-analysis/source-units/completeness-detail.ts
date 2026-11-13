/**
 * Lot 113AN (Trello #741) — RAPPORT DE COMPLÉTUDE unité par unité d'un
 * document (BO › Exécutions IA › Complétude T1 › « Unités »).
 *
 * Confidentialité : AUCUN contenu de document n'est rendu — identifiant,
 * nature, page, état, motif, réparation, politique, provenance (règle,
 * sources, références techniques), nombre de valeurs par nature et longueur
 * du texte. Le contenu reste consultable par les écrans à accès restreint
 * existants (diagnostic, rapport d'exécution).
 */
import { loadDocumentCoverage, loadDocumentSourceUnits } from './repository';
import { unitValueForms } from './coverage-reconciliation';
import type { CoverageStatus, T1CoverageDiagnostics } from './types';

export interface CompletenessUnitRow {
  unitId: string;
  kind: string;
  page: number | null;
  status: CoverageStatus;
  reason: string | null;
  factCount: number;
  repairState: string | null;
  repairAttempts: number;
  residualPolicy: string | null;
  /** Requalification (règle, sources, références, état d'avant) — null : état d'origine. */
  provenance: { rule: string; sources: string[]; refs: string[]; previous: { status: string; reason: string | null }; stage: string } | null;
  /** Valeurs repérées par nature (montant, date, identifiant, nombre) — jamais la valeur. */
  valueKinds: Record<string, number>;
  textLength: number;
}

export interface CompletenessDetail {
  fileId: number;
  accountId: number;
  qualityState: string;
  totals: { total: number; covered: number; nonInformational: number; uncertain: number; unresolved: number; failed: number; requalified: number };
  coverageRepair: T1CoverageDiagnostics['coverageRepair'] | null;
  reconciliation: T1CoverageDiagnostics['reconciliation'] | null;
  residualPolicies: Record<string, number>;
  retryAttempts: number;
  lastRetryResult: string | null;
  units: CompletenessUnitRow[];
}

/** Détail de complétude d'un document (null : aucune couche A). `all` : toutes les unités (défaut : non couvertes ou requalifiées). */
export async function loadCompletenessDetail(fileId: number, opts: { all?: boolean } = {}): Promise<CompletenessDetail | null> {
  const cov = await loadDocumentCoverage(fileId);
  if (!cov) return null;
  const stored = await loadDocumentSourceUnits(fileId, { accountId: cov.accountId, limit: 50_000 });
  const v = (cov.verification ?? {}) as Partial<T1CoverageDiagnostics>;
  const rows: CompletenessUnitRow[] = stored.map((u) => {
    const pv = (typeof u.coverageProvenance === 'string' ? JSON.parse(u.coverageProvenance) : u.coverageProvenance) ?? null;
    const valueKinds: Record<string, number> = {};
    for (const f of unitValueForms(u.text ?? (u.label || u.value ? `${u.label ?? ''} : ${u.value ?? ''}` : null))) {
      const k = f.slice(0, f.indexOf(':'));
      valueKinds[k] = (valueKinds[k] ?? 0) + 1;
    }
    return {
      unitId: u.sourceUnitId, kind: u.kind, page: u.page, status: u.coverageStatus, reason: u.coverageReason, factCount: u.factCount,
      repairState: u.repairState ?? null, repairAttempts: u.repairAttempts, residualPolicy: u.residualPolicy ?? null,
      provenance: pv ? { rule: pv.rule, sources: pv.sources ?? [], refs: pv.refs ?? [], previous: pv.previous, stage: pv.stage } : null,
      valueKinds, textLength: (u.text ?? '').length,
    };
  });
  const n = (s: CoverageStatus) => rows.filter((r) => r.status === s).length;
  return {
    fileId, accountId: cov.accountId, qualityState: cov.qualityState,
    totals: {
      total: rows.length, covered: n('COVERED'), nonInformational: n('NON_INFORMATIONAL'), uncertain: n('UNCERTAIN'),
      unresolved: n('UNRESOLVED'), failed: n('FAILED'),
      requalified: rows.filter((r) => r.provenance && (r.provenance.previous.status !== r.status || r.provenance.previous.reason !== r.reason)).length,
    },
    coverageRepair: v.coverageRepair ?? null,
    reconciliation: v.reconciliation ?? null,
    residualPolicies: v.residualPolicies ?? {},
    retryAttempts: cov.retryAttempts,
    lastRetryResult: cov.lastRetryResult ?? null,
    units: opts.all ? rows : rows.filter((r) => (r.status !== 'COVERED' && r.status !== 'NON_INFORMATIONAL') || r.provenance !== null),
  };
}
