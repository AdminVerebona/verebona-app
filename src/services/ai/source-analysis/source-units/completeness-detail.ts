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
import { coverageSchemaStatus, loadAllDocumentSourceUnits, loadDocumentCoverage } from './repository';
import { occurrenceTotals, unitValueForms, type UnitOccurrenceLedger } from './coverage-reconciliation';
import type { OccurrenceCounts, OccurrenceDetail } from './occurrences';
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
  provenance: {
    rule: string; sources: string[]; refs: string[]; previous: { status: string; reason: string | null }; stage: string;
    /** Carte #853 : compteurs et détail PAR OCCURRENCE enregistrés avec la requalification (absents : provenance antérieure). */
    occurrences?: OccurrenceCounts | null; details?: OccurrenceDetail[] | null;
  } | null;
  /**
   * Carte #853 (R4, AC15) : contrôle COURANT par occurrence (sans IA, rien n'est écrit) — identité, position,
   * issue, preuve exacte ou motif ; jamais la valeur. null : unité non inventoriée ou contrôle indisponible.
   */
  occurrences?: { mode: UnitOccurrenceLedger['mode']; counts: OccurrenceCounts; details: OccurrenceDetail[] } | null;
  /** Valeurs repérées par nature (montant, date, identifiant, nombre) — jamais la valeur. */
  valueKinds: Record<string, number>;
  textLength: number;
}

export interface CompletenessDetail {
  fileId: number;
  accountId: number;
  qualityState: string;
  totals: { total: number; covered: number; nonInformational: number; uncertain: number; unresolved: number; failed: number; requalified: number };
  /** Carte #853 (R3) : totaux PAR OCCURRENCE du contrôle courant (unités ≠ occurrences). null : contrôle indisponible. */
  occurrenceTotals?: (OccurrenceCounts & { units: number }) | null;
  coverageRepair: T1CoverageDiagnostics['coverageRepair'] | null;
  reconciliation: T1CoverageDiagnostics['reconciliation'] | null;
  residualPolicies: Record<string, number>;
  retryAttempts: number;
  lastRetryResult: string | null;
  units: CompletenessUnitRow[];
  /**
   * Lot 114G (#760, P2-09) : la liste n'est plus tronquée en silence — `units` est UNE PAGE de la liste filtrée ;
   * `listed` est le total réel de la liste (avant filtres), `matched` le total après filtres.
   */
  paging: { offset: number; limit: number; listed: number; matched: number };
  /**
   * Lot 114G (#760, P2-10) : étapes de réparation comptées SÉPARÉMENT — réparation ciblée de couverture à l'analyse
   * (`coverageRepair`), reprise différée (`deferredRepair`), relectures du fichier (`sourceReread`) — avec, pour
   * chacune, le motif d'un zéro appel quand il est connu. Les réparations JSON de la passerelle sont une autre
   * mesure (rapport d'exécution, `repairCalls`), jamais additionnée à celles-ci.
   */
  repairSteps: {
    coverageRepair: {
      calls: number; attempted: number; resolved: number; skipped: string | null;
      /** Lot 115F (#792, écart P2-10) : échecs d'appel et coût de cette famille (absents : non consignés). */
      callsFailed?: number; costMicros?: number; costUnknownCalls?: number;
    } | null;
    deferredRepair: Record<string, unknown> | null;
    sourceReread: { runs: number; failed: number; resolved: number } | null;
    retryAttempts: number;
    lastRetryResult: string | null;
  };
  /** Lot 114G (#760, P2-07) : migration 1665 — colonnes présentes / absentes. */
  schema: { ready: boolean; missing: string[] };
}

/** Filtres et pagination de la liste des unités (lot 114G, #760 P2-09). */
export interface CompletenessUnitsQuery {
  /** Toutes les unités (défaut : non couvertes ou requalifiées). */
  all?: boolean;
  status?: string | null;
  reason?: string | null;
  policy?: string | null;
  page?: number | null;
  /** Recherche par identifiant d'unité (`sourceUnitId`, sous-chaîne). */
  unitId?: string | null;
  /**
   * Lot 115F (Trello #792, écart P2-09) : PROVENANCE de la requalification — origine de la preuve
   * (`FACT`, `TABLE`, `METADATA`, `CANDIDATE`, `VALUE_DECISION`, `UNIT`, `REPAIR`). Filtre manquant :
   * la provenance était affichée mais ne pouvait pas être cherchée.
   */
  provenance?: string | null;
  /** Lot 115F (#792, écart P2-09) : RÈGLE de requalification (codes de `reconciliation.byRule`). */
  rule?: string | null;
  /** Unités requalifiées seulement (provenance présente). */
  requalified?: boolean;
  offset?: number;
  limit?: number;
}

export const COMPLETENESS_PAGE_DEFAULT = 100;
export const COMPLETENESS_PAGE_MAX = 500;

