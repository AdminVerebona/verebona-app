/**
 * Lot 114H (Trello #775, P1-C) — campagne de réévaluation du stock
 * (`runCoverageReassessment`), base SIMULÉE en mémoire : pagination, point de
 * reprise, idempotence de deux campagnes, plusieurs comptes, documents
 * supprimés, migrations absentes, erreurs bornées, alertes closes / maintenues
 * / ouvertes, aucun appel IA. Le SQL lui-même n'est pas exécuté ici (scénario
 * `l114h-t1-reprises-historique.e2e.ts`, PostgreSQL réel).
 *
 *   S01  R7 — gros stock paginé, échéance de passage, reprise sans double
 *        traitement, seconde campagne sans effet ;
 *   S02  R7 — plusieurs comptes (isolation), document tenu par la reprise
 *        planifiée différé, erreur retentée puis abandonnée (bornée) ;
 *   S03  R6 — alertes : close si la cause a disparu, maintenue sinon, ouverte
 *        pour une lacune jamais signalée, jamais rouverte au passage suivant ;
 *        document supprimé ;
 *   S04  R7 — migrations absentes : campagne inactive, rien n'est écrit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Doc { fileId: number; accountId: number; qualityState: string; anomalies: string[]; nextRetryAt: string | null; losses: number; deleted?: boolean; busy?: boolean; throws?: number }
interface Journal { fileId: number; accountId: number; version: number; outcome: string; attempts: number; before: Record<string, unknown>; after: Record<string, unknown>; alerts: Array<Record<string, unknown>> }
interface Anomalie { id: number; fingerprint: string; status: 'open' | 'resolved'; accountId: number; origin?: string; cause?: string }

const base = vi.hoisted(() => ({
  docs: [] as Doc[], journal: [] as Journal[], anomalies: [] as Anomalie[],
  schema: { layer: true, m1665: true, m1705: true },
  /** État « après réconciliation » de chaque document (défaut : inchangé). */
  apres: new Map<number, Partial<Doc>>(),
  reconciliations: [] as Array<{ fileId: number; accountId: number; apply: boolean; origin: string }>,
  lectures: [] as Array<{ fileId: number; accountId: number | undefined }>,
  selections: 0,
}));

