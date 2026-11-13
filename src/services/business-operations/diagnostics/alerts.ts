/**
 * Alerte d'exploitation sur anomalie dure des Opérations (lot 47A, O9 — CDC
 * Opérations V1 C26.2 : « Les anomalies dures doivent déclencher une alerte
 * technique et une correction du code/données » ; ACC-022).
 *
 * Même modèle que les alertes existantes (`supervision-sweep.service.ts`) :
 * la tâche planifiée `operations-quality-check` (chaque jour) LIT les
 * anomalies dures (`OperationDiagnosticsService`, transaction READ ONLY) et
 * ouvre / consolide une anomalie de Supervision par code (domaine « Autres
 * traitements techniques », empreinte `other:business-operations:<code>`) ;
 * elle la résout automatiquement (SUP-008) dès que le décompte revient à 0.
 *
 * Les seules écritures portent sur `admin_anomalies` / occurrences, via
 * `anomaly.service` — jamais sur une Opération (décision PO Q9). Aucune
 * valeur de taux ne désactive quoi que ce soit (Q8, C26.2).
 */
import { CORRECTION_PROCEDURE, HARD_ANOMALY_CODES, type HardAnomalyCode, type HardAnomalyResult } from './model';

export const OPERATIONS_ANOMALY_PREFIX = 'other:business-operations:';
export const OPERATIONS_ANOMALY_ORIGIN = 'operations_quality_check_cleared';

/** Empreinte de Supervision d'un code d'anomalie dure (forme de `buildFingerprint`). */
export function operationsAnomalyFingerprint(code: HardAnomalyCode): string {
  return `${OPERATIONS_ANOMALY_PREFIX}${code.toLowerCase()}`;
}

interface QualityCheckDeps {
  detect: () => Promise<HardAnomalyResult[]>;
  openFingerprints: () => Promise<string[]>;
  report: (input: import('@/services/admin/anomaly.service').ReportAnomalyInput) => Promise<number | null>;
  resolve: (fingerprint: string) => Promise<boolean>;
  /**
   * Lot 113AQ (#751) : relevé STRUCTURÉ des contradictions d'attributs (producteur : provenance T3 qualifiée).
   * Absent : détail historique (compteurs et listes d'identifiants seulement).
   */
  conflictLines?: () => Promise<{ lines: ConflictLine[]; total: number }>;
  /** Lot 113AQ : signalement détaillé (balayage identique → aucune occurrence) ; absent : `report`. */
  reportDetailed?: (input: import('@/services/admin/anomaly.service').ReportAnomalyInput) => Promise<{ anomalyId: number; occurrence: boolean } | null>;
}

interface ConflictLine { accountId: number; operationId: number; field: string; role: string; qualification: string; reasonCode: string; values: string[]; retained: string | null }

interface QualityCheckResult {
  counts: Record<HardAnomalyCode, number>;
  reported: number;
  resolved: number;
  /** Lot 113AQ : signalements sans nouvelle occurrence (constat matériel identique au précédent). */
  unchanged: number;
}

/** Plan pur : codes à signaler (décompte > 0) et empreintes ouvertes à résoudre. */
export function planQualityAlerts(anomalies: readonly HardAnomalyResult[], open: readonly string[]): {
  toReport: HardAnomalyResult[];
  toResolve: string[];
} {
  const toReport = anomalies.filter((a) => a.count > 0);
  const actives = new Set(toReport.map((a) => operationsAnomalyFingerprint(a.code)));
  return { toReport, toResolve: open.filter((f) => f.startsWith(OPERATIONS_ANOMALY_PREFIX) && !actives.has(f)) };
}

async function defaultDeps(): Promise<QualityCheckDeps> {
  const [{ OperationDiagnosticsService }, anomalies, { pgClient }] = await Promise.all([
    import('./service'), import('@/services/admin/anomaly.service'), import('@/db'),
  ]);
  return {
    // Lot 82A (C-Q10) : contrôle planifié des seuls comptes éligibles.
    detect: () => new OperationDiagnosticsService().hardAnomalies(null, { eligibleOnly: true }),
    openFingerprints: async () => ((await pgClient.unsafe(
      `SELECT fingerprint FROM admin_anomalies WHERE status = 'open' AND fingerprint LIKE $1`,
      [`${OPERATIONS_ANOMALY_PREFIX}%`] as never[],
    )) as unknown as Array<{ fingerprint: string }>).map((r) => r.fingerprint),
    report: anomalies.reportAnomaly,
    reportDetailed: anomalies.reportAnomalyDetailed,
    resolve: (f) => anomalies.autoResolveAnomaly(f, { origin: OPERATIONS_ANOMALY_ORIGIN, cause: 'Anomalie dure revenue à 0 (reconsolidation)' }),
    conflictLines: async () => (await import('./attribute-conflicts-read')).alertingConflictLines(undefined, { eligibleOnly: true }),
  };
}

