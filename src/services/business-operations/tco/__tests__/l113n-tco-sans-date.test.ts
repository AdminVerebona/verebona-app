/**
 * Lot 113N — carte #712 « [P1][Pré-MEP] TCO — Confirmer une dépense conservée sans date et clôturer le point à
 * vérifier ». Tests PURS sur le moteur TCO réel (`computeTco`), les diagnostics, le DTO, la validation de l'API
 * et le rendu (desktop et mobile : mêmes composants). Persistance, API, T3 et cohérence sur PostgreSQL :
 * `src/test/e2e/scenarios/l113n-tco-sans-date.e2e.ts`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { computeTco, type TcoAssetPrice, type TcoInput, type TcoOperation, type TcoResult } from '../model';
import { toTcoDto } from '../dto';
import type { ComponentProvenance } from '../fact-identity';
import {
  applyTcoUndatedConfirmations, tcoLineDecisionOptions, tcoLineKeys, tcoLineUndated, TCO_UNDATED_LABELS,
  type TcoUndatedConfirmation, type TcoUserDecision,
} from '../user-decisions';
import { parseTcoDecisionBody } from '../user-decisions.service';
import type { EconomicDocumentCandidate, EconomicDocumentInput, EconomicHint } from '../../finance/economic-lines';
import type { LedgerComponent } from '../../finance/engine';
import type { BusinessOperationTypeCode, FinancialComponentKind } from '../../model';

(globalThis as { React?: typeof React }).React = React;

const BIEN = 113;
const TODAY = '2026-11-06';
let seq = 113_000;

const comp = (kind: FinancialComponentKind, cents: number, o: Partial<LedgerComponent> = {}): LedgerComponent => ({
  id: seq++, operationId: 0, kind, amountMinor: cents, currency: 'EUR', amountEurCents: null, economicDate: null,
  periodStart: null, periodEnd: null, targetAssetId: null, ...o,
});
const op = (id: number, typeCode: BusinessOperationTypeCode, components: LedgerComponent[], o: Partial<TcoOperation> = {}): TcoOperation => ({
  id, typeCode, status: 'REALIZED', realizedDate: null, startDate: null, plannedDate: null,
  assetIds: [BIEN], label: `Dossier ${id}`, components: components.map((c) => ({ ...c, operationId: id })), documents: [], sourceKinds: ['DOCUMENT'], ...o,
});
const pv = (documentFileIds: number[], o: Partial<ComponentProvenance> = {}): ComponentProvenance => ({
  documentFileIds, withdrawnFileIds: [], otherSourceKinds: [], invoiceRefs: [], explained: documentFileIds.length ? true : null, ...o,
});
const prix = (amountMinor: number, o: Partial<TcoAssetPrice> = {}): TcoAssetPrice => ({ amountMinor, currency: 'EUR', origin: 'USER', evidenceFileIds: [], ...o });
const hint = (role: string, amountMinor: number, o: Partial<EconomicHint> = {}): EconomicHint => ({
  role, amountMinor, currency: 'EUR', amountScope: 'TOTAL', economicDate: null, periodStart: null, periodEnd: null, ...o,
});
const cand = (hints: EconomicHint[], o: Partial<EconomicDocumentCandidate> = {}): EconomicDocumentCandidate => ({
  id: seq++, typeHint: 'OTHER', statusHint: 'REALIZED', sourceRole: 'INVOICE', provider: null, references: [],
  targets: [{ type: 'ASSET', entityId: BIEN }], hints, t3Outcome: null, ...o,
});
const doc = (fileId: number, o: Partial<EconomicDocumentInput> = {}): EconomicDocumentInput => ({
  fileId, title: `Document ${fileId}`, typeCode: 'REPAIR_INVOICE', legacyType: null, date: null, supplier: null,
  amountCents: null, currency: 'EUR', userEditedAmount: false, hash: `h${fileId}`, state: 'ANALYZED', ignoredWith: null,
  linkedAssetIds: [BIEN], multiAsset: false, candidates: [], operations: [], ...o,
});
const decision = (key: string, value: TcoUserDecision['decision'], o: Partial<TcoUserDecision> = {}): TcoUserDecision => ({
  key, decision: value, decidedAt: '2026-11-06T10:00:00.000Z', decidedByUserId: 7, ...o,
});
const conf = (key: string, at = '2026-11-06T11:00:00.000Z'): TcoUndatedConfirmation => ({ key, confirmedAt: at, confirmedByUserId: 7 });

/**
 * Cas de la capture du 06/11 (moto) : acquisition saisie sur la fiche (2 023,00 €) reprise par un événement de
 * référence ACQUISITION sans date d'achat sur la fiche ; quittances APRIL (214,76 €) et avis d'échéance APRIL
 * (313,59 €) sur des périodes distinctes, sans date de paiement ni date de document. Total 2 551,35 €.
 */