vi.mock('@/services/account/processing-eligibility', () => ({ processingEligibleSql: () => 'TRUE' }));
vi.mock('@/db', () => ({
  db: {},
  pgClient: {
    unsafe: async (q: string, p: unknown[] = []) => {
      const x = q.replace(/\s+/g, ' ').trim();
      if (/to_regclass\('t1_coverage_reassessments'\)/.test(x)) return [{ ok: base.schema.m1705 }];
      // A. sélection paginée du stock.
      if (x.startsWith('SELECT c.file_id, c.account_id, (c.next_retry_at IS NOT NULL')) {
        base.selections++;
        const [apres, etats, version, maxEssais, limite, , compte] = p as [number, string[], number, number, number, number, number | null];
        return base.docs.filter((d) => d.fileId > apres && !d.deleted && etats.includes(d.qualityState) && (compte === null || d.accountId === compte)
          && !base.journal.some((j) => j.fileId === d.fileId && j.version === version && (j.outcome !== 'ERROR' || j.attempts >= maxEssais)))
          .sort((a, b) => a.fileId - b.fileId).slice(0, limite)
          .map((d) => ({ file_id: d.fileId, account_id: d.accountId, reprise_active: d.busy === true }));
      }
      // Journal : une ligne par (document, version) ; une erreur est complétée, jamais une issue acquise.
      if (x.startsWith('INSERT INTO t1_coverage_reassessments')) {
        const [accountId, fileId, version, outcome, before, after, alerts] = p as [number, number, number, string, string, string, string];
        const j = base.journal.find((r) => r.fileId === fileId && r.version === version);
        const ligne = { fileId, accountId, version, outcome, before: JSON.parse(before), after: JSON.parse(after), alerts: JSON.parse(alerts) };
        if (!j) base.journal.push({ ...ligne, attempts: 1 });
        else if (j.outcome === 'ERROR') Object.assign(j, ligne, { attempts: j.attempts + 1 });
        return [];
      }
      // Alertes ouvertes d'un document.
      if (x.startsWith("SELECT id, fingerprint FROM admin_anomalies WHERE status = 'open' AND fingerprint = ANY")) {
        const fps = p[0] as string[];
        return base.anomalies.filter((a) => a.status === 'open' && fps.includes(a.fingerprint)).map((a) => ({ id: a.id, fingerprint: a.fingerprint }));
      }
      // B. alertes T1 ouvertes, par identifiant.
      if (x.startsWith('SELECT an.id, an.fingerprint, an.account_id FROM admin_anomalies an')) {
        const [apres, , , limite, compte] = p as [number, string, string, number, number | null];
        return base.anomalies.filter((a) => a.status === 'open' && a.id > apres && /^ai:t1-(completeness|normalisation-loss):/.test(a.fingerprint) && (compte === null || a.accountId === compte))
          .sort((a, b) => a.id - b.id).slice(0, limite).map((a) => ({ id: a.id, fingerprint: a.fingerprint, account_id: a.accountId }));
      }
      if (x.startsWith('SELECT af.id AS file, af.account_id, af.deleted_at')) {
        const d = base.docs.find((r) => r.fileId === p[0]);
        if (!d) return [{ file: null }];
        return [{ file: d.fileId, account_id: d.accountId, deleted_at: d.deleted ? '2026-01-01' : null, qualityState: d.qualityState, anomalies: d.anomalies, coverageRatio: 0.9, failedUnits: 0, truncatedSectionsCount: 0, droppedFactsCount: 0, verification: { normalisationLosses: d.losses } }];
      }
      throw new Error(`requête non prévue par le double : ${x.slice(0, 80)}`);
    },
  },
}));
vi.mock('@/services/admin/anomaly.service', () => ({
  autoResolveAnomaly: async (fingerprint: string, o: { origin: string; cause?: string }) => {
    const a = base.anomalies.find((r) => r.fingerprint === fingerprint && r.status === 'open');
    if (a) Object.assign(a, { status: 'resolved', origin: o.origin, cause: o.cause });
    return !!a;
  },
  reportAnomaly: async (p: { fingerprint: string; accountId: number }) => {
    const id = base.anomalies.length + 1000;
    base.anomalies.push({ id, fingerprint: p.fingerprint, status: 'open', accountId: p.accountId });
    return id;
  },
}));
const couvertureDe = (d: Doc) => ({
  fileId: d.fileId, accountId: d.accountId, qualityState: d.qualityState, anomalies: d.anomalies, coveredUnits: 8, unresolvedUnits: 2, uncertainUnits: 0, failedUnits: 0,
  totalSourceUnits: 10, retryAttempts: 2, nextRetryAt: d.nextRetryAt, lastRetryResult: null, verification: { normalisationLosses: d.losses }, coverageRatio: 0.8,
  truncatedSectionsCount: 0, droppedFactsCount: 0,
});
vi.mock('../repository', () => ({
  sourceLayerReady: async () => base.schema.layer,
  coverageProvenanceReady: async () => base.schema.m1665,
  loadDocumentCoverage: async (fileId: number, accountId?: number) => {
    base.lectures.push({ fileId, accountId });
    const d = base.docs.find((r) => r.fileId === fileId && r.accountId === accountId);
    return d ? couvertureDe(d) : null;
  },
}));
vi.mock('../stored-reverification', () => ({ reverificationDue: () => false, reverifyStoredCoverage: async () => { throw new Error('non attendu'); } }));
vi.mock('../stored-reconciliation', () => ({
  reconcileStoredDocumentCoverage: async (p: { fileId: number; accountId: number; apply: boolean; origin: string }) => {
    base.reconciliations.push(p);
    const d = base.docs.find((r) => r.fileId === p.fileId && r.accountId === p.accountId)!;
    if (d.throws && d.throws > 0) { d.throws--; throw new Error('base momentanément indisponible'); }
    const apres = base.apres.get(p.fileId);
    const avant = d.qualityState;
    if (apres) Object.assign(d, apres);
    return {
      outcome: apres ? 'APPLIED' : 'UNCHANGED', requalified: apres && d.qualityState !== avant && d.qualityState !== 'INCOMPLETE_FINAL' ? [{ unitId: 'page:1:block:2', rule: 'values_structured' }] : [],
      before: { qualityState: avant }, after: { qualityState: d.qualityState },
      retry: { pendingReleased: 0, actions: [], blocked: null, scheduledBefore: false, scheduledAfter: d.nextRetryAt !== null },
    };
  },
}));

