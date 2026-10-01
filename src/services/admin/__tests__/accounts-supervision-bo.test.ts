/**
 * Comptes (ACC-L03..L05, ACC-D07..D11), Supervision (SUP-004, AI-001) et
 * rétention du journal (AUD-004) — CDC Back-Office V1.
 */
import { describe, it, expect } from 'vitest';
import {
  filterAccounts,
  pageAccounts,
  parseAccountFilters,
  sortAccounts,
  summarizeAccounts,
  type AccountListRow,
} from '@/services/admin/account-list.service';
import {
  accountAuditLabel,
  buildAccountHistory,
  originFromSource,
  type HistorySources,
} from '@/services/admin/account-history.service';
import { documentProcessingStatus, summarizeTechnicalError } from '@/services/admin/account-documents.service';
import {
  aiJobsFailedFingerprint,
  exportFailureFingerprint,
  fingerprintsToResolve,
  shouldReport,
} from '@/services/admin/supervision-sweep.service';
import { diagnosticLinkFor } from '@/services/admin/anomaly.service';
import { auditRetentionCutoff, parseAuditRetentionDays } from '@/services/admin/audit-retention.service';

const row = (over: Partial<AccountListRow>): AccountListRow => ({
  id: 1, name: 'A', planType: 'STANDARD', status: 'active', memberCount: 1, assetCount: 0,
  documentCount: 0, storageBytes: 0, createdAt: '2026-01-01', lastLoginAt: null, ...over,
});

describe('liste des comptes (ACC-L01, ACC-L03 à ACC-L05)', () => {
  const rows = [
    row({ id: 1, name: 'Beta', planType: 'PREMIUM', storageBytes: 10, createdAt: '2026-03-01', lastLoginAt: '2026-09-01' }),
    row({ id: 2, name: 'alpha', planType: 'STANDARD', status: 'suspended', storageBytes: 30, createdAt: '2026-01-01' }),
    row({ id: 3, name: 'Gamma', planType: 'PREMIUM_DUO', status: 'deletion_pending', storageBytes: 20, createdAt: '2026-02-01', lastLoginAt: '2026-08-01' }),
  ];

  it('filtres offre et statut, valeurs inconnues ignorées', () => {
    expect(parseAccountFilters(new URLSearchParams('plan=premium&status=suspended'))).toEqual({ plan: 'PREMIUM', status: 'suspended' });
    expect(parseAccountFilters(new URLSearchParams('plan=GOLD&status=zzz'))).toEqual({ plan: null, status: null });
    expect(filterAccounts(rows, { plan: 'PREMIUM', status: null }).map((r) => r.id)).toEqual([1]);
    expect(filterAccounts(rows, { plan: null, status: 'deletion_pending' }).map((r) => r.id)).toEqual([3]);
  });

  it('tri par stockage, offre, statut, dates (absentes en fin)', () => {
    expect(sortAccounts(rows, 'storage', 'desc').map((r) => r.id)).toEqual([2, 3, 1]);
    expect(sortAccounts(rows, 'plan', 'asc').map((r) => r.id)).toEqual([2, 1, 3]);
    expect(sortAccounts(rows, 'status', 'desc').map((r) => r.id)).toEqual([3, 2, 1]);
    expect(sortAccounts(rows, 'lastLogin', 'asc').map((r) => r.id)).toEqual([3, 1, 2]);
    expect(sortAccounts(rows, 'name', 'asc').map((r) => r.id)).toEqual([2, 1, 3]);
    expect(sortAccounts(rows, 'created', 'desc').map((r) => r.id)).toEqual([1, 3, 2]);
  });

  it('pagination classique et synthèse globale', () => {
    const p = pageAccounts(rows, { filters: { plan: null, status: null }, sort: 'name', dir: 'asc', page: 2, pageSize: 2 });
    expect(p).toMatchObject({ page: 2, total: 3, totalPages: 2 });
    expect(p.items.map((r) => r.id)).toEqual([3]);
    expect(summarizeAccounts(rows)).toEqual({ total: 3, active: 1, suspended: 1, deletionPending: 1 });
  });
});