function capture(o: { ficheDate?: string | null; saleDate?: string | null } = {}) {
  const achat = comp('REALIZED_COST', 202_300);
  const quittance = comp('REALIZED_COST', 21_476, { periodStart: '2025-09-24', periodEnd: '2026-09-23' });
  const avis = comp('REALIZED_COST', 31_359, { periodStart: '2026-09-24', periodEnd: '2027-09-23' });
  const ops = [
    op(1, 'ACQUISITION', [achat], { label: 'Achat de la moto', sourceKinds: ['ASSET_DATA'] }),
    op(2, 'CONTRACT', [quittance, avis], {
      label: 'Assurance APRIL Moto', startDate: '2025-09-24',
      documents: [{ fileId: 501, title: 'Historique des quittances APRIL Moto Vélo', role: 'INVOICE', date: null },
        { fileId: 502, title: 'Avis d’échéance APRIL Moto', role: 'INVOICE', date: null }],
    }),
  ];
  const provenance = new Map<number, ComponentProvenance>([
    [achat.id, pv([], { otherSourceKinds: ['ASSET_DATA'], otherSourceKeys: [`ASSET_DATA:${BIEN}:ACQUISITION`] })],
    [quittance.id, pv([501])], [avis.id, pv([502])],
  ]);
  const input = (x: Partial<TcoInput> = {}): TcoInput => ({
    assetId: BIEN, today: TODAY, operations: ops, assetAcquisitionDate: o.ficheDate ?? null, assetSaleDate: o.saleDate ?? null,
    assetStatus: o.saleDate ? 'VENDU' : 'ACTIF', valuationHistory: [], desiredSalePriceCents: null, budgets: [], readComplete: true, documents: [],
    assetPrice: prix(202_300), assetCategory: 'VEHICULE', componentProvenance: provenance, ...x,
  });
  return { achat, quittance, avis, input };
}
const ligne = (t: TcoResult, c: LedgerComponent) => t.lines.find((l) => l.id === `c:${c.id}`)!;
const cle = (t: TcoResult, c: LedgerComponent) => tcoLineKeys(ligne(t, c)).primary;
const diag = (t: TcoResult) => toTcoDto(t).diagnostics;
const sansDate = (t: TcoResult) => diag(t).items.find((d) => d.code === 'ECONOMIC_DATE_UNDETERMINED');
const coherent = (t: TcoResult) => {
  const a = t.annual;
  expect(a.years.reduce((n, y) => n + y.netCents, 0) + a.undated.costsCents - a.undated.creditsCents).toBe(t.summary.cumulativeCostCents);
};