const { runCoverageReassessment, T1_COVERAGE_RULES_VERSION, REASSESSMENT_MAX_ATTEMPTS } = await import('../historical-reassessment');

const doc = (fileId: number, over: Partial<Doc> = {}): Doc => ({ fileId, accountId: 1, qualityState: 'COMPLETE_WITH_UNRESOLVED', anomalies: [], nextRetryAt: null, losses: 0, ...over });
const alerte = (id: number, fingerprint: string, accountId = 1): Anomalie => ({ id, fingerprint, status: 'open', accountId });

beforeEach(() => {
  base.docs = []; base.journal = []; base.anomalies = []; base.schema = { layer: true, m1665: true, m1705: true };
  base.apres = new Map(); base.reconciliations = []; base.lectures = []; base.selections = 0;
});

describe('L114H-S01 — R7 : gros stock, pagination, point de reprise, idempotence', () => {
  it('250 documents, lots de 100 : tous examinés une seule fois, en ordre, sans appel IA', async () => {
    base.docs = Array.from({ length: 250 }, (_, i) => doc(i + 1));
    const r = await runCoverageReassessment({ env: { T1_REASSESSMENT_BATCH: '100' } });
    expect(r).toMatchObject({ rulesVersion: T1_COVERAGE_RULES_VERSION, examined: 250, errors: 0, deferred: 0, more: false, aiCalls: 0, byOutcome: { UNCHANGED: 250 } });
    expect(base.journal).toHaveLength(250);
    expect(base.reconciliations.map((x) => x.fileId)).toEqual(base.docs.map((d) => d.fileId));
    expect(base.reconciliations.every((x) => x.apply && x.origin === `t1-coverage-reassessment:v${T1_COVERAGE_RULES_VERSION}`)).toBe(true);
    expect(base.selections).toBe(3);
  });

  it('passage interrompu (lots bornés) puis repris : aucun document traité deux fois ; seconde campagne : rien', async () => {
    base.docs = Array.from({ length: 25 }, (_, i) => doc(i + 1));
    const un = await runCoverageReassessment({ env: { T1_REASSESSMENT_BATCH: '10' }, maxBatches: 1 });
    expect(un).toMatchObject({ examined: 10, more: true });
    const deux = await runCoverageReassessment({ env: { T1_REASSESSMENT_BATCH: '10' } });
    expect(deux).toMatchObject({ examined: 15, more: false });
    expect(base.reconciliations).toHaveLength(25);
    expect(new Set(base.reconciliations.map((x) => x.fileId)).size).toBe(25);
    const trois = await runCoverageReassessment({ env: { T1_REASSESSMENT_BATCH: '10' } });
    expect(trois).toMatchObject({ examined: 0, more: false, alertsClosed: 0 });
    expect(base.reconciliations).toHaveLength(25);
    expect(base.journal).toHaveLength(25);
  });

  it('échéance de passage dépassée : arrêt propre, « encore du travail », reprise au passage suivant', async () => {
    base.docs = Array.from({ length: 5 }, (_, i) => doc(i + 1));
    const r = await runCoverageReassessment({ deadline: 1 });
    expect(r).toMatchObject({ examined: 0, more: true });
    expect((await runCoverageReassessment({})).examined).toBe(5);
  });

  it('documents complets ou supprimés : hors inventaire', async () => {
    base.docs = [doc(1, { qualityState: 'COMPLETE' }), doc(2, { deleted: true }), doc(3, { qualityState: 'VERIFICATION_INCOMPLETE' }), doc(4, { qualityState: 'INCOMPLETE_FINAL' }), doc(5, { qualityState: 'INCOMPLETE_RETRYABLE' })];
    const r = await runCoverageReassessment({});
    expect(base.reconciliations.map((x) => x.fileId)).toEqual([3, 4, 5]);
    expect(r.examined).toBe(3);
  });
});

