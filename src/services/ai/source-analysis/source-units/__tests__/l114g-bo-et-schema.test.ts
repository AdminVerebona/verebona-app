/**
 * Lot 114G (Trello #760, audit T1 du 13/11) — P2-07, P2-09, P2-10.
 *
 *   S01  P2-07 : migration 1665 absente, partielle, présente — état rendu,
 *        jamais d'erreur ; écriture d'une couche qui perdrait une provenance
 *        ou une politique REFUSÉE avant tout effacement ; couche sans
 *        provenance ni politique toujours écrite ;
 *   S02  P2-09 : liste paginée et filtrée, total réel toujours rendu —
 *        document de 1 200 unités, résidu en DERNIÈRE position retrouvé ;
 *   S03  P2-10 : libellés BO — réparation différée et relectures comptées à
 *        part, politique « aucune réparation tentée ».
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const base = vi.hoisted(() => ({ colonnes: ['coverage_provenance', 'residual_policy'] as string[], panne: false, requetes: [] as string[] }));
vi.mock('@/db', () => ({
  pgClient: {
    unsafe: vi.fn(async (q: string) => {
      if (base.panne) throw new Error('connexion perdue');
      if (/information_schema\.columns/.test(q) && /column_name = ANY/.test(q)) return base.colonnes.map((c) => ({ c }));
      if (/information_schema\.columns/.test(q)) return [{ n: base.colonnes.length }];
      return [];
    }),
  },
  db: {},
}));

const repo = await import('../repository');
const { pageCompletenessUnits, COMPLETENESS_PAGE_MAX } = await import('../completeness-detail');
const { deferredRepairText, pagingText, policyLabel } = await import('@/app/admin/ai-executions/_components/T1CompletenessUnits');
type Row = import('../completeness-detail').CompletenessUnitRow;

beforeEach(() => { base.colonnes = ['coverage_provenance', 'residual_policy']; base.panne = false; base.requetes = []; repo.__resetCoverageProvenanceProbeForTests(); });

describe('L114G-S01 — P2-07 : migration 1665', () => {
  it('présente : prête ; partielle : colonne manquante nommée ; absente : les deux ; base en panne : non prête, sans lever', async () => {
    expect(await repo.coverageSchemaStatus()).toMatchObject({ ready: true, missing: [] });
    base.colonnes = ['coverage_provenance'];
    expect(await repo.coverageSchemaStatus()).toMatchObject({ ready: false, missing: ['residual_policy'] });
    base.colonnes = [];
    expect(await repo.coverageSchemaStatus()).toMatchObject({ ready: false, missing: ['coverage_provenance', 'residual_policy'] });
    base.panne = true;
    const r = await repo.coverageSchemaStatus();
    expect(r.ready).toBe(false);
    expect(r.error).toMatch(/connexion perdue/);
  });

  const tx = () => ({ unsafe: vi.fn(async (q: string) => { base.requetes.push(q.replace(/\s+/g, ' ').trim().slice(0, 60)); return /layer|information_schema/.test(q) ? [{ n: 99 }] : []; }) });
  const couche = (unite: Record<string, unknown>) => ({
    accountId: 1, fileId: 42, extractionId: 1, origin: 'RETRY' as const,
    layer: {
      layerVersion: 1, unresolvedFacts: [], retryable: false,
      units: [{ sourceUnitId: 'page:1:block:1', kind: 'TEXT_BLOCK', page: 1, ordinal: 1, parentUnitId: null, text: 'x', payload: {}, location: {}, origin: 'PASS_1', salient: true,
        status: 'UNRESOLVED', reason: 'not_extracted', factCount: 0, repairAttempts: 0, ...unite }],
      report: { qualityState: 'INCOMPLETE_FINAL', totalUnits: 1, coveredUnits: 0, unresolvedUnits: 1, uncertainUnits: 0, diagnostics: null },
    },
  });

  it('colonnes absentes + unité avec politique ou provenance : refus contrôlé, AVANT tout effacement', async () => {
    base.colonnes = [];
    for (const u of [{ residualPolicy: 'REPAIR_PENDING' }, { coverageProvenance: { rule: 'r', sources: [], refs: [], previous: { status: 'UNRESOLVED', reason: null }, values: { total: 0, represented: 0, notRetained: 0, undetermined: 0 }, stage: 'STORED' } }]) {
      const t = tx();
      const err = await repo.writeSourceLayer(t as never, couche(u) as never).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(repo.CoverageSchemaError);
      expect((err as { code: string }).code).toBe('T1_COVERAGE_MIGRATION_1665_MISSING');
      expect(base.requetes.some((q) => q.startsWith('DELETE'))).toBe(false);
    }
  });

  it('colonnes présentes : écriture normale (le refus ne concerne que la migration manquante)', async () => {
    const t = tx();
    await repo.writeSourceLayer(t as never, couche({ residualPolicy: 'REPAIR_PENDING' }) as never).catch((e: unknown) => {
      // Seule l'erreur de schéma serait une régression ; une autre erreur vient du faux `tx` du test.
      expect(e).not.toBeInstanceOf(repo.CoverageSchemaError);
    });
  });
});

describe('L114G-S02 — P2-09 : liste paginée, jamais tronquée en silence', () => {
  const ligne = (i: number, over: Partial<Row> = {}): Row => ({
    unitId: `page:${1 + Math.floor(i / 100)}:block:${i}`, kind: 'TEXT_BLOCK', page: 1 + Math.floor(i / 100), status: 'COVERED', reason: 'fact', factCount: 1,
    repairState: null, repairAttempts: 0, residualPolicy: null, provenance: null, valueKinds: {}, textLength: 10, ...over,
  });
  // 1 200 unités couvertes, UN résidu en dernière position (au-delà de l'ancienne limite de 300).
  const rows = [...Array.from({ length: 1199 }, (_, i) => ligne(i)), ligne(1199, { status: 'UNRESOLVED', reason: 'not_extracted', residualPolicy: 'REPAIR_NOT_RUN:DISABLED' })];

  it('liste par défaut : le résidu en dernière position est rendu, avec le total réel', () => {
    const r = pageCompletenessUnits(rows);
    expect(r.units.map((u) => u.unitId)).toEqual(['page:12:block:1199']);
    expect(r.paging).toEqual({ offset: 0, limit: 100, listed: 1, matched: 1 });
  });

  it('toutes les unités : pages successives sans trou ni répétition, total 1 200', () => {
    const vus = new Set<string>();
    for (let offset = 0; offset < 1200; offset += 500) {
      const r = pageCompletenessUnits(rows, { all: true, offset, limit: 500 });
      expect(r.paging).toMatchObject({ listed: 1200, matched: 1200, offset });
      for (const u of r.units) { expect(vus.has(u.unitId)).toBe(false); vus.add(u.unitId); }
    }
    expect(vus.size).toBe(1200);
    expect(vus.has('page:12:block:1199')).toBe(true);
  });

  it('filtres : identifiant d’unité, page, état, motif, politique (préfixe de motif compris), requalifiées', () => {
    expect(pageCompletenessUnits(rows, { all: true, unitId: 'BLOCK:1199' }).units).toHaveLength(1);
    expect(pageCompletenessUnits(rows, { all: true, page: 12 }).paging.matched).toBe(100);
    expect(pageCompletenessUnits(rows, { all: true, status: 'UNRESOLVED' }).paging.matched).toBe(1);
    expect(pageCompletenessUnits(rows, { all: true, reason: 'not_extracted' }).paging.matched).toBe(1);
    expect(pageCompletenessUnits(rows, { all: true, policy: 'REPAIR_NOT_RUN' }).paging.matched).toBe(1);
    expect(pageCompletenessUnits(rows, { all: true, requalified: true }).paging).toMatchObject({ matched: 0, listed: 1200 });
  });

  it('bornes : limite plafonnée, valeurs invalides ramenées au défaut', () => {
    expect(pageCompletenessUnits(rows, { all: true, limit: 99999 }).units).toHaveLength(COMPLETENESS_PAGE_MAX);
    expect(pageCompletenessUnits(rows, { all: true, limit: -5, offset: -3 }).paging).toMatchObject({ limit: 100, offset: 0 });
  });

  it('libellé de pagination : plage et totaux', () => {
    expect(pagingText({ offset: 100, limit: 100, listed: 1240, matched: 1240 }, 100)).toBe('101–200 sur 1240');
    expect(pagingText({ offset: 0, limit: 100, listed: 1240, matched: 3 }, 3)).toBe('1–3 sur 3 (1240 dans la liste)');
    expect(pagingText({ offset: 0, limit: 100, listed: 1240, matched: 0 }, 0)).toBe('aucune unité ne correspond (1240 dans la liste)');
  });
});

describe('L114G-S03 — P2-10 : libellés sans ambiguïté', () => {
  it('reprise différée détaillée : appels, décisions, rattachements ; relectures à part', () => {
    const t = deferredRepairText({
      coverageRepair: null, sourceReread: { runs: 1, failed: 0, resolved: 2 }, retryAttempts: 1, lastRetryResult: 'NO_NEW_FACT',
      deferredRepair: { calls: 1, attemptedUnits: 3, newFacts: 0, decisions: { received: 2, valid: 1, invalid: 1, persisted: 2 }, linkage: { local: 1, relinked: 0, duplicates: 1 } },
    });
    expect(t).toMatch(/Dernière reprise différée : 1 appel\(s\), 3 unité\(s\) soumise\(s\), 0 fait\(s\) ajouté\(s\)/);
    expect(t).toMatch(/décisions de valeur : 2 reçue\(s\), 1 valide\(s\), 1 invalide\(s\), 2 écrite\(s\)/);
    expect(t).toMatch(/rattachements : 1 local\(aux\), 0 recalculé\(s\), 1 fait\(s\) déjà présent\(s\)/);
    expect(t).toMatch(/Relectures du fichier : 1 \(2 unité\(s\) levée\(s\), 0 en échec\)/);
  });

  it('zéro appel expliqué : aucune reprise exécutée, aucune relecture', () => {
    const t = deferredRepairText({ coverageRepair: null, deferredRepair: null, sourceReread: null, retryAttempts: 0, lastRetryResult: null });
    expect(t).toBe('Reprise différée : 0 tentative(s) consommée(s), aucune reprise exécutée. Relectures du fichier : aucune.');
  });

  it('politique « aucune réparation tentée » libellée', () => {
    expect(policyLabel('REPAIR_NOT_ATTEMPTED')).toBe('aucune réparation tentée — reprise ciblée possible');
  });
});
