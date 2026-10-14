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
import { isolationStatus, type CrossAccountCheckResult, type CrossAccountReport, type IsolationStatus } from './detection';

export const CROSS_ACCOUNT_ANOMALY_PREFIX = 'other:cross-account:';
export const CROSS_ACCOUNT_ANOMALY_ORIGIN = 'cross_account_check_cleared';

/** Lien BO du rapport complet. */
export const CROSS_ACCOUNT_BO_LINK = '/admin/exploitation?tab=intercomptes';

/** Procédure de remise en conformité (jamais automatique). */
export const CROSS_ACCOUNT_PROCEDURE =
  'Aucune correction automatique. Accès déjà neutralisés (lectures et écritures bornées au compte, garde en base). Correction contrôlée '
  + 'dans le BO : Exploitation › Rattrapages › « Isolation des comptes » (simuler, appliquer avec motif, restaurer) — '
  + 'docs/exploitation/relations-intercomptes.md.';

export function crossAccountFingerprint(code: string): string {
  return `${CROSS_ACCOUNT_ANOMALY_PREFIX}${code.toLowerCase()}`;
}

/** Lot 54 (SEC-07) : anomalie « contrôle incomplet » (au moins un contrôle non exécuté). */
export const CROSS_ACCOUNT_INCOMPLETE_FINGERPRINT = `${CROSS_ACCOUNT_ANOMALY_PREFIX}incomplete`;

export type IsolationCheckTrigger = 'scheduled' | 'manual' | 'bo';

/** Une exécution du contrôle, telle qu'historisée (`account_isolation_checks`, 0374). */
export interface IsolationCheckRecord {
  startedAt: string;
  trigger: IsolationCheckTrigger;
  status: IsolationStatus;
  total: number;
  checksTotal: number;
  checksFailed: number;
  counts: Record<string, number>;
  errors: Record<string, string>;
  accountIds: number[];
  reported: number;
  resolved: number;
}

export interface CrossAccountAlertDeps {
  detect: () => Promise<CrossAccountReport>;
  openFingerprints: () => Promise<string[]>;
  report: (input: import('@/services/admin/anomaly.service').ReportAnomalyInput) => Promise<number | null>;
  resolve: (fingerprint: string) => Promise<boolean>;
  /** Historise l'exécution (absente : rien n'est historisé). Ne lève jamais. */
  record?: (r: IsolationCheckRecord) => Promise<void>;
}

export interface CrossAccountAlertResult {
  /** Lot 54 (SEC-07) : Conforme / Anomalies détectées / Contrôle incomplet. */
  status: IsolationStatus;
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
 * pas s'il est revenu à 0). Lot 54 (SEC-07) : un contrôle INCOMPLET ouvre
 * l'anomalie « contrôle incomplet » ; elle n'est résolue que par un contrôle
 * intégralement exécuté.
 */
export function planCrossAccountAlerts(checks: readonly CrossAccountCheckResult[], open: readonly string[]): {
  toReport: CrossAccountCheckResult[];
  toResolve: string[];
  incomplete: CrossAccountCheckResult[];
} {
  const toReport = checks.filter((c) => !c.error && c.count > 0);
  const incomplete = checks.filter((c) => c.error);
  const gardees = new Set(checks.filter((c) => c.error || c.count > 0).map((c) => crossAccountFingerprint(c.code)));
  if (incomplete.length) gardees.add(CROSS_ACCOUNT_INCOMPLETE_FINGERPRINT);
  // Catégories retirées du catalogue : jamais résolues à l'aveugle non plus.
  const connues = new Set([...checks.map((c) => crossAccountFingerprint(c.code)), CROSS_ACCOUNT_INCOMPLETE_FINGERPRINT]);
  return {
    toReport, incomplete,
    toResolve: open.filter((f) => f.startsWith(CROSS_ACCOUNT_ANOMALY_PREFIX) && connues.has(f) && !gardees.has(f)),
  };
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
    resolve: (f) => anomalies.autoResolveAnomaly(f, { origin: CROSS_ACCOUNT_ANOMALY_ORIGIN, cause: 'Isolation des comptes : contrôle complet revenu à 0' }),
    record: recordIsolationCheck,
  };
}

/** Historise une exécution (0374). Table absente ou base indisponible : journalisé, jamais bloquant. */
export async function recordIsolationCheck(r: IsolationCheckRecord): Promise<void> {
  try {
    const { pgClient } = await import('@/db');
    await pgClient.unsafe(
      `INSERT INTO account_isolation_checks (started_at, trigger, status, total, checks_total, checks_failed, counts, errors, account_ids, reported, resolved)
       VALUES ($1::timestamptz, $2, $3, $4, $5, $6, $7::text::jsonb, $8::text::jsonb, $9::int[], $10, $11)`,
      [r.startedAt, r.trigger, r.status, r.total, r.checksTotal, r.checksFailed, JSON.stringify(r.counts), JSON.stringify(r.errors),
        `{${r.accountIds.slice(0, 200).join(',')}}`, r.reported, r.resolved] as never[],
    );
  } catch (e) {
    console.error('[isolation] historisation du contrôle impossible :', (e as Error).message);
  }
}

