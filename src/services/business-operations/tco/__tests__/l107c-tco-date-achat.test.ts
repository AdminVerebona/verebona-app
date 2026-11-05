/**
 * Lot 107C — ticket P1 « TCO — Date d'achat du bien prioritaire pour le
 * calcul annuel ». Tests PURS sur le moteur TCO RÉEL (`computeTco` →
 * `resolveAcquisitionStart` → `computeTcoAnnual`) et le contrôle
 * COH-OPS-ACQUISITION-DATE v2 (verdict d'une acquisition datée). Même chose
 * sur PostgreSQL 16 (lecture canonique, primitive, campagne, route, BO) :
 * `src/test/e2e/scenarios/l107c-tco-date-achat.e2e.ts`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeTco, type TcoAssetPrice, type TcoInput, type TcoOperation, type TcoResult } from '../model';
import { resolveAcquisitionStart, strictAcquisitionDay, TCO_ACQUISITION_AGREEMENT_WINDOW_DAYS } from '../acquisition-start';
import { TCO_DAYS_PER_YEAR } from '../annual';
import { toTcoDto, TCO_WARNING_LABELS } from '../dto';
import type { LedgerComponent } from '../../finance/engine';
import type { BusinessOperationTypeCode, FinancialComponentKind } from '../../model';

const MAISON = 41;
const AUTRE = 42;
const TODAY = '2026-11-03';
let seq = 107_000;

const comp = (kind: FinancialComponentKind, cents: number, o: Partial<LedgerComponent> = {}): LedgerComponent => ({
  id: seq++, operationId: 0, kind, amountMinor: cents, currency: 'EUR', amountEurCents: null, economicDate: null,
  periodStart: null, periodEnd: null, targetAssetId: null, ...o,
});
const op = (id: number, components: LedgerComponent[], o: Partial<TcoOperation> = {}, typeCode: BusinessOperationTypeCode = 'ACQUISITION'): TcoOperation => ({
  id, typeCode, status: 'REALIZED', realizedDate: '2020-03-15', startDate: null, plannedDate: null,
  assetIds: [MAISON], label: `Achat ${id}`, components: components.map((c) => ({ ...c, operationId: id })), documents: [], sourceKinds: ['DOCUMENT'], ...o,
});
const prix = (amountMinor: number, o: Partial<TcoAssetPrice> = {}): TcoAssetPrice => ({ amountMinor, currency: 'EUR', origin: 'USER', evidenceFileIds: [], ...o });
const entree = (o: Partial<TcoInput> = {}): TcoInput => ({
  assetId: MAISON, today: TODAY, operations: [], assetAcquisitionDate: null, assetSaleDate: null, assetStatus: 'EN_SERVICE',
  valuationHistory: [], desiredSalePriceCents: null, budgets: [], readComplete: true, documents: [], assetPrice: null, assetCategory: 'IMMOBILIER', ...o,
});
const cand = (t: TcoResult, opId: number) => t.acquisitionStart!.candidates.find((c) => c.operationId === opId)!;
const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

describe('L107C — date de départ du TCO : date d’achat du bien', () => {
  it('L107C-U-01 — cas constaté : achat confirmé USER le 15/03/2020, acquisition liée datée du 21/09/2007 → départ 2020 (l’ancienne règle donnait 2007, 19,1 ans)', () => {
    // Prix de la fiche 300 000 € ; « acquisition » de 1 500 € datée 2007 (non identifiée comme l'achat du bien).
    const t = computeTco(entree({
      assetAcquisitionDate: '2020-03-15', assetAcquisitionDateMeta: { origin: 'USER', from: 'key' }, assetPrice: prix(30_000_000),
      operations: [op(1, [comp('REALIZED_COST', 150_000)], { realizedDate: '2007-09-21', label: 'Achat — mobilier' })],
    }));
    expect(t.period).toMatchObject({ start: '2020-03-15', startSource: 'ASSET_DATA', startStatus: 'RESOLVED', startBasis: 'ASSET_USER', startKind: 'PURCHASE' });
    expect(t.annual.average).toMatchObject({ status: 'COMPUTED', start: '2020-03-15', startKind: 'PURCHASE' });
    expect(cand(t, 1)).toMatchObject({ accepted: false, reason: 'NOT_ASSET_PURCHASE', role: 'OTHER_PURCHASE' });
    // Mécanisme démontré : l'ancienne règle (`earliest()` sur les ACQUISITION admissibles) retenait 2007-09-21.
    expect(t.acquisitionStart!.legacyDate).toBe('2007-09-21');
    const jours = Math.round((Date.parse(`${TODAY}T00:00:00Z`) - Date.parse('2007-09-21T00:00:00Z')) / 86_400_000) + 1;
    expect(Math.round((jours / TCO_DAYS_PER_YEAR) * 10) / 10).toBe(19.1);
    expect(t.annual.average.years).toBeLessThan(7);
  });

  it('L107C-U-02 — achat du bien identifié daté 2007 mais date USER 2020 sur la fiche : la saisie prime, écart tracé, jamais 2007', () => {
    const t = computeTco(entree({
      assetAcquisitionDate: '2020-03-15', assetPrice: prix(30_000_000, { evidenceFileIds: [900] }),
      operations: [op(1, [comp('REALIZED_COST', 30_000_000)], { realizedDate: '2007-09-21', documents: [{ fileId: 900, title: 'Acte', role: 'INVOICE' }] })],
    }));
    expect(t.period.start).toBe('2020-03-15');
    expect(t.period.startBasis).toBe('ASSET_USER');
    expect(cand(t, 1)).toMatchObject({ reason: 'CANONICAL_USER_PRIORITY', role: 'ASSET_PURCHASE', strongProof: true });
    expect(t.acquisitionStart!.contradictions).toEqual([{ code: 'OPERATION_VS_USER_DATE', dates: ['2020-03-15', '2007-09-21'], operationIds: [1], resolvedBy: 'USER_AUTHORITY' }]);
    expect(t.acquisitionStart!.repair).toBeNull();
    // Origine absente (valeur historique non tracée) : USER (règle commune `readOrigin`).
    expect(t.acquisitionStart!.canonical).toMatchObject({ origin: 'USER', human: true, valid: true });
  });

  it('L107C-U-03 — plusieurs ACQUISITION (bien, équipement, accessoire) : seule celle du bien est admissible, jamais la plus ancienne', () => {
    const t = computeTco(entree({
      assetPrice: prix(30_000_000, { evidenceFileIds: [900] }), equipmentAssets: new Map([[77, MAISON]]),
      operations: [
        op(1, [comp('REALIZED_COST', 30_000_000)], { realizedDate: '2020-03-15', documents: [{ fileId: 900, title: 'Acte', role: 'INVOICE' }] }),
        op(2, [comp('REALIZED_COST', 80_000, { targetEquipmentId: 77 })], { realizedDate: '2007-09-21', label: 'Achat — chaudière' }),
        op(3, [comp('REALIZED_COST', 20_000)], { realizedDate: '2010-01-05', label: 'Achat — store' }),
      ],
    }));
    expect(t.period).toMatchObject({ start: '2020-03-15', startSource: 'OPERATION', startBasis: 'OPERATION' });
    expect(t.acquisitionStart!.operationId).toBe(1);
    expect(cand(t, 2)).toMatchObject({ reason: 'EQUIPMENT_PURCHASE' });
    expect(cand(t, 3)).toMatchObject({ reason: 'NOT_ASSET_PURCHASE' });
    // Sans prix sur la fiche, deux achats coûtés du bien aux dates différentes : indéterminée (jamais earliest()).
    const u = computeTco(entree({
      operations: [op(1, [comp('REALIZED_COST', 30_000_000)], { realizedDate: '2020-03-15' }), op(3, [comp('REALIZED_COST', 20_000)], { realizedDate: '2010-01-05' })],
    }));
    expect(u.period).toMatchObject({ start: null, startStatus: 'UNDETERMINED' });
    expect(u.reliability.warnings).toEqual(expect.arrayContaining(['ACQUISITION_AMBIGUOUS', 'ACQUISITION_DATE_UNDETERMINED']));
    expect(u.reliability.warnings).not.toContain('ACQUISITION_DATE_MISSING');
    expect(u.acquisitionStart!.legacyDate).toBe('2010-01-05');
  });

  it('L107C-U-04 — aucune date canonique, achat du bien certain et daté : date reprise avec provenance, réparation d’enrichissement proposée, TCO calculé', () => {
    const t = computeTco(entree({ assetCategory: 'VEHICULE', operations: [op(5, [comp('REALIZED_COST', 1_800_000)], { realizedDate: '2021-05-01' })] }));
    expect(t.period).toMatchObject({ start: '2021-05-01', startSource: 'OPERATION', startStatus: 'RESOLVED' });
    expect(t.acquisitionStart!.repair).toEqual({ kind: 'ENRICH_CANONICAL', value: '2021-05-01', operationId: 5, expectedCurrent: null });
    expect(t.annual.average.status).toBe('COMPUTED');
  });

  it('L107C-U-05 — aucune date canonique, acquisition possible mais non attribuable (preuve insuffisante) : moyenne non calculée, alerte ciblée, aucune date fabriquée', () => {
    const t = computeTco(entree({ assetPrice: prix(30_000_000), operations: [op(6, [comp('REALIZED_COST', 150_000)], { realizedDate: '2012-06-01' })] }));
    expect(t.period).toMatchObject({ start: null, startStatus: 'UNDETERMINED', days: null });
    expect(t.annual.average).toMatchObject({ status: 'ACQUISITION_DATE_UNDETERMINED', cents: null, days: null });
    expect(t.status).toBe('INCOMPLETE');
    const dto = toTcoDto(t);
    expect(dto.warningLabels).toContain(TCO_WARNING_LABELS.ACQUISITION_DATE_UNDETERMINED);
    expect(TCO_WARNING_LABELS.ACQUISITION_DATE_UNDETERMINED).toMatch(/incertaine/);
    // La fiche ne reçoit jamais la résolution complète (diagnostic BO seulement).
    expect(JSON.stringify(dto)).not.toContain('legacyDate');
    expect(dto.period.startStatus).toBe('UNDETERMINED');
  });

  it('L107C-U-06 — realizedDate absente, startDate = début de contrat / période : pas de faux achat', () => {
    const t = computeTco(entree({ operations: [op(7, [comp('REALIZED_COST', 500_000)], { realizedDate: null, startDate: '2019-01-01' })] }));
    expect(t.period.start).toBeNull();
    expect(t.period.startStatus).toBe('MISSING');
    expect(cand(t, 7)).toMatchObject({ reason: 'START_DATE_ONLY', dateField: 'startDate', rawDate: '2019-01-01' });
    expect(t.reliability.warnings).toContain('ACQUISITION_DATE_MISSING');
    // L'ancienne règle prenait la date de début : restituée pour le diagnostic seulement.
    expect(t.acquisitionStart!.legacyDate).toBe('2019-01-01');
  });

  it('L107C-U-07 — date automatique fausse, preuve certaine de l’achat : la preuve l’emporte, correction proposée ; sans preuve forte : indéterminée ; valeur USER : jamais corrigée', () => {
    const base = {
      assetPrice: prix(30_000_000, { evidenceFileIds: [900], origin: 'DOCUMENT_EXTRACTION' }),
      operations: [op(8, [comp('REALIZED_COST', 30_000_000)], { realizedDate: '2020-03-15', documents: [{ fileId: 900, title: 'Acte', role: 'INVOICE' }] })],
    };
    const t = computeTco(entree({ ...base, assetAcquisitionDate: '2007-09-21', assetAcquisitionDateMeta: { origin: 'DOCUMENT_EXTRACTION', from: 'key' } }));
    expect(t.period).toMatchObject({ start: '2020-03-15', startBasis: 'OPERATION' });
    expect(t.acquisitionStart!.repair).toEqual({ kind: 'CORRECT_AUTOMATIC_CANONICAL', value: '2020-03-15', operationId: 8, expectedCurrent: '2007-09-21' });
    expect(t.acquisitionStart!.candidates[0]).toMatchObject({ kind: 'CANONICAL', reason: 'CONTRADICTED_BY_PROOF' });
    // Achat non prouvé (aucun justificatif du prix) : aucune autorité décisive.
    const u = computeTco(entree({
      assetAcquisitionDate: '2007-09-21', assetAcquisitionDateMeta: { origin: 'RECONCILIATION' },
      operations: [op(8, [comp('REALIZED_COST', 30_000_000)], { realizedDate: '2020-03-15' })],
    }));
    expect(u.period.startStatus).toBe('UNDETERMINED');
    expect(u.acquisitionStart!.repair).toBeNull();
    // Concordance dans la fenêtre de l'achat (acte / paiement) : la date de la fiche reste la source.
    const v = computeTco(entree({ ...base, assetAcquisitionDate: '2020-03-01', assetAcquisitionDateMeta: { origin: 'DOCUMENT_EXTRACTION' } }));
    expect(v.period).toMatchObject({ start: '2020-03-01', startBasis: 'ASSET_AUTOMATIC' });
    expect(v.acquisitionStart!.repair).toBeNull();
    // Même écart, valeur ADMIN : autorité, aucune réparation.
    const w = computeTco(entree({ ...base, assetAcquisitionDate: '2007-09-21', assetAcquisitionDateMeta: { origin: 'ADMIN' } }));
    expect(w.period).toMatchObject({ start: '2007-09-21', startBasis: 'ASSET_USER' });
    expect(w.acquisitionStart!.repair).toBeNull();
  });

  it('L107C-U-08 — date d’achat seulement dans la colonne historique ou un alias (origine USER lue) : repli canonique préservé, prioritaire', () => {
    for (const meta of [{ origin: 'USER', from: 'column' as const, fromName: 'purchase_date' }, { origin: 'USER', from: 'alias' as const, fromName: 'dateAchat' }]) {
      const t = computeTco(entree({ assetAcquisitionDate: '2015-04-02', assetAcquisitionDateMeta: meta, operations: [op(9, [comp('REALIZED_COST', 1_000)], { realizedDate: '2007-09-21' })] }));
      expect(t.period).toMatchObject({ start: '2015-04-02', startBasis: 'ASSET_USER' });
      expect(t.acquisitionStart!.canonical).toMatchObject({ from: meta.from, fromName: meta.fromName });
    }
  });

  it('L107C-U-09 — date impossible, future, postérieure à la cession : aucune annualisation fictive, aucun repli sur une autre date', () => {
    const achat = [op(10, [comp('REALIZED_COST', 30_000_000)], { realizedDate: '2020-03-15' })];
    const impossible = computeTco(entree({ assetAcquisitionDate: '2025-02-29', operations: achat }));
    expect(impossible.period).toMatchObject({ start: null, startStatus: 'REJECTED', startRejected: '2025-02-29' });
    expect(impossible.annual.average).toMatchObject({ status: 'ACQUISITION_DATE_INCOHERENT', incoherence: 'INVALID_DATE', cents: null });
    const future = computeTco(entree({ assetAcquisitionDate: '2027-01-01', operations: achat }));
    expect(future.annual.average).toMatchObject({ status: 'ACQUISITION_DATE_INCOHERENT', incoherence: 'FUTURE', cents: null });
    const cede = computeTco(entree({ assetAcquisitionDate: '2025-06-01', assetStatus: 'VENDU', assetSaleDate: '2024-01-01' }));
    expect(cede.annual.average).toMatchObject({ status: 'ACQUISITION_DATE_INCOHERENT', incoherence: 'AFTER_DISPOSAL', cents: null });
    // Achat du bien daté dans le futur (sans date de fiche) : jamais retenu.
    const opFuture = computeTco(entree({ operations: [op(11, [comp('REALIZED_COST', 30_000_000)], { realizedDate: '2027-02-01' })] }));
    expect(cand(opFuture, 11).accepted).toBe(false);
    expect(opFuture.period.start).toBeNull();
    const pur = resolveAcquisitionStart({ today: TODAY, disposalDate: '2024-01-01', acquisitionExpected: true, canonical: null, operations: [
      { id: 1, label: 'a', status: 'REALIZED', realizedDate: '2027-02-01', startDate: null, role: 'ASSET_PURCHASE', strongProof: true, legacyEligible: true },
      { id: 2, label: 'b', status: 'REALIZED', realizedDate: '2025-02-01', startDate: null, role: 'ASSET_PURCHASE', strongProof: true, legacyEligible: true },
    ] });
    expect(pur.candidates.map((c) => c.reason)).toEqual(['FUTURE_DATE', 'AFTER_DISPOSAL']);
    expect(pur.date).toBeNull();
    expect(strictAcquisitionDay('21/09/2007')).toBeNull();
    expect(strictAcquisitionDay('2007-09-21T00:00:00.000Z')).toBe('2007-09-21');
  });

  it('L107C-U-10 — équipements, multibiens, biens sans achat : aucun emprunt d’une date étrangère', () => {
    // Achat d'équipement seul : date absente (jamais celle de l'équipement).
    const eq = computeTco(entree({ equipmentAssets: new Map([[77, MAISON]]), operations: [op(12, [comp('REALIZED_COST', 80_000, { targetEquipmentId: 77 })], { realizedDate: '2007-09-21' })] }));
    expect(eq.period).toMatchObject({ start: null, startStatus: 'MISSING' });
    expect(cand(eq, 12).reason).toBe('EQUIPMENT_PURCHASE');
    const lie = computeTco(entree({ operations: [op(13, [comp('REALIZED_COST', 80_000)], { realizedDate: '2007-09-21', equipmentLinked: true })] }));
    expect(cand(lie, 13).reason).toBe('EQUIPMENT_PURCHASE');
    // Multibiens non attribuée : pas l'achat de CE bien.
    const multi = computeTco(entree({ operations: [op(14, [comp('REALIZED_COST', 500_000)], { realizedDate: '2007-09-21', assetIds: [MAISON, AUTRE] })] }));
    expect(cand(multi, 14).reason).toBe('MULTI_ASSET');
    expect(multi.period.start).toBeNull();
    // Location / LLD / prêt / don : début de POSSESSION (date de la fiche), aucune date d'achat tirée d'une Opération.
    const lld = computeTco(entree({ acquisitionExpected: false, assetAcquisitionDate: '2023-02-01', operations: [op(15, [comp('REALIZED_COST', 1_000)], { realizedDate: '2007-09-21' })] }));
    expect(lld.period).toMatchObject({ start: '2023-02-01', startKind: 'POSSESSION' });
    expect(lld.annual.average.startKind).toBe('POSSESSION');
    expect(cand(lld, 15).reason).toBe('NO_PURCHASE_EXPECTED');
    const lldSans = computeTco(entree({ acquisitionExpected: false, operations: [op(15, [comp('REALIZED_COST', 1_000)], { realizedDate: '2007-09-21' })] }));
    expect(lldSans.period.start).toBeNull();
  });

  it('L107C-U-11 — total TCO inchangé si seule la date change (dénominateur seul) ; dépense antérieure à l’achat jamais exclue automatiquement', () => {
    const ops = [
      op(16, [comp('REALIZED_COST', 30_000_000)], { realizedDate: '2007-09-21', label: 'Achat — acte ancien' }),
      op(17, [comp('REALIZED_COST', 250_000, { economicDate: '2019-12-01' })], { realizedDate: '2019-12-01', label: 'Acompte notaire' }, 'OTHER'),
    ];
    const a = computeTco(entree({ assetAcquisitionDate: '2020-03-15', assetPrice: prix(30_000_000), operations: ops }));
    const b = computeTco(entree({ assetAcquisitionDate: '2018-03-15', assetPrice: prix(30_000_000), operations: ops }));
    expect(a.summary.cumulativeCostCents).toBe(b.summary.cumulativeCostCents);
    expect(a.annual.average.totalCents).toBe(b.annual.average.totalCents);
    expect(a.annual.average.cents).not.toBe(b.annual.average.cents);
    // L'acompte de 2019 (avant l'achat de 2020) reste compté.
    expect(a.lines.find((l) => l.operationId === 17)?.includedCents).toBe(250_000);
  });

  it('L107C-U-12 — sans opération ni date : MISSING (motif distinct de la contradiction) ; résolution pure sans entrée', () => {
    const t = computeTco(entree());
    expect(t.period.startStatus).toBe('MISSING');
    expect(t.annual.average.status).toBe('ACQUISITION_DATE_MISSING');
    expect(resolveAcquisitionStart({ today: TODAY, disposalDate: null, acquisitionExpected: true, canonical: null, operations: [] }))
      .toMatchObject({ status: 'MISSING', date: null, candidates: [], contradictions: [], repair: null, legacyDate: null });
  });

  it('L107C-U-13 — opérations ACQUISITION concordantes (même date) : une date, pas de contradiction ; non réalisée / annulée : écartée', () => {
    const t = computeTco(entree({ operations: [
      op(18, [comp('REALIZED_COST', 30_000_000)], { realizedDate: '2020-03-15' }),
      op(19, [comp('REALIZED_COST', 500_000)], { realizedDate: '2020-03-15', label: 'Frais d’acquisition' }),
      op(20, [comp('REALIZED_COST', 1_000)], { realizedDate: '2007-09-21', status: 'PLANNED' }),
    ] }));
    expect(t.period.start).toBe('2020-03-15');
    expect(t.acquisitionStart!.contradictions).toEqual([]);
    expect(cand(t, 20).reason).toBe('NOT_REALIZED');
  });

  it('L107C-U-14 — fenêtre de concordance alignée sur la consolidation T3 d’une ACQUISITION (constante centralisée)', async () => {
    const { transactionWindowDays } = await import('../../consolidation/model');
    expect(TCO_ACQUISITION_AGREEMENT_WINDOW_DAYS).toBe(transactionWindowDays('ACQUISITION'));
  });
});

describe('L107C — contrôle COH-OPS-ACQUISITION-DATE v2 (acquisitions déjà datées)', () => {
  it('L107C-U-20 — verdicts : enrichissement, correction automatique, écart USER tracé, indéterminée, acquisition attribuée à tort', async () => {
    const { inspectDatedAcquisition } = await import('@/services/coherence/registry/checks/operations-acquisition-date');
    const enrich = computeTco(entree({ operations: [op(5, [comp('REALIZED_COST', 1_800_000)], { realizedDate: '2021-05-01' })] }));
    expect(inspectDatedAcquisition(5, MAISON, enrich.acquisitionStart!)).toMatchObject({
      verdict: 'REPAIRABLE', anomaly: 'ACQUISITION_DATE_CANONICAL_NOT_ENRICHED', detail: { assetId: MAISON, value: '2021-05-01', expectedCurrent: null },
    });
    const user = computeTco(entree({
      assetAcquisitionDate: '2020-03-15', assetPrice: prix(30_000_000, { evidenceFileIds: [900] }),
      operations: [op(1, [comp('REALIZED_COST', 30_000_000)], { realizedDate: '2007-09-21', documents: [{ fileId: 900, title: 'Acte', role: 'INVOICE' }] })],
    }));
    expect(inspectDatedAcquisition(1, MAISON, user.acquisitionStart!)).toMatchObject({ verdict: 'AMBIGUOUS', anomaly: 'ACQUISITION_DATE_CONTRADICTS_ASSET' });
    const indet = computeTco(entree({ operations: [op(1, [comp('REALIZED_COST', 30_000_000)], { realizedDate: '2020-03-15' }), op(3, [comp('REALIZED_COST', 20_000)], { realizedDate: '2010-01-05' })] }));
    expect(inspectDatedAcquisition(3, MAISON, indet.acquisitionStart!)).toMatchObject({ verdict: 'AMBIGUOUS', anomaly: 'ACQUISITION_DATE_UNDETERMINED' });
    const tort = computeTco(entree({
      assetAcquisitionDate: '2020-03-15', assetPrice: prix(30_000_000),
      operations: [op(2, [comp('REALIZED_COST', 150_000)], { realizedDate: '2007-09-21' })],
    }));
    expect(inspectDatedAcquisition(2, MAISON, tort.acquisitionStart!)).toMatchObject({ verdict: 'AMBIGUOUS', anomaly: 'ACQUISITION_MISATTRIBUTED', detail: { legacyDate: '2007-09-21', tcoStart: '2020-03-15' } });
    // Après réparation (date de la fiche = achat, automatique) : conforme, aucune seconde écriture.
    const apres = computeTco(entree({ assetAcquisitionDate: '2021-05-01', assetAcquisitionDateMeta: { origin: 'RECONCILIATION' }, operations: [op(5, [comp('REALIZED_COST', 1_800_000)], { realizedDate: '2021-05-01' })] }));
    expect(inspectDatedAcquisition(5, MAISON, apres.acquisitionStart!)).toEqual({ verdict: 'CONSISTENT' });
  });

  it('L107C-U-21 — registre : v2, interdits (saisie utilisateur, plus ancienne acquisition, date de début), services déclarés', async () => {
    const { getCheck } = await import('@/services/coherence/registry');
    const c = getCheck('COH-OPS-ACQUISITION-DATE')!;
    expect(c.version).toBe(2);
    expect(c.anomalies).toEqual(expect.arrayContaining(['ACQUISITION_DATE_CANONICAL_NOT_ENRICHED', 'ACQUISITION_DATE_CANONICAL_CONTRADICTED', 'ACQUISITION_DATE_CONTRADICTS_ASSET', 'ACQUISITION_DATE_UNDETERMINED', 'ACQUISITION_MISATTRIBUTED']));
    expect(c.forbiddenRepairs).toEqual(expect.arrayContaining(['remplacer une date d’achat saisie ou corrigée par l’utilisateur', 'choisir la plus ancienne acquisition']));
    expect(c.services).toEqual(expect.arrayContaining(['business-operations/tco/service#readAssetTco', 'canonical/asset-state#writeCanonicalAssetField']));
  });
});

describe('L107C — affichage, T2, BO : même donnée, aucune règle locale', () => {
  it('L107C-U-30 — fiche (desktop et mobile, même composant) : « Depuis l’achat du bien le JJ/MM/AAAA » depuis period.start / startKind, contradiction identifiable, aucune logique de date', () => {
    const ui = lire('src/components/assets/TcoSection.tsx');
    expect(ui).toContain('Depuis l’achat du bien le ${dateNum(start)}');
    expect(ui).toContain('Depuis le début de la possession le');
    // Lot 111F : le motif d'une moyenne non calculée vient du moteur (`indicators.annualAverage.unavailableReason`).
    expect(ui).toContain('Date d’achat du bien incertaine');
    expect(lire('src/services/business-operations/tco/ownership-indicators.ts')).toContain('ACQUISITION_DATE_UNDETERMINED:');
    expect(ui).toContain('data-tco-start-status');
    expect(ui).toContain('t.period.startKind');
    expect(ui).not.toMatch(/realizedDate|earliest|ACQUISITION'/);
  });

  it('L107C-U-31 — T2 cite la même date de départ (achat du bien) et dit la contradiction', async () => {
    const { ownershipCostAnswer } = await import('@/services/verebona-assistant/canonical/structured-answers');
    const t = computeTco(entree({ assetAcquisitionDate: '2020-03-15', assetPrice: prix(30_000_000), operations: [op(1, [comp('REALIZED_COST', 150_000)], { realizedDate: '2007-09-21' })] }));
    const r = ownershipCostAnswer({ id: MAISON, name: 'Maison' } as never, t) as { answer: string };
    expect(r.answer).toMatch(/depuis l’achat du bien le .*2020/);
    expect(r.answer).not.toMatch(/2007/);
    const u = computeTco(entree({ assetPrice: prix(30_000_000), operations: [op(6, [comp('REALIZED_COST', 150_000)], { realizedDate: '2012-06-01' })] }));
    expect((ownershipCostAnswer({ id: MAISON, name: 'Maison' } as never, u) as { answer: string }).answer).toMatch(/date d’achat du bien est incertaine/);
  });

  it('L107C-U-32 — diagnostic BO : date retenue, source, candidats, rejetés, motifs, contradictions, réparation, ancienne règle', () => {
    const bo = lire('src/app/admin/operations/_components/TcoDiagnostic.tsx');
    for (const m of ['data-bo-tco-start', 'data-bo-tco-start-candidates', 'data-bo-tco-start-contradictions', 'data-bo-tco-start-repair', 'data-bo-tco-start-legacy', 'data-bo-tco-start-canonical', 'lastWrite']) expect(bo).toContain(m);
    // Aucune couleur brute dans le BO (jetons seulement).
    expect(bo).not.toMatch(/#[0-9a-fA-F]{3,6}\b|text-(red|green|amber|orange)-\d/);
  });

  it('L107C-U-33 — correction de la date pendant l’ouverture du TCO : relecture sans fermeture (événement de la fiche, mécanisme existant)', async () => {
    const { watchTcoMutations } = await import('@/components/assets/tco-refresh');
    const cible = new EventTarget();
    let relectures = 0;
    const stop = watchTcoMutations({ target: cible, assetId: MAISON, isOpen: () => true, isOwnWrite: () => false, invalidate: () => { relectures += 1; } });
    cible.dispatchEvent(Object.assign(new Event('asset-details-updated'), { detail: { assetId: MAISON } }));
    cible.dispatchEvent(Object.assign(new Event('verebona:data-mutated'), { detail: undefined }));
    expect(relectures).toBe(2);
    stop();
  });
});