describe('historique consolidé (ACC-D09 à ACC-D11)', () => {
  const src: HistorySources = {
    now: new Date('2026-09-26T00:00:00Z'),
    account: { createdAt: '2026-01-01T10:00:00Z' },
    subscription: {
      trialStartedAt: '2026-01-01T10:05:00Z',
      trialEndsAt: '2026-01-31T10:05:00Z',
      contractConcludedAt: '2026-01-31T10:06:00Z',
      firstBilledAt: null,
      cancelAtPeriodEnd: true,
      currentPeriodEndAt: '2026-10-31T00:00:00Z',
      status: 'active',
    },
    planChanges: [
      { at: '2026-03-01T00:00:00Z', oldTier: 'premium', newTier: 'premium_duo', source: 'admin:override' },
      { at: '2026-04-01T00:00:00Z', oldTier: 'premium_duo', newTier: 'premium', source: 'webhook:customer.subscription.updated' },
      { at: '2026-04-02T00:00:00Z', oldTier: 'premium', newTier: 'premium', source: 'webhook:x' },
    ],
    adminActions: [
      { at: '2026-05-01T00:00:00Z', actionType: 'ACCOUNT_SUSPEND', result: 'SUCCESS' },
      { at: '2026-05-02T00:00:00Z', actionType: 'ACCOUNT_REACTIVATE', result: 'SUCCESS' },
      { at: '2026-05-03T00:00:00Z', actionType: 'ACCOUNT_SUSPEND', result: 'FAILURE' },
    ],
    withdrawals: [],
    deletions: [{ createdAt: '2026-06-01T00:00:00Z', origin: 'admin', reason: 'ADMIN', status: 'SCHEDULED', cancelledAt: null, executedAt: null, scheduledAt: '2026-07-01T00:00:00Z' }],
    auditLogs: [{ at: '2026-02-01T00:00:00Z', actionType: 'MEMBER_JOINED', userEmail: 'a@x.fr', targetUserEmail: 'b@x.fr' }],
  };

  it('couvre le cycle de vie avec une origine par ligne, du plus récent au plus ancien', () => {
    const h = buildAccountHistory(src);
    const events = h.map((e) => `${e.event}|${e.origin}`);
    expect(events).toEqual(expect.arrayContaining([
      'Création du compte|user',
      'Début de l’essai|user',
      'Fin de l’essai|system',
      'Conversion payante|stripe',
      'Changement d’offre|admin',
      'Changement d’offre|stripe',
      'Suspension du compte|admin',
      'Réactivation du compte|admin',
      'Suppression du compte engagée|admin',
      'Utilisateur rattaché au compte|user',
      'Fin d’abonnement programmée (résiliation)|stripe',
    ]));
    // Échec d'action admin et « changement » sans changement : exclus.
    expect(h.filter((e) => e.event === 'Suspension du compte')).toHaveLength(1);
    expect(h.filter((e) => e.event === 'Changement d’offre')).toHaveLength(2);
    // Tri décroissant ; la fin programmée (future) est marquée.
    expect(h[0].event).toBe('Fin d’abonnement programmée (résiliation)');
    expect(h[0].scheduled).toBe(true);
    for (let i = 1; i < h.length; i++) expect(h[i - 1].at >= h[i].at).toBe(true);
  });

  it('CDC 13 point 3 : libellé exact selon la portée de la suppression', () => {
    const h = buildAccountHistory({
      ...src,
      deletions: [
        { createdAt: '2026-06-01T00:00:00Z', origin: 'user', reason: 'VOLUNTARY', status: 'EXECUTED', cancelledAt: null, executedAt: '2026-07-01T00:00:00Z', scheduledAt: null, scope: 'user', userEmail: 'b@x.fr' },
        { createdAt: '2026-06-02T00:00:00Z', origin: 'admin', reason: 'ADMIN', status: 'CANCELLED', cancelledAt: '2026-06-03T00:00:00Z', executedAt: null, scheduledAt: null, scope: 'account' },
      ],
    });
    const ev = (e: string) => h.find((x) => x.event === e);
    expect(ev('Suppression d’un utilisateur engagée (avec les comptes dont il est titulaire)')).toMatchObject({ origin: 'user', detail: expect.stringContaining('b@x.fr') });
    expect(ev('Suppression de l’utilisateur exécutée')).toBeDefined();
    expect(ev('Suppression du compte engagée')).toMatchObject({ origin: 'admin' });
    expect(ev('Suppression annulée')).toBeDefined();
    // Une suppression d'utilisateur n'est jamais présentée comme celle du compte.
    expect(h.filter((x) => x.event === 'Suppression du compte engagée')).toHaveLength(1);
  });

  it('origine déduite de la source et libellés lisibles', () => {
    expect(originFromSource('admin:override')).toBe('admin');
    expect(originFromSource('webhook:customer.subscription.deleted')).toBe('stripe');
    expect(originFromSource('cron:unpaid-cycle')).toBe('system');
    expect(accountAuditLabel('MEMBER_INVITED')).toBe('Invitation d’un utilisateur');
    expect(accountAuditLabel('SOME_THING')).toBe('Some thing');
  });
});

