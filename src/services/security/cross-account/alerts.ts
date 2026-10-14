/**
 * Alerte de Supervision « relations intercomptes » — lot 49 (ticket SEC-P0,
 * §5, AC08). Même modèle que `business-operations/diagnostics/alerts.ts` :
 *
 * la tâche planifiée `cross-account-relations-check` (chaque jour) LIT les
 * relations intercomptes (`detection.ts`, transaction READ ONLY) et ouvre /
 * consolide une anomalie de Supervision PAR TYPE non nul (domaine « Autres
 * traitements techniques », empreinte `other:cross-account:<code>`), avec le
 * nombre, les comptes concernés et un échantillon d'identifiants techniques ;
 * elle la résout d'elle-même dès que le décompte revient à 0.
 *
 * Seules écritures : `admin_anomalies` / occurrences, via `anomaly.service`.
 * Jamais de correction ni de suppression des données (ticket §5).
 */
import type { CrossAccountCheckResult, CrossAccountReport } from './detection';

export const CROSS_ACCOUNT_ANOMALY_PREFIX = 'other:cross-account:';
export const CROSS_ACCOUNT_ANOMALY_ORIGIN = 'cross_account_check_cleared';

/** Lien BO du rapport complet. */
export const CROSS_ACCOUNT_BO_LINK = '/admin/exploitation?tab=intercomptes';

/** Procédure de remise en conformité (jamais automatique). */
export const CROSS_ACCOUNT_PROCEDURE =
  'Aucune correction automatique. Accès déjà neutralisés (lectures et écritures bornées au compte). Correction contrôlée '
  + 'dans le BO : Exploitation › Rattrapages › « Relations intercomptes » (simuler, appliquer avec motif, restaurer) — '
  + 'docs/exploitation/relations-intercomptes.md.';

export function crossAccountFingerprint(code: string): string {
  return `${CROSS_ACCOUNT_ANOMALY_PREFIX}${code.toLowerCase()}`;
}

export interface CrossAccountAlertDeps {
  detect: () => Promise<CrossAccountReport>;
  openFingerprints: () => Promise<string[]>;
  report: (input: import('@/services/admin/anomaly.service').ReportAnomalyInput) => Promise<number | null>;
  resolve: (fingerprint: string) => Promise<boolean>;
}

export interface CrossAccountAlertResult {
  total: number;
  counts: Record<string, number>;
  reported: number;
  resolved: number;
  /** Contrôles non exécutés (motif). */
  errors: Record<string, string>;
}

/**
 * Plan pur : types à signaler (décompte > 0) et empreintes ouvertes à
 * résoudre. Un contrôle EN ÉCHEC ne résout jamais son anomalie (on ne sait
 * pas s'il est revenu à 0).
 */
export function planCrossAccountAlerts(checks: readonly CrossAccountCheckResult[], open: readonly string[]): {
  toReport: CrossAccountCheckResult[];
  toResolve: string[];
} {
  const toReport = checks.filter((c) => !c.error && c.count > 0);
  const gardees = new Set(checks.filter((c) => c.error || c.count > 0).map((c) => crossAccountFingerprint(c.code)));
  return { toReport, toResolve: open.filter((f) => f.startsWith(CROSS_ACCOUNT_ANOMALY_PREFIX) && !gardees.has(f)) };
}

async function defaultDeps(): Promise<CrossAccountAlertDeps> {
  const [{ detectCrossAccountRelations }, anomalies, { pgClient }] = await Promise.all([
    import('./detection'), import('@/services/admin/anomaly.service'), import('@/db'),
  ]);
  return {
    detect: () => detectCrossAccountRelations(),
    openFingerprints: async () => ((await pgClient.unsafe(
      `SELECT fingerprint FROM admin_anomalies WHERE status = 'open' AND fingerprint LIKE $1`,
      [`${CROSS_ACCOUNT_ANOMALY_PREFIX}%`] as never[],
    )) as unknown as Array<{ fingerprint: string }>).map((r) => r.fingerprint),
    report: anomalies.reportAnomaly,
    resolve: (f) => anomalies.autoResolveAnomaly(f, { origin: CROSS_ACCOUNT_ANOMALY_ORIGIN, cause: 'Relations intercomptes revenues à 0' }),
  };
}

/** Contrôle quotidien et alerte de Supervision (aucune correction). */
export async function runCrossAccountCheck(deps?: CrossAccountAlertDeps): Promise<CrossAccountAlertResult> {
  const d = deps ?? await defaultDeps();
  const rapport = await d.detect();
  const { toReport, toResolve } = planCrossAccountAlerts(rapport.checks, await d.openFingerprints());
  let reported = 0;
  for (const c of toReport) {
    const id = await d.report({
      domain: 'other',
      fingerprint: crossAccountFingerprint(c.code),
      title: `Sécurité : relations intercomptes — ${c.label} (${c.count})`,
      accountId: c.accountIds.length === 1 ? c.accountIds[0] : null,
      detail: {
        code: c.code,
        count: c.count,
        accountIds: c.accountIds.slice(0, 50).join(', '),
        refs: c.samples.slice(0, 20).map((s) => `${s.ref} [compte ${s.accountId ?? '?'} / ${s.otherAccountId ?? '?'}]`).join(' ; '),
        boLink: CROSS_ACCOUNT_BO_LINK,
        procedure: CROSS_ACCOUNT_PROCEDURE,
      },
    });
    if (id !== null) reported++;
  }
  let resolved = 0;
  for (const f of toResolve) if (await d.resolve(f)) resolved++;
  const errors: Record<string, string> = {};
  for (const c of rapport.checks) if (c.error) errors[c.code] = c.error;
  return {
    total: rapport.total,
    counts: Object.fromEntries(rapport.checks.map((c) => [c.code, c.count])),
    reported, resolved, errors,
  };
}