/** Historique et dernier contrôle complet (BO). `null` : historique indisponible (0374 absente). */
export async function readIsolationHistory(limit = 30): Promise<{
  runs: Array<IsolationCheckRecord & { id: number; finishedAt: string }>;
  lastComplete: string | null;
  lastConforme: string | null;
} | null> {
  try {
    const { pgClient } = await import('@/db');
    const rows = (await pgClient.unsafe(
      `SELECT id, started_at, finished_at, trigger, status, total, checks_total, checks_failed, counts, errors, account_ids, reported, resolved
         FROM account_isolation_checks ORDER BY finished_at DESC, id DESC LIMIT ${Math.max(1, Math.min(limit, 200))}`,
    )) as unknown as Array<Record<string, unknown>>;
    const [dates] = (await pgClient.unsafe(
      `SELECT (SELECT max(finished_at) FROM account_isolation_checks WHERE status <> 'INCOMPLET') AS last_complete,
              (SELECT max(finished_at) FROM account_isolation_checks WHERE status = 'CONFORME') AS last_conforme`,
    )) as unknown as Array<{ last_complete: Date | null; last_conforme: Date | null }>;
    const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
    return {
      runs: rows.map((r) => ({
        id: Number(r.id), startedAt: iso(r.started_at)!, finishedAt: iso(r.finished_at)!,
        trigger: r.trigger as IsolationCheckTrigger, status: r.status as IsolationStatus, total: Number(r.total),
        checksTotal: Number(r.checks_total), checksFailed: Number(r.checks_failed),
        counts: (r.counts ?? {}) as Record<string, number>, errors: (r.errors ?? {}) as Record<string, string>,
        accountIds: ((r.account_ids as number[] | null) ?? []).map(Number), reported: Number(r.reported), resolved: Number(r.resolved),
      })),
      lastComplete: iso(dates?.last_complete), lastConforme: iso(dates?.last_conforme),
    };
  } catch {
    return null;
  }
}

/**
 * Contrôle (quotidien ou manuel) et alerte de Supervision (aucune
 * correction). Lot 54 (SEC-07) : état à trois valeurs ; un contrôle non
 * exécuté (ou une détection impossible) → « Contrôle incomplet », alerte
 * dédiée, aucune résolution ; historisé (0374).
 */
export async function runCrossAccountCheck(deps?: CrossAccountAlertDeps, trigger: IsolationCheckTrigger = 'scheduled'): Promise<CrossAccountAlertResult> {
  const d = deps ?? await defaultDeps();
  const startedAt = new Date().toISOString();
  let rapport: CrossAccountReport;
  try {
    rapport = await d.detect();
  } catch (e) {
    // Détection impossible : diagnostic INCOMPLET, alerté, rien n'est résolu.
    const motif = (e as Error).message.slice(0, 300) || 'détection impossible';
    await d.report({
      domain: 'other', fingerprint: CROSS_ACCOUNT_INCOMPLETE_FINGERPRINT,
      title: 'Sécurité : isolation des comptes — contrôle incomplet (détection impossible)',
      detail: { motif, boLink: CROSS_ACCOUNT_BO_LINK },
    });
    const res: CrossAccountAlertResult = { status: 'INCOMPLET', total: 0, counts: {}, reported: 0, resolved: 0, errors: { DETECTION: motif } };
    await d.record?.({ startedAt, trigger, status: 'INCOMPLET', total: 0, checksTotal: 0, checksFailed: 0, counts: {}, errors: res.errors, accountIds: [], reported: 0, resolved: 0 });
    return res;
  }
  const { toReport, toResolve, incomplete } = planCrossAccountAlerts(rapport.checks, await d.openFingerprints());
  let reported = 0;
  for (const c of toReport) {
    const id = await d.report({
      domain: 'other',
      fingerprint: crossAccountFingerprint(c.code),
      title: `Sécurité : isolation des comptes — ${c.label} (${c.count})`,
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
  if (incomplete.length) {
    const id = await d.report({
      domain: 'other',
      fingerprint: CROSS_ACCOUNT_INCOMPLETE_FINGERPRINT,
      title: `Sécurité : isolation des comptes — contrôle incomplet (${incomplete.length} contrôle(s) non exécuté(s))`,
      detail: {
        codes: incomplete.map((c) => c.code).join(', '),
        motifs: incomplete.slice(0, 10).map((c) => `${c.code} : ${c.error}`).join(' ; '),
        boLink: CROSS_ACCOUNT_BO_LINK,
      },
    });
    if (id !== null) reported++;
  }
  let resolved = 0;
  for (const f of toResolve) if (await d.resolve(f)) resolved++;
  const errors: Record<string, string> = {};
  for (const c of rapport.checks) if (c.error) errors[c.code] = c.error;
  const status = rapport.status ?? isolationStatus(rapport.checks);
  const counts = Object.fromEntries(rapport.checks.map((c) => [c.code, c.count]));
  await d.record?.({
    startedAt, trigger, status, total: rapport.total, checksTotal: rapport.checks.length, checksFailed: incomplete.length,
    counts, errors, accountIds: rapport.accountIds, reported, resolved,
  });
  return { status, total: rapport.total, counts, reported, resolved, errors };
}