describe('documents du compte (ACC-D07, ACC-D08)', () => {
  it('statut de traitement consolidé', () => {
    expect(documentProcessingStatus('COMPLETED', null)).toBe('stored');
    expect(documentProcessingStatus(null, 'ANALYZED')).toBe('analyzed');
    expect(documentProcessingStatus('COMPLETED', 'ANALYSIS_FAILED')).toBe('analysis_failed');
    expect(documentProcessingStatus('FAILED', 'ANALYZED')).toBe('upload_failed');
    expect(documentProcessingStatus('PENDING', null)).toBe('uploading');
  });
  it('erreur technique résumée sur une ligne', () => {
    expect(summarizeTechnicalError('ligne 1\nstack…')).toBe('ligne 1');
    expect(summarizeTechnicalError('x'.repeat(300))!.length).toBe(158);
    expect(summarizeTechnicalError(null)).toBeNull();
  });
});

describe('Supervision : exports et IA (SUP-004, SUP-008, SUP-010, AI-001)', () => {
  it('une condition déjà signalée n’est re-signalée que pour une nouvelle occurrence', () => {
    const t = new Date('2026-09-26T10:00:00Z');
    expect(shouldReport(null, t)).toBe(true);
    expect(shouldReport(new Date('2026-09-26T11:00:00Z'), t)).toBe(false);
    expect(shouldReport(new Date('2026-09-26T09:00:00Z'), t)).toBe(true);
  });

  it('résout les anomalies ouvertes dont la condition a disparu, dans le seul domaine balayé', () => {
    const current = [{ fingerprint: exportFailureFingerprint(5, 'CIL_REGLEMENTAIRE'), occurredAt: new Date(), input: {} as never }];
    const open = [exportFailureFingerprint(5, 'CIL_REGLEMENTAIRE'), exportFailureFingerprint(6, 'DOSSIER_VENTE'), aiJobsFailedFingerprint('T1')];
    expect(fingerprintsToResolve(open, current, 'exports:')).toEqual([exportFailureFingerprint(6, 'DOSSIER_VENTE')]);
  });

  it('empreintes normalisées par domaine', () => {
    expect(exportFailureFingerprint(5, 'CIL_REGLEMENTAIRE')).toBe('exports:generation:asset:5:cil_reglementaire');
    expect(aiJobsFailedFingerprint('T3')).toBe('ai:jobs-failed:t3');
  });

  it('une anomalie IA renvoie vers l’écran IA pertinent (AI-001)', () => {
    expect(diagnosticLinkFor('ai', { treatment: 'T1' })?.href).toBe('/admin/ai-queue');
    expect(diagnosticLinkFor('exports', {})).toBeNull();
  });
});

describe('rétention du journal technique (AUD-004)', () => {
  it('sans valeur valide, aucune purge', () => {
    expect(parseAuditRetentionDays(undefined)).toBeNull();
    expect(parseAuditRetentionDays('')).toBeNull();
    expect(parseAuditRetentionDays('abc')).toBeNull();
    expect(parseAuditRetentionDays('7')).toBeNull();
    expect(parseAuditRetentionDays('365')).toBe(365);
  });
  it('date de coupure', () => {
    expect(auditRetentionCutoff(30, new Date('2026-09-30T00:00:00Z')).toISOString()).toBe('2026-08-31T00:00:00.000Z');
  });
});