describe('L113N-U — dépense conservée sans date : issue, persistance ciblée, calcul inchangé', () => {
  it('L113N-U-01 — capture : 3 dépenses sans date, chacune avec « Conserver dans le TCO sans date » et « Retirer du TCO » ; compteurs justes', () => {
    const { achat, quittance, avis, input } = capture();
    const t = computeTco(input());
    expect(t.summary.cumulativeCostCents).toBe(255_135);
    for (const c of [achat, quittance, avis]) expect(ligne(t, c)).toMatchObject({ date: null, annualYear: null, undated: true });
    const d = sansDate(t)!;
    expect(d).toMatchObject({ status: 'OPEN', nature: 'COVERAGE', count: 3, amountCents: 255_135 });
    const labels = d.sources.map((s) => (s.actions ?? []).map((o) => o.label));
    for (const l of labels) {
      expect(l).toContain('Conserver dans le TCO sans date');
      expect(l).toContain('Retirer du TCO');
    }
    // Seules les 3 dépenses attendent un choix (la date d'achat absente de la fiche est un champ, pas une décision de ligne).
    expect(diag(t).open.decisions).toBe(3);
  });

  it('L113N-U-02 — « Renseigner la date » seulement si la date de CETTE dépense se saisit : date d’achat de la fiche (absente) ; jamais pour une période d’assurance', () => {
    const { achat, quittance, avis, input } = capture();
    const t = computeTco(input());
    const opts = (c: LedgerComponent) => sansDate(t)!.sources.find((s) => s.lineId === `c:${c.id}`)!.actions!;
    expect(opts(achat).find((o) => o.label === 'Renseigner la date')).toMatchObject({ action: 'EDIT_ASSET_FIELD', field: 'acquisitionDate' });
    // Échéances APRIL : seule la période couverte est connue — ni la date de document ni l'échéance ne prouvent le paiement.
    expect(opts(quittance).some((o) => o.label === 'Renseigner la date')).toBe(false);
    expect(opts(avis).some((o) => o.label === 'Renseigner la date')).toBe(false);
  });

  it('L113N-U-03 — confirmer les 3 dépenses : 0 choix restant, point clos, TCO total STRICTEMENT identique (2 551,35 €), aucune année artificielle', () => {
    const { achat, quittance, avis, input } = capture();
    const t0 = computeTco(input());
    const t = computeTco(input({ undatedConfirmations: [achat, quittance, avis].map((c) => conf(cle(t0, c))) }));
    expect(t.summary.cumulativeCostCents).toBe(t0.summary.cumulativeCostCents);
    expect(t.summary.cumulativeCostCents).toBe(255_135);
    expect(t.annual.undated).toEqual(t0.annual.undated);
    expect(t.annual.years).toEqual(t0.annual.years);
    for (const c of [achat, quittance, avis]) expect(ligne(t, c)).toMatchObject({ date: null, annualYear: null, includedCents: ligne(t0, c).includedCents });
    coherent(t);
    const dg = diag(t);
    expect(dg.items.some((d) => d.code === 'ECONOMIC_DATE_UNDETERMINED')).toBe(false);
    expect(dg.open.decisions).toBe(0);
    expect(dg.items.filter((d) => d.status === 'OPEN').map((d) => d.code)).toEqual(['ACQUISITION_DATE_MISSING']);
    // Information de couverture neutre conservée (montants par année potentiellement incomplets) : jamais un choix à faire.
    expect(t.reliability.warnings).toContain('ECONOMIC_DATE_UNDETERMINED');
    expect(t.annual.years.every((y) => y.possiblyIncomplete)).toBe(true);
    // Visibles dans « Vos choix confirmés », chacune annulable.
    const choix = dg.items.find((d) => d.status === 'DECIDED')!;
    const conf3 = choix.sources.filter((s) => s.decision?.value === 'CONFIRM_UNDATED');
    expect(conf3).toHaveLength(3);
    for (const s of conf3) {
      expect(s.detail).toBe(TCO_UNDATED_LABELS.decided);
      expect((s.actions ?? []).map((o) => o.action)).toContain('REVERT_UNDATED');
    }
    expect(dg.decided).toBe(3);
  });

  it('L113N-U-04 — confirmation PAR LIGNE : la carte se met à jour (2 restantes, 2 choix à faire), sans retirer de montant', () => {
    const { achat, input } = capture();
    const t0 = computeTco(input());
    const t = computeTco(input({ undatedConfirmations: [conf(cle(t0, achat))] }));
    expect(sansDate(t)).toMatchObject({ count: 2, amountCents: 255_135 - 202_300 });
    expect(diag(t).open.decisions).toBe(2);
    expect(t.summary.cumulativeCostCents).toBe(255_135);
  });

  it('L113N-U-05 — §D : date d’achat fiable sur la fiche → l’acquisition reprise de la fiche est DATÉE (aucune sollicitation) ; jamais une date postérieure à la cession', () => {
    const { achat, input } = capture({ ficheDate: '2024-05-12' });
    const t = computeTco(input());
    expect(ligne(t, achat)).toMatchObject({ date: '2024-05-12', annualYear: 2024, dateLabel: 'Date indiquée pour ce montant' });
    expect(ligne(t, achat).undated).toBeUndefined();
    expect(sansDate(t)!.count).toBe(2);
    expect(t.summary.cumulativeCostCents).toBe(255_135);
    coherent(t);
    // Fiche datée APRÈS la cession : jamais utilisée pour dater la dépense.
    const v = capture({ ficheDate: '2026-06-01', saleDate: '2026-03-01' });
    expect(ligne(computeTco(v.input()), v.achat).date).toBeNull();
  });

  it('L113N-U-06 — date fiable établie APRÈS la confirmation : ligne datée et ventilée, confirmation sans objet (ni appliquée, ni orpheline, ni point rouvert)', () => {
    const { achat, quittance, avis, input } = capture();
    const t0 = computeTco(input());
    const confirmations = [achat, quittance, avis].map((c) => conf(cle(t0, c)));
    const t = computeTco({ ...input({ undatedConfirmations: confirmations }), assetAcquisitionDate: '2024-05-12' });
    expect(ligne(t, achat)).toMatchObject({ date: '2024-05-12', annualYear: 2024 });
    expect(ligne(t, achat).undatedConfirmation).toBeUndefined();
    expect(t.annual.years.find((y) => y.year === 2024)?.costsCents).toBe(202_300);
    expect(t.undatedConfirmations).toMatchObject({ applied: 2, orphans: [] });
    expect(sansDate(t)).toBeUndefined();
  });

  it('L113N-U-07 — « Annuler mon choix » : point rouvert si la date est toujours inconnue, montant inchangé', () => {
    const { achat, input } = capture();
    const t0 = computeTco(input());
    const t1 = computeTco(input({ undatedConfirmations: [conf(cle(t0, achat))] }));
    const t2 = computeTco(input({ undatedConfirmations: [] }));
    expect(sansDate(t1)!.count).toBe(2);
    expect(sansDate(t2)!.count).toBe(3);
    expect(t2.summary.cumulativeCostCents).toBe(t1.summary.cumulativeCostCents);
    const l = ligne(t1, achat);
    expect(tcoLineDecisionOptions(l, t1.lines).map((o) => o.label)).toContain('Annuler mon choix');
    expect(tcoLineDecisionOptions(l, t1.lines).map((o) => o.action)).not.toContain('CONFIRM_UNDATED');
  });

  it('L113N-U-08 — dépense retirée : aucun signalement ECONOMIC_DATE_UNDETERMINED orphelin, aucune fausse famille « information manquante »', () => {
    const { achat, quittance, avis, input } = capture();
    const t0 = computeTco(input());
    const t = computeTco(input({ userDecisions: [quittance, avis].map((c) => decision(cle(t0, c), 'EXCLUDE')) }));
    expect(sansDate(t)!.count).toBe(1);
    // Les trois retirées : plus aucun signalement (il n'était levé qu'AVANT les décisions).
    const tout = computeTco(input({ userDecisions: [achat, quittance, avis].map((c) => decision(cle(t0, c), 'EXCLUDE')) }));
    expect(tout.reliability.warnings).not.toContain('ECONOMIC_DATE_UNDETERMINED');
    const dg = diag(tout);
    expect(dg.items.filter((d) => d.status === 'OPEN' && d.traced === false)).toEqual([]);
    expect(dg.items.some((d) => d.code === 'ECONOMIC_DATE_UNDETERMINED')).toBe(false);
  });

  it('L113N-U-09 — confirmation + autre anomalie réelle sur la même ligne : seule l’alerte de date est close, l’autre reste actionnable', () => {
    // Deux échéances APRIL de même montant sans période ni date : rapprochement incertain (UNCERTAIN_MATCHES) + date inconnue.
    const a = comp('REALIZED_COST', 31_359);
    const b = comp('REALIZED_COST', 31_359);
    const input = (x: Partial<TcoInput> = {}): TcoInput => ({
      assetId: BIEN, today: TODAY, operations: [op(3, 'CONTRACT', [a], { documents: [{ fileId: 701, title: 'Avis 1', role: 'INVOICE', date: null }] }),
        op(4, 'CONTRACT', [b], { documents: [{ fileId: 702, title: 'Avis 2', role: 'INVOICE', date: null }] })],
      assetAcquisitionDate: '2020-01-10', assetSaleDate: null, assetStatus: 'ACTIF', valuationHistory: [], desiredSalePriceCents: null, budgets: [],
      readComplete: true, documents: [], assetPrice: null, componentProvenance: new Map([[a.id, pv([701])], [b.id, pv([702])]]), ...x,
    });
    const t0 = computeTco(input());
    const l0 = ligne(t0, a);
    // Ligne incertaine fabriquée par le moteur ou non : on la marque incertaine pour isoler la règle (diagnostic pur).
    const t = computeTco(input({ undatedConfirmations: [conf(tcoLineKeys(l0).primary)] }));
    const la = ligne(t, a);
    la.uncertain = true; la.note = 'Même montant qu’une autre dépense : à vérifier.';
    la.identity = { verdict: 'UNCERTAIN', signals: ['SAME_AMOUNT'], against: `c:${b.id}` };
    t.reliability.warnings.push('UNCERTAIN_MATCHES');
    const dg = diag(t);
    const inc = dg.items.find((d) => d.code === 'UNCERTAIN_MATCHES')!;
    expect(inc.status).toBe('OPEN');
    const s = inc.sources.find((x) => x.lineId === la.id)!;
    expect((s.actions ?? []).map((o) => o.action)).toEqual(expect.arrayContaining(['SAME_FACT', 'DISTINCT_FACTS']));
    // Les gestes de date ne figurent jamais sous un autre point.
    expect((s.actions ?? []).some((o) => o.action === 'CONFIRM_UNDATED' || o.action === 'REVERT_UNDATED')).toBe(false);
    // Le point « date » de cette ligne est clos ; celui de l'autre ligne reste ouvert.
    expect(sansDate(t)!.sources.map((x) => x.lineId)).toEqual([`c:${b.id}`]);
    expect(dg.reviewLineIds).toContain(la.id);
  });

  it('L113N-U-10 — ligne AJOUTÉE manuellement puis confirmée sans date : la décision d’inclusion subsiste (aucun écrasement du choix financier)', () => {
    // Facture sans date ni nature retenue : ajoutée par l'utilisateur (INCLUDE), puis conservée sans date.
    // Avis de taxe foncière sans indice T1 ni date : « nature à confirmer », ajouté par l'utilisateur (« Ajouter au TCO »).
    const docs = [doc(801, { typeCode: 'PROPERTY_TAX_NOTICE', legacyType: 'AUTRE', title: 'Avis de taxe foncière', amountCents: 4_990, date: null })];
    const base: TcoInput = {
      assetId: BIEN, today: TODAY, operations: [], assetAcquisitionDate: '2020-01-10', assetSaleDate: null, assetStatus: 'ACTIF',
      valuationHistory: [], desiredSalePriceCents: null, budgets: [], readComplete: true, documents: docs, assetPrice: null,
    };
    const t0 = computeTco(base);
    const l0 = t0.lines.find((l) => l.fileId === 801)!;
    const k = tcoLineKeys(l0).primary;
    expect(l0.status).toBe('NOT_QUALIFIED');
    const decisions = [decision(k, 'INCLUDE')];
    const t1 = computeTco({ ...base, userDecisions: decisions });
    const l1 = t1.lines.find((l) => l.fileId === 801)!;
    expect(l1.status).toBe('RETAINED_DIRECT');
    expect(tcoLineUndated(l1)).toBe(true);
    // Date du justificatif absente, aucune autre preuve : « Renseigner la date » ouvre le justificatif.
    expect(tcoLineDecisionOptions(l1, t1.lines).find((o) => o.label === 'Renseigner la date')).toMatchObject({ action: 'EDIT_DOCUMENT', fileId: 801 });
    const t2 = computeTco({ ...base, userDecisions: decisions, undatedConfirmations: [conf(k)] });
    const l2 = t2.lines.find((l) => l.fileId === 801)!;
    expect(l2.undatedConfirmation).toMatchObject({ key: k });
    expect(l2.userDecision).toMatchObject({ decision: 'INCLUDE', applied: true });
    expect(l2).toMatchObject({ status: 'RETAINED_DIRECT', includedCents: 4_990 });
    expect(t2.summary.cumulativeCostCents).toBe(t1.summary.cumulativeCostCents);
    expect(sansDate(t2)).toBeUndefined();
  });

  it('L113N-U-11 — ligne arbitrée (dépenses distinctes) restée sans date : le point de date reste tracé (jamais masqué par l’arbitrage, jamais « non tracé »)', () => {
    const { quittance, input } = capture();
    const t0 = computeTco(input());
    const t = computeTco(input({ userDecisions: [decision(cle(t0, quittance), 'DISTINCT_FACTS', { basisStatus: 'RETAINED_CONSOLIDATED' })] }));
    expect(ligne(t, quittance).userDecision).toMatchObject({ decision: 'DISTINCT_FACTS', applied: true });
    const d = sansDate(t)!;
    expect(d.traced).toBe(true);
    expect(d.sources.map((s) => s.lineId)).toContain(`c:${quittance.id}`);
    // Sous le point de date : seulement les gestes de date et « Retirer du TCO » (pas « Annuler mon choix » de l'arbitrage).
    const s = d.sources.find((x) => x.lineId === `c:${quittance.id}`)!;
    expect((s.actions ?? []).map((o) => o.action)).not.toContain('REVERT');
  });

  it('L113N-U-12 — rattachement au fait : confirmation prise sur le justificatif, puis dépense reprise par une consolidation (même justificatif) → suit le fait', () => {
    const docs = [doc(901, { candidates: [cand([hint('REALIZED_COST', 12_000)], { sourceRole: 'INVOICE' })] })];
    const base: TcoInput = {
      assetId: BIEN, today: TODAY, operations: [], assetAcquisitionDate: '2020-01-10', assetSaleDate: null, assetStatus: 'ACTIF',
      valuationHistory: [], desiredSalePriceCents: null, budgets: [], readComplete: true, documents: docs, assetPrice: null,
    };
    const t0 = computeTco(base);
    const k = tcoLineKeys(t0.lines.find((l) => l.fileId === 901)!).primary;
    const c = comp('REALIZED_COST', 12_000);
    const consolide: TcoInput = {
      ...base, documents: [], operations: [op(9, 'INTERVENTION', [c], { status: 'REALIZED', realizedDate: null, documents: [{ fileId: 901, title: 'Facture', role: 'INVOICE', date: null }] })],
      componentProvenance: new Map([[c.id, pv([901])]]), undatedConfirmations: [conf(k)],
    };
    const t = computeTco(consolide);
    const l = ligne(t, c);
    expect(tcoLineUndated(l)).toBe(true);
    expect(l.undatedConfirmation?.key).toBe(k);
    expect(sansDate(t)).toBeUndefined();
  });

  it('L113N-U-13 — application pure : clé principale, puis secondaire ; ligne datée ou retirée : jamais confirmée ; clé inconnue : orpheline (BO)', () => {
    const { achat, quittance, input } = capture();
    const t = computeTco(input());
    const lignes = t.lines.map((l) => ({ ...l, undatedConfirmation: undefined }));
    const r = applyTcoUndatedConfirmations(lignes, [conf(cle(t, achat)), conf(cle(t, quittance)), conf('f:999:REALIZED_COST:1:EUR')]);
    expect(r.applied).toBe(2);
    expect(r.orphans.map((o) => o.key)).toEqual(['f:999:REALIZED_COST:1:EUR']);
  });

  it('L113N-U-14 — DTO : lignes (Dépenses retenues) avec « Date non établie », la confirmation et ses gestes ; compteur des choix à faire mis à jour', () => {
    const { achat, input } = capture();
    const t0 = computeTco(input());
    const dto = toTcoDto(computeTco(input({ undatedConfirmations: [conf(cle(t0, achat))] })));
    const l = dto.lines.find((x) => x.id === `c:${achat.id}`)!;
    expect(l).toMatchObject({ dateLabel: 'Date non établie', undated: true, undatedConfirmation: { key: cle(t0, achat) } });
    expect(l.actions!.options.map((o) => o.action)).toContain('REVERT_UNDATED');
    expect(dto.diagnostics.open.decisions).toBe(2);
    expect(dto.summary.cumulativeCostCents).toBe(255_135);
  });

  it('L113N-U-API-01 — corps : CONFIRM_UNDATED et REVERT_UNDATED acceptés, geste inconnu refusé', () => {
    expect(parseTcoDecisionBody({ lineId: 'c:1', action: 'CONFIRM_UNDATED' })).toMatchObject({ ok: true, value: { action: 'CONFIRM_UNDATED' } });
    expect(parseTcoDecisionBody({ lineId: 'c:1', action: 'REVERT_UNDATED', lineKey: 'f:1:REALIZED_COST:1:EUR' })).toMatchObject({ ok: true });
    expect(parseTcoDecisionBody({ lineId: 'c:1', action: 'KEEP_WITHOUT_DATE' })).toMatchObject({ ok: false });
    expect(parseTcoDecisionBody({ lineId: 'c:1', action: 'EDIT_ASSET_FIELD' })).toMatchObject({ ok: false });
  });
});