describe('L114H-S02 — R7 : plusieurs comptes, document tenu par la reprise planifiée, erreurs bornées', () => {
  it('chaque document est lu et écrit avec SON compte ; passage limité à un compte', async () => {
    base.docs = [doc(1, { accountId: 1 }), doc(2, { accountId: 2 }), doc(3, { accountId: 1 })];
    await runCoverageReassessment({ accountId: 2 });
    expect(base.reconciliations).toEqual([expect.objectContaining({ fileId: 2, accountId: 2 })]);
    await runCoverageReassessment({});
    expect(base.reconciliations.map((x) => [x.fileId, x.accountId])).toEqual([[2, 2], [1, 1], [3, 1]]);
    expect(base.lectures.every((l) => l.accountId === base.docs.find((d) => d.fileId === l.fileId)!.accountId)).toBe(true);
    expect(base.journal.map((j) => [j.fileId, j.accountId]).sort()).toEqual([[1, 1], [2, 2], [3, 1]]);
  });

  it('reprise planifiée en cours ou imminente : document DIFFÉRÉ (aucune écriture concurrente), repris ensuite', async () => {
    base.docs = [doc(1, { busy: true }), doc(2)];
    const r = await runCoverageReassessment({});
    expect(r).toMatchObject({ examined: 1, deferred: 1, more: true });
    expect(base.reconciliations.map((x) => x.fileId)).toEqual([2]);
    base.docs[0].busy = false;
    expect(await runCoverageReassessment({})).toMatchObject({ examined: 1, deferred: 0, more: false });
  });

  it('erreur : journalisée, retentée, puis abandonnée après le nombre d’essais permis — jamais une boucle', async () => {
    base.docs = [doc(1, { throws: 99 }), doc(2)];
    for (let i = 0; i < REASSESSMENT_MAX_ATTEMPTS; i++) {
      const r = await runCoverageReassessment({});
      expect(r.errors).toBe(1);
      expect(r.more).toBe(true);
    }
    expect(base.journal.find((j) => j.fileId === 1)).toMatchObject({ outcome: 'ERROR', attempts: REASSESSMENT_MAX_ATTEMPTS });
    const fin = await runCoverageReassessment({});
    expect(fin).toMatchObject({ examined: 0, errors: 0, more: false });
    expect(base.journal.find((j) => j.fileId === 2)).toMatchObject({ outcome: 'UNCHANGED', attempts: 1 });
  });

  it('erreur passagère : le document aboutit au passage suivant (issue acquise, plus jamais réécrite)', async () => {
    base.docs = [doc(1, { throws: 1 })];
    await runCoverageReassessment({});
    await runCoverageReassessment({});
    expect(base.journal).toEqual([expect.objectContaining({ fileId: 1, outcome: 'UNCHANGED', attempts: 2 })]);
  });
});