/**
 * Lot 113AQ (#751) : détail structuré de l'anomalie IDENTITY_ATTRIBUTE_CONFLICT — relevé compact
 * « compte:opération:attribut:qualification » (association explicite), contrat, règles, empreinte matérielle.
 */
async function conflictDetail(d: QualityCheckDeps, now: Date): Promise<{ detail: Record<string, unknown>; materialKey: string } | null> {
  if (!d.conflictLines) return null;
  const { lines, total } = await d.conflictLines();
  const m = await import('./attribute-conflicts-model');
  const { ATTRIBUTE_CONFLICT_RULES } = await import('../consolidation/attribute-conflicts');
  const compact = m.occurrenceLines(lines);
  const materialKey = m.materialKeyOf(lines);
  const parQualification: Record<string, number> = {};
  for (const l of lines) parQualification[l.qualification] = (parQualification[l.qualification] ?? 0) + 1;
  return {
    materialKey,
    detail: {
      contract: m.ATTRIBUTE_CONFLICT_DIAGNOSTIC_FORMAT,
      rules: ATTRIBUTE_CONFLICT_RULES,
      conflicts: compact.conflicts,
      conflictsTotal: lines.length,
      operationsTotal: total,
      truncated: compact.truncated || lines.length < total,
      byQualification: parQualification,
      lastCheckAt: now.toISOString(),
    },
  };
}

/** Contrôle quotidien des anomalies dures et alerte de Supervision. */
export async function runOperationsQualityCheck(deps?: QualityCheckDeps): Promise<QualityCheckResult> {
  const d = deps ?? await defaultDeps();
  const anomalies = await d.detect();
  const { toReport, toResolve } = planQualityAlerts(anomalies, await d.openFingerprints());
  let reported = 0;
  let unchanged = 0;
  for (const a of toReport) {
    const comptes = [...new Set(a.samples.map((s) => s.accountId))];
    // Lot 113AQ : la lecture structurée ne doit jamais empêcher le signalement (détail historique en repli).
    const structure = a.code === 'IDENTITY_ATTRIBUTE_CONFLICT'
      ? await conflictDetail(d, new Date()).catch((e: unknown) => ({ materialKey: null, detail: { structuredDetailError: String((e as Error)?.message ?? e).slice(0, 200) } }))
      : null;
    const input = {
      domain: 'other' as const,
      fingerprint: operationsAnomalyFingerprint(a.code),
      title: `Opérations : ${a.label} (${a.count})`,
      accountId: comptes.length === 1 ? comptes[0] : null,
      detail: {
        code: a.code,
        count: a.count,
        accountIds: a.accountIds.join(', '),
        operationIds: a.samples.map((s) => s.operationId).filter((x) => x !== null).slice(0, 20).join(', '),
        ...(structure?.detail ?? {}),
        boLink: comptes.length === 1 ? `/admin/operations?tab=indicateurs&accountId=${comptes[0]}` : '/admin/operations?tab=indicateurs',
        procedure: CORRECTION_PROCEDURE,
      },
      ...(structure?.materialKey ? { materialKey: structure.materialKey } : {}),
    };
    if (structure?.materialKey && d.reportDetailed) {
      const r = await d.reportDetailed(input);
      if (r) { reported++; if (!r.occurrence) unchanged++; }
      continue;
    }
    const id = await d.report(input);
    if (id !== null) reported++;
  }
  let resolved = 0;
  for (const f of toResolve) if (await d.resolve(f)) resolved++;
  const counts = Object.fromEntries(HARD_ANOMALY_CODES.map((c) => [c, anomalies.find((a) => a.code === c)?.count ?? 0])) as Record<HardAnomalyCode, number>;
  return { counts, reported, resolved, unchanged };
}