describe('L113N-UI — « Points à vérifier » et « Vos choix confirmés » (desktop et mobile : mêmes composants)', () => {
  const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

  it('L113N-UI-01 — boutons du ticket à l’identique, compteur, et retour du serveur appliqué ; lecture seule : aucun geste', async () => {
    const { TcoOpenDiagnostics, TcoDecidedDiagnostics } = await import('@/components/assets/tco-diagnostics');
    const { achat, quittance, avis, input } = capture();
    const t0 = computeTco(input());
    const decide = { onDecide: async () => ({ ok: true as const }), categoryLabels: {}, categories: [] };
    const html = renderToStaticMarkup(React.createElement(TcoOpenDiagnostics, { diagnostics: diag(t0), assetId: BIEN, onShowLine: () => {}, decide }));
    expect(html).toContain('Conserver dans le TCO sans date');
    expect(html).toContain('Renseigner la date');
    expect(html).toContain('Retirer du TCO');
    expect(html).toContain('data-tco-date-entry="acquisitionDate"');
    expect(html).toContain('3 choix à faire');
    expect(html).not.toMatch(/Op[ée]ration/);
    const lecture = renderToStaticMarkup(React.createElement(TcoOpenDiagnostics, { diagnostics: diag(t0), assetId: BIEN, onShowLine: () => {} }));
    expect(lecture).not.toContain('data-tco-arbitration=');
    const t = computeTco(input({ undatedConfirmations: [achat, quittance, avis].map((c) => conf(cle(t0, c))) }));
    const apres = renderToStaticMarkup(React.createElement(TcoOpenDiagnostics, { diagnostics: diag(t), assetId: BIEN, onShowLine: () => {}, decide }));
    // Seul reste le champ « date d'achat » de la fiche (information manquante distincte) : plus aucun choix à faire.
    expect(apres).not.toContain('data-tco-diagnostic="ECONOMIC_DATE_UNDETERMINED"');
    expect(apres).not.toContain('choix à faire');
    expect(apres).not.toContain('Conserver dans le TCO sans date');
    expect(renderToStaticMarkup(React.createElement(TcoDecidedDiagnostics, { diagnostics: diag(t), onShowLine: () => {}, decide }))).toContain('Vos choix confirmés (3)');
  });

  it('L113N-UI-02 — gestes du serveur seulement, annulation propre au choix, charte (aucune couleur brute), mobile : cibles de 44 px', () => {
    const actions = lire('src/components/assets/tco-decision-actions.tsx');
    expect(actions).toContain("o.action === 'EDIT_ASSET_FIELD'");
    expect(actions).toContain('min-h-[44px]');
    expect(actions).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    const diagUi = lire('src/components/assets/tco-diagnostics.tsx');
    expect(diagUi).toContain("'REVERT_UNDATED' : 'REVERT'");
    const section = lire('src/components/assets/TcoSection.tsx');
    expect(section).toContain('data-tco-line-undated-confirmed');
    expect(section).toContain('CONFIRM_UNDATED:');
  });
});