/** Filtre et pagine la liste (pure, testée) : jamais une troncature sans total. */
export function pageCompletenessUnits(rows: readonly CompletenessUnitRow[], q: CompletenessUnitsQuery = {}): { units: CompletenessUnitRow[]; paging: CompletenessDetail['paging'] } {
  const liste = q.all ? [...rows] : rows.filter((r) => (r.status !== 'COVERED' && r.status !== 'NON_INFORMATIONAL') || r.provenance !== null);
  const cherche = (q.unitId ?? '').trim().toLowerCase();
  const provenance = (q.provenance ?? '').trim().toUpperCase();
  const regle = (q.rule ?? '').trim();
  const filtres = liste.filter((r) => (!q.status || r.status === q.status)
    && (!q.reason || r.reason === q.reason)
    && (!q.policy || r.residualPolicy === q.policy || (r.residualPolicy ?? '').startsWith(`${q.policy}:`))
    && (q.page === null || q.page === undefined || r.page === q.page)
    && (!cherche || r.unitId.toLowerCase().includes(cherche))
    // Lot 115F (#792, écart P2-09) : provenance (origine de la preuve) et règle de requalification.
    && (!provenance || (r.provenance?.sources ?? []).some((s) => s.toUpperCase() === provenance))
    && (!regle || r.provenance?.rule === regle)
    && (!q.requalified || r.provenance !== null));
  const demande = Math.trunc(Number(q.limit));
  const limit = Number.isFinite(demande) && demande > 0 ? Math.min(COMPLETENESS_PAGE_MAX, demande) : COMPLETENESS_PAGE_DEFAULT;
  const offset = Math.max(0, Math.trunc(Number(q.offset) || 0));
  return { units: filtres.slice(offset, offset + limit), paging: { offset, limit, listed: liste.length, matched: filtres.length } };
}

/** Détail de complétude d'un document (null : aucune couche A). `all` : toutes les unités (défaut : non couvertes ou requalifiées). */
export async function loadCompletenessDetail(fileId: number, opts: CompletenessUnitsQuery = {}): Promise<CompletenessDetail | null> {
  const cov = await loadDocumentCoverage(fileId);
  if (!cov) return null;
  const stored = await loadAllDocumentSourceUnits(fileId, { accountId: cov.accountId });
  const v = (cov.verification ?? {}) as Partial<T1CoverageDiagnostics>;
  // Carte #853 : contrôle courant par occurrence (simulation sans IA, aucune écriture). Panne : null, jamais un zéro.
  const registre = new Map<string, UnitOccurrenceLedger>();
  const controle = await (async () => {
    const [{ pgClient }, { toCovered }, { reconcileStoredUnits }] = await Promise.all([import('@/db'), import('./jobs'), import('./stored-reconciliation')]);
    await reconcileStoredUnits(pgClient as never, { accountId: cov.accountId, fileId, units: stored.map(toCovered), ledger: registre });
    return true;
  })().catch(() => false);
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
      provenance: pv ? {
        rule: pv.rule, sources: pv.sources ?? [], refs: pv.refs ?? [], previous: pv.previous, stage: pv.stage,
        occurrences: pv.occurrences ?? null, details: pv.details ?? null,
      } : null,
      occurrences: controle && registre.has(u.sourceUnitId) ? registre.get(u.sourceUnitId)! : null,
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
    occurrenceTotals: controle ? occurrenceTotals(registre) : null,
    coverageRepair: v.coverageRepair ?? null,
    reconciliation: v.reconciliation ?? null,
    residualPolicies: v.residualPolicies ?? {},
    retryAttempts: cov.retryAttempts,
    lastRetryResult: cov.lastRetryResult ?? null,
    ...pageCompletenessUnits(rows, opts),
    repairSteps: {
      coverageRepair: v.coverageRepair ? {
        calls: v.coverageRepair.calls, attempted: v.coverageRepair.attempted, resolved: v.coverageRepair.resolved,
        skipped: v.coverageRepair.skipped ?? null,
        // Lot 115F (#792, écart P2-10) : repris tels quels — absents d'un diagnostic antérieur, donc inconnus.
        ...(v.coverageRepair.callsFailed !== undefined ? { callsFailed: v.coverageRepair.callsFailed } : {}),
        ...(v.coverageRepair.costMicros !== undefined ? { costMicros: v.coverageRepair.costMicros } : {}),
        ...(v.coverageRepair.costUnknownCalls !== undefined ? { costUnknownCalls: v.coverageRepair.costUnknownCalls } : {}),
      } : null,
      deferredRepair: ((v as { deferredRepair?: Record<string, unknown> }).deferredRepair) ?? null,
      sourceReread: (v as { sourceReread?: { runs: number; failed: number; resolved: number } }).sourceReread ?? null,
      retryAttempts: cov.retryAttempts,
      lastRetryResult: cov.lastRetryResult ?? null,
    },
    schema: await coverageSchemaStatus().then((x) => ({ ready: x.ready, missing: x.missing })),
  };
}
