/**
 * Lot 54 (54B) — ticket SEC-P0-CORR : tests unitaires (sans base) de SEC-01
 * (droit actif relu à chaque requête), SEC-06 (inventaire et couverture des
 * catégories), SEC-07 (trois états, jamais « conforme » si incomplet),
 * SEC-08 (écran « Isolation des comptes »), SEC-09 (procédure d'incident,
 * recontrôle), SEC-02 (migration 0373 : garde différée, exceptions), SEC-10
 * (commande agrégée). Preuves sur PostgreSQL : `l54b-sec-p0-isolation.e2e.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { __setAccountAccessCheckForTests, hasActiveAccountAccess } from '@/lib/auth/account-access';
import { CROSS_ACCOUNT_CHECKS, isolationStatus, detectCrossAccountRelations, type CrossAccountCheckResult } from '../cross-account/detection';
import {
  CROSS_ACCOUNT_INCOMPLETE_FINGERPRINT, crossAccountFingerprint, planCrossAccountAlerts, runCrossAccountCheck, type IsolationCheckRecord,
} from '../cross-account/alerts';
import { REMEDIATION_FAMILIES, REMEDIATION_SPECS } from '../cross-account/remediation';
import { BACKFILL_DEFINITIONS } from '@/services/admin/ops/backfill/definitions';

vi.mock('@/db', async (orig) => ({
  ...(await orig<typeof import('@/db')>()),
  getUserSessionCutoff: vi.fn(async () => null),
}));

const ROOT = process.cwd();
const lire = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const res = (code: string, count: number, error?: string): CrossAccountCheckResult => ({
  code, family: 'documents', label: code, count, accountIds: count ? [1, 2] : [], samples: [], ...(error ? { error } : {}),
});
const tous = (n = 0) => CROSS_ACCOUNT_CHECKS.map((c) => res(c.code, n));

afterEach(() => { __setAccountAccessCheckForTests(async () => true); vi.restoreAllMocks(); });

describe('SEC-01 — révocation effective des droits', () => {
  it('SEC-01-01 — un jeton dont le compte n’est plus accessible est refusé (INVALID_TOKEN, renouvellement vers les autres espaces)', async () => {
    const { generateAccessToken } = await import('@/lib/jwt');
    const token = await generateAccessToken({ id: 501, email: 'm@exemple.fr', role: 'USER' as never, planType: 'PREMIUM' as never, status: 'ACTIVE' as never, currentAccountId: 77, hasActiveAccount: true });
    const req = () => new NextRequest('http://localhost:3000/api/assets', { headers: { cookie: `access_token=${token}` } });
    const { SessionService } = await import('@/lib/session-service');
    const vus: Array<[number, number]> = [];
    __setAccountAccessCheckForTests(async (u, a) => { vus.push([u, a]); return true; });
    await expect(SessionService.getSession(req())).resolves.toMatchObject({ userId: 501, currentAccountId: 77 });
    __setAccountAccessCheckForTests(async () => false);
    await expect(SessionService.getSession(req())).rejects.toThrow('INVALID_TOKEN');
    expect(vus).toEqual([[501, 77]]);
    // Routes hors SessionService (verifySessionAccessToken) : même règle.
    const { verifySessionAccessToken } = await import('@/lib/auth/session-guard');
    expect(await verifySessionAccessToken(token, { method: 'GET', nextUrl: { pathname: '/api/notifications' } })).toBeNull();
  });

  it('SEC-01-02 — vérification impossible → SESSION_UNAVAILABLE (503), jamais un faux droit actif ; aucun cache', async () => {
    __setAccountAccessCheckForTests(async () => { throw new Error('base injoignable'); });
    await expect(hasActiveAccountAccess(5, 6)).rejects.toThrow('SESSION_UNAVAILABLE');
    let n = 0;
    __setAccountAccessCheckForTests(async () => { n++; return true; });
    await hasActiveAccountAccess(5, 6); await hasActiveAccountAccess(5, 6);
    expect(n).toBe(2);
    expect(await hasActiveAccountAccess(5, 0)).toBe(false);
  });

  it('SEC-01-03 — droits pris en compte : adhésion active OU titulaire ; Duo seul n’ouvre aucun compte ; retrait/départ invalident les caches', () => {
    const src = lire('src/lib/auth/account-access.ts');
    expect(src).toMatch(/FROM account_memberships[\s\S]*status IN \('active', 'ACTIVE'\)/);
    expect(src).toMatch(/owner_user_id = \$\{userId\}/);
    expect(src).not.toMatch(/serverCacheSet|serverCacheGet/);
    const svc = lire('src/services/account-service.ts');
    expect(svc.match(/invalidateAccountReadCache\(accountId\)/g)?.length).toBe(2);
    // Lot 72D : le membre d'un Duo accède au compte partagé par son ADHÉSION
    // (garde commune ci-dessus) ; les anciennes routes Duo de récupération et
    // de demandes croisées sont retirées (410).
    for (const r of ['src/app/api/duos/[id]/recovery/assets/route.ts', 'src/app/api/duos/[id]/requests/inbox/route.ts']) {
      expect(lire(r), r).toContain('duoRouteRemoved');
    }
  });
});

describe('SEC-07 — supervision fiable : trois états', () => {
  it('SEC-07-01 — Conforme seulement si TOUS les contrôles ont réussi et valent 0', () => {
    expect(isolationStatus(tous(0))).toBe('CONFORME');
    expect(isolationStatus(tous(0).map((c, i) => (i === 0 ? { ...c, count: 1 } : c)))).toBe('ANOMALIES');
    // Un seul contrôle en échec, compteurs à 0 : jamais conforme.
    expect(isolationStatus(tous(0).map((c, i) => (i === 3 ? { ...c, error: 'statement timeout' } : c)))).toBe('INCOMPLET');
    // Contrôle manquant (non exécuté) : incomplet.
    expect(isolationStatus(tous(0).slice(1))).toBe('INCOMPLET');
  });

  it('SEC-07-02 — contrôle partiellement échoué : jamais conforme, alerte « incomplet », aucune résolution de son anomalie', async () => {
    const checks = tous(0).map((c, i) => (i === 0 ? { ...c, error: 'relation absente' } : c));
    const plan = planCrossAccountAlerts(checks, [crossAccountFingerprint(checks[0].code), crossAccountFingerprint(checks[1].code), CROSS_ACCOUNT_INCOMPLETE_FINGERPRINT]);
    expect(plan.toResolve).toEqual([crossAccountFingerprint(checks[1].code)]);
    const report = vi.fn(async () => 1);
    const record = vi.fn(async (_r: IsolationCheckRecord) => {});
    const r = await runCrossAccountCheck({
      detect: async () => ({ computedAt: 'x', status: 'INCOMPLET', checksFailed: 1, total: 0, accountIds: [], readOnly: true, checks }),
      openFingerprints: async () => [], report, resolve: async () => true, record,
    }, 'manual');
    expect(r.status).toBe('INCOMPLET');
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ fingerprint: CROSS_ACCOUNT_INCOMPLETE_FINGERPRINT }));
    expect(record.mock.calls[0][0]).toMatchObject({ trigger: 'manual', status: 'INCOMPLET', checksFailed: 1 });
  });

  it('SEC-07-03 — détection impossible : INCOMPLET, alerté et historisé, rien résolu', async () => {
    const resolve = vi.fn(async () => true);
    const record = vi.fn(async (_r: IsolationCheckRecord) => {});
    const r = await runCrossAccountCheck({
      detect: async () => { throw new Error('base injoignable'); },
      openFingerprints: async () => [crossAccountFingerprint('DOC_ASSET')], report: async () => 1, resolve, record,
    });
    expect(r.status).toBe('INCOMPLET');
    expect(resolve).not.toHaveBeenCalled();
    expect(record.mock.calls[0][0].status).toBe('INCOMPLET');
  });

  it('SEC-07-04 — contrôle complet revenu à 0 : « incomplet » et anomalies résolus ; conforme historisé', async () => {
    const resolve = vi.fn(async () => true);
    const r = await runCrossAccountCheck({
      detect: async () => ({ computedAt: 'x', status: 'CONFORME', checksFailed: 0, total: 0, accountIds: [], readOnly: true, checks: tous(0) }),
      openFingerprints: async () => [CROSS_ACCOUNT_INCOMPLETE_FINGERPRINT, crossAccountFingerprint('DOC_ASSET')],
      report: async () => 1, resolve,
    });
    expect(r.status).toBe('CONFORME');
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('SEC-07-05 — détection : un contrôle en échec est rendu « non exécuté » et l’état global vaut INCOMPLET', async () => {
    const exec = async <T>(fn: (q: (s: string) => Promise<Array<Record<string, unknown>>>) => Promise<T>) => fn(async (s) => {
      if (/SAVEPOINT|RELEASE|ROLLBACK/.test(s)) return [];
      if (s.includes('asset_photos')) throw new Error('relation "asset_photos" does not exist');
      return [{ n: 0, accounts: [], samples: [] }];
    });
    const r = await detectCrossAccountRelations(exec);
    expect(r.status).toBe('INCOMPLET');
    expect(r.checksFailed).toBeGreaterThan(0);
  });

  it('SEC-07-06 — tâche quotidienne 7 h 05 maintenue, lancement manuel, échec global si incomplet', async () => {
    const { findTask } = await import('@/services/scheduling/scheduled-tasks.catalog');
    const t = findTask('cross-account-relations-check')!;
    expect(t.schedule).toMatchObject({ kind: 'daily', at: [7, 5] });
    const cat = lire('src/services/scheduling/scheduled-tasks.catalog.ts');
    expect(cat).toMatch(/r\.status === 'INCOMPLET' \? \{ error/);
    expect(cat).toMatch(/trigger === 'manual' \? 'manual' : 'scheduled'/);
  });
});

describe('SEC-06 / SEC-09 — couverture et remédiation', () => {
  it('SEC-06-01 — familles du ticket couvertes, dont Opérations/Sinistres et photos', () => {
    const codes = CROSS_ACCOUNT_CHECKS.map((c) => c.code);
    for (const c of ['PHOTO_FILE', 'CLAIM_CONTRACT', 'CLAIM_HISTORY_EVENT', 'CLAIM_DAMAGE_DOCUMENT', 'CLAIM_DAMAGE_PHOTO', 'OP_CORE_LINK', 'AI_JOB_PENDING']) {
      expect(codes, c).toContain(c);
    }
    // Lot 84A (O-10) : actions et échanges de l'ancien modèle Sinistres (tables supprimées par la finalisation BO) — plus contrôlés.
    for (const c of ['CLAIM_ACTION_REF', 'CLAIM_EXCHANGE_DOCUMENT']) expect(codes, c).not.toContain(c);
    // Jobs : contexte imbriqué et cibles « compte » contrôlés.
    const jobs = CROSS_ACCOUNT_CHECKS.find((c) => c.code === 'AI_JOB_PENDING')!.sql;
    expect(jobs).toContain("lax $.**.fileId[*]");
    expect(jobs).toContain("'business_operations', 'business_operations_agenda'");
    // Diagnostic Opérations (CROSS_ACCOUNT_LINK) : photos et références documentaires.
    const diag = lire('src/services/business-operations/diagnostics/service.ts');
    for (const t of ['business_operation_claim_damage_photos', 'cd.history_event_id']) expect(diag, t).toContain(t);
    for (const t of ['business_operation_claim_actions', 'business_operation_claim_exchanges']) expect(diag, t).not.toContain(t);
  });

  it('SEC-09-01 — une étape BO par famille (dont Opérations) ; liens « cœur » en procédure d’incident, jamais corrigés', () => {
    const def = BACKFILL_DEFINITIONS.find((d) => d.script === 'cross-account')!;
    expect(def.steps!.map((s) => s.code)).toEqual([...REMEDIATION_FAMILIES]);
    expect(REMEDIATION_FAMILIES).toContain('operations');
    const core = REMEDIATION_SPECS.find((s) => s.code === 'OP_CORE_LINK')!;
    expect(core.parts).toEqual([]);
    expect(core.manual).toMatch(/Procédure d’incident/);
    // Recontrôle d'intégrité après application.
    expect(lire('src/services/security/cross-account/remediation.ts')).toMatch(/if \(o\.apply\) report\.postCheck = await recontroler/);
  });

  it('SEC-09-02 — rattrapage « Biens déplacés » : seulement les déplacements PROUVÉS (variante prudente)', () => {
    const src = lire('src/services/assets/asset-account-backfill.ts');
    expect(src).toMatch(/m\.status = 'ACCEPTED' AND m\.target_account_id/);
    expect(src).toMatch(/findMisplacedAssetData\(p\.batchSize \?\? BATCH, \{ proven: true \}\)/);
  });
});

describe('SEC-08 — BO › Exploitation › Isolation des comptes', () => {
  it('SEC-08-01 — libellé, états, dernier contrôle complet, incomplets, historique ; aucune fonction de partage', () => {
    expect(lire('src/app/admin/exploitation/page.tsx')).toContain("label: 'Isolation des comptes'");
    const panel = lire('src/app/admin/exploitation/_components/CrossAccountPanel.tsx');
    for (const t of ['État global de l’isolation', 'Dernier contrôle complet réussi', 'Contrôles incomplets ou indisponibles', 'Historique des contrôles', 'Corrections appliquées', 'Identifiants techniques']) {
      expect(panel, t).toContain(t);
    }
    expect(panel).not.toMatch(/from '@\/db'/);
    // Modules serveur (détection, alertes) : types seulement côté navigateur.
    for (const l of panel.split('\n').filter((x) => /cross-account\/(detection|alerts)'/.test(x))) expect(l, l).toMatch(/^import type /);
    expect(panel).not.toMatch(/Partager|Associer|Relier/);
    const route = lire('src/app/api/admin/ops/cross-account/route.ts');
    expect(route).toContain('requireAdmin');
    expect(route).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
  });
});

describe('SEC-02 — migration 0373 (garde en base)', () => {
  const m = lire('src/db/migrations/0373_account_isolation_guard.sql');
  it('SEC-02-01 — références directes : garde DIFFÉRÉE (état final à la validation), exception de restauration, aucune validation rétroactive', () => {
    for (const t of ['asset_files', 'events', 'deadlines', 'document_asset_links', 'agenda_item_sources', 'agenda_items', 'field_evidence', 'document_facts', 'ai_field_updates', 'to_process_actions']) {
      expect(m, t).toMatch(new RegExp(`CREATE CONSTRAINT TRIGGER ${t}_isolation_guard[\\s\\S]*?DEFERRABLE INITIALLY DEFERRED`));
    }
    expect(m).toMatch(/current_setting\('verebona\.cross_account_restore', true\) = 'on'/);
    expect(m).toMatch(/CREATE CONSTRAINT TRIGGER assets_isolation_owner_guard[\s\S]*AFTER UPDATE OF account_id ON assets/);
    expect(m).not.toMatch(/CREATE INDEX(?! CONCURRENTLY)/);
    expect(m).not.toMatch(/\b(UPDATE|DELETE FROM)\s+(asset_files|events|assets)\s+SET/);
  });
  it('SEC-02-02 — les 8 gardes 0332 restent seules nommées *_cross_account_guard (nouvelles gardes : *_isolation_guard)', () => {
    expect(m).not.toMatch(/CREATE (CONSTRAINT )?TRIGGER \w+_cross_account_guard/);
  });
});

describe('SEC-10 — commande de tests de sécurité', () => {
  it('SEC-10-01 — npm run test:security : tests unitaires ET e2e PostgreSQL intercomptes', () => {
    const pkg = JSON.parse(lire('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:security']).toBeDefined();
    expect(pkg.scripts['test:security:e2e']).toMatch(/vitest\.e2e\.config\.ts/);
    for (const f of ['l49-sec-p0-intercomptes', 'l53b-d23-intercomptes', 'l54b-sec-p0-isolation']) expect(pkg.scripts['test:security:e2e']).toContain(f);
  });
});
