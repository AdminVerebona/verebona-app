/**
 * Accès BO aux rapports d'exécution T1 / T3 — lot 58C.
 *
 * Les rapports reprennent des valeurs issues des documents des utilisateurs :
 * routes réservées aux administrateurs (garde des routes), chaque
 * consultation de lignes, de contenu ou d'export est journalisée
 * (`admin_audit_log`, action `AI_EXECUTION_REPORT_READ`), réponses
 * `no-store`. Toute lecture est bornée au compte du rapport. Aucun secret :
 * le rapport ne contient ni clé, ni URL de connexion, ni prompt.
 */
import {
  correlatedReports, getExecutionReport, readReportEntries, reportBreakdown, resolveRef,
  type ReportSummary,
} from './repository';

export async function journalReportAccess(p: {
  adminUserId: number; reportId: number; purpose: 'detail' | 'content' | 'export'; result: 'SUCCESS' | 'FAILURE'; details?: Record<string, unknown>;
}): Promise<void> {
  await import('@/lib/admin-audit').then(({ logAdminAction }) => logAdminAction({
    adminId: p.adminUserId, action: 'AI_EXECUTION_REPORT_READ', targetType: 'AI_EXECUTION_REPORT', targetId: p.reportId,
    result: p.result, details: { purpose: p.purpose, ...(p.details ?? {}) },
  })).catch((e: Error) => console.error('[execution-report] journal admin non écrit :', String(e.message).slice(0, 200)));
}

export interface ReportDetail {
  report: ReportSummary;
  breakdown: Array<{ section: string; writeResult: string; count: number }>;
  correlations: Awaited<ReturnType<typeof correlatedReports>>;
  entries: Awaited<ReturnType<typeof readReportEntries>>['entries'];
  total: number;
  offset: number;
  limit: number;
}

export async function readReportDetailForAdmin(p: {
  adminUserId: number; reportId: number; offset?: number; limit?: number; section?: string; writeResult?: string;
}): Promise<ReportDetail | null> {
  const report = await getExecutionReport(p.reportId);
  if (!report) return null;
  const limit = Math.min(Math.max(p.limit ?? 200, 1), 1000);
  const offset = Math.max(p.offset ?? 0, 0);
  const [breakdown, correlations, page] = await Promise.all([
    reportBreakdown(report), correlatedReports(report),
    readReportEntries(report, { offset, limit, section: p.section, writeResult: p.writeResult }),
  ]);
  await journalReportAccess({ adminUserId: p.adminUserId, reportId: p.reportId, purpose: 'detail', result: 'SUCCESS', details: { offset, limit, section: p.section ?? null } });
  return { report, breakdown, correlations, entries: page.entries, total: page.total, offset, limit };
}

/** Contenu COMPLET d'une ligne référencée (texte intégral, contenu d'unité…), relu en direct. */
export async function readEntryContentForAdmin(p: { adminUserId: number; reportId: number; seq: number }) {
  const report = await getExecutionReport(p.reportId);
  if (!report) return null;
  const { entries } = await readReportEntries(report, { offset: p.seq - 1, limit: 1 });
  const e = entries[0];
  if (!e || e.seq !== p.seq) return null;
  const content = await resolveRef(report.accountId, e);
  await journalReportAccess({ adminUserId: p.adminUserId, reportId: p.reportId, purpose: 'content', result: 'SUCCESS', details: { seq: p.seq, state: content.state } });
  return { seq: e.seq, tableName: e.tableName, recordId: e.recordId, columnPath: e.columnPath, ref: e.ref, content };
}