describe('L114H-S03 — R6 : alertes closes seulement si la cause a disparu', () => {
  it('document redevenu non définitif : alerte CLOSE avec règle, version et cause ; avant / après au journal', async () => {
    base.docs = [doc(1, { qualityState: 'INCOMPLETE_FINAL', anomalies: ['COVERAGE_INCOMPLETE'] })];
    base.apres.set(1, { qualityState: 'COMPLETE_WITH_UNRESOLVED', anomalies: [] });
    base.anomalies = [alerte(10, 'ai:t1-completeness:1')];
    const r = await runCoverageReassessment({});
    expect(r).toMatchObject({ alertsClosed: 1, alertsMaintained: 0, alertsOpened: 0, byOutcome: { RECONCILED: 1 } });
    expect(base.anomalies[0]).toMatchObject({ status: 'resolved', origin: `t1_coverage_reassessment:v${T1_COVERAGE_RULES_VERSION}` });
    expect(base.anomalies[0].cause).toContain('COMPLETE_WITH_UNRESOLVED');
    expect(base.journal[0]).toMatchObject({
      before: { qualityState: 'INCOMPLETE_FINAL', anomalies: ['COVERAGE_INCOMPLETE'] }, after: { qualityState: 'COMPLETE_WITH_UNRESOLVED', anomalies: [] },
      alerts: [{ fingerprint: 'ai:t1-completeness:1', anomalyId: 10, action: 'CLOSED' }],
    });
  });

  it('lacune réelle toujours présente : alerte MAINTENUE ; perte de normalisation réelle : MAINTENUE ; rien n’est effacé', async () => {
    base.docs = [doc(1, { qualityState: 'INCOMPLETE_FINAL', losses: 2 })];
    base.anomalies = [alerte(10, 'ai:t1-completeness:1'), alerte(11, 'ai:t1-normalisation-loss:1')];
    const r = await runCoverageReassessment({});
    expect(r).toMatchObject({ alertsClosed: 0, alertsMaintained: 2, alertsOpened: 0 });
    expect(base.anomalies.map((a) => a.status)).toEqual(['open', 'open']);
  });

  it('lacune réelle devenue définitive et jamais signalée : alerte OUVERTE une fois ; passage suivant : ni doublon ni réouverture', async () => {
    base.docs = [doc(1, { qualityState: 'INCOMPLETE_RETRYABLE', nextRetryAt: '2030-01-01T00:00:00.000Z' })];
    base.apres.set(1, { qualityState: 'INCOMPLETE_FINAL', nextRetryAt: null });
    const r = await runCoverageReassessment({});
    expect(r).toMatchObject({ alertsOpened: 1, retriesCancelled: 1, byOutcome: { FINAL_GAP: 1 } });
    expect(base.anomalies).toEqual([expect.objectContaining({ fingerprint: 'ai:t1-completeness:1', status: 'open', accountId: 1 })]);
    const suivant = await runCoverageReassessment({});
    expect(suivant).toMatchObject({ examined: 0, alertsOpened: 0, alertsClosed: 0, alertsMaintained: 1 });
    expect(base.anomalies).toHaveLength(1);
  });

  it('alerte close par la campagne : le passage suivant ne la rouvre pas (aucun fait nouveau)', async () => {
    base.docs = [doc(1, { qualityState: 'VERIFICATION_INCOMPLETE' })];
    base.anomalies = [alerte(10, 'ai:t1-completeness:1')];
    await runCoverageReassessment({});
    expect(base.anomalies[0].status).toBe('resolved');
    await runCoverageReassessment({});
    await runCoverageReassessment({});
    expect(base.anomalies).toHaveLength(1);
    expect(base.anomalies[0].status).toBe('resolved');
  });

  it('alertes sans document éligible : document supprimé ou inconnu → close ; couverture complète → close ; autre alerte IA → jamais touchée', async () => {
    base.docs = [doc(1, { deleted: true, qualityState: 'INCOMPLETE_FINAL' }), doc(2, { qualityState: 'COMPLETE' }), doc(3, { qualityState: 'COMPLETE', losses: 1 })];
    base.anomalies = [
      alerte(10, 'ai:t1-completeness:1'), alerte(11, 'ai:t1-completeness:2'), alerte(12, 'ai:t1-normalisation-loss:3'),
      alerte(13, 'ai:t1-completeness:999'), alerte(14, 'ai:schema-compat:t1'), alerte(15, 'ai:t1-requeue:2'),
    ];
    const r = await runCoverageReassessment({});
    expect(r).toMatchObject({ examined: 0, orphanAlertsExamined: 4, alertsClosed: 3, alertsMaintained: 1 });
    expect(base.anomalies.map((a) => [a.id, a.status])).toEqual([[10, 'resolved'], [11, 'resolved'], [12, 'open'], [13, 'resolved'], [14, 'open'], [15, 'open']]);
    expect(base.anomalies[0].cause).toContain('document supprimé');
    expect(base.journal).toEqual([]);
  });
});

describe('L114H-S04 — R7 : migrations absentes', () => {
  it.each([
    ['couche A absente', { layer: false, m1665: true, m1705: true }, 'SOURCE_LAYER_MISSING'],
    ['migration 1665 absente', { layer: true, m1665: false, m1705: true }, 'MIGRATION_1665_MISSING'],
    ['migration 1705 absente', { layer: true, m1665: true, m1705: false }, 'MIGRATION_1705_MISSING'],
  ])('%s : campagne inactive, aucune lecture de document, aucune écriture', async (_nom, schema, motif) => {
    base.schema = schema;
    base.docs = [doc(1, { qualityState: 'INCOMPLETE_FINAL' })];
    base.anomalies = [alerte(10, 'ai:t1-completeness:1')];
    const r = await runCoverageReassessment({});
    expect(r).toMatchObject({ disabled: motif, examined: 0, more: false });
    expect(base.reconciliations).toEqual([]);
    expect(base.journal).toEqual([]);
    expect(base.anomalies[0].status).toBe('open');
  });
});
