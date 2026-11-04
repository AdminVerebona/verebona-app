/**
 * Lot 108A — ticket P1 « TCO — correctifs globaux » §A (anti-double comptage
 * GÉNÉRAL d'un même fait économique), §C (fausse alerte de valorisation), §D
 * (texte informatif). Tests PURS ; base réelle :
 * `src/test/e2e/scenarios/l108a-tco-anti-double-comptage.e2e.ts`.
 *
 * Les montants et dates de l'exemple de recette (2 023 €, fiche au 07/03/2025,
 * facture au 06/03/2025) ne sont qu'un JEU DE DONNÉES : aucune règle du code ne
 * les connaît — la matrice les fait varier (familles, sources, ordres, écarts).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { computeTco, type TcoAssetPrice, type TcoEquipmentPrice, type TcoInput, type TcoOperation } from '../model';
import { TCO_CALCULATION_INFO, TCO_WARNING_LABELS, toTcoDto } from '../dto';
import { assessSamePurchase, TCO_FACT_MATCHING, type PurchaseFact } from '../fact-matching';
import { presumedDuplicateComponents, type ComponentProvenance } from '../fact-identity';
import type { EconomicDocumentCandidate, EconomicDocumentInput, EconomicDocumentOperation, EconomicHint } from '../../finance/economic-lines';
import type { LedgerComponent } from '../../finance/engine';
import type { BusinessOperationTypeCode } from '../../model';

const TODAY = '2026-11-03';
const D_FICHE = '2025-03-07';
const D_PIECE = '2025-03-06';
const MONTANT = 202_300;
let seq = 108_000;

type Famille = 'VEHICULE' | 'OBJET' | 'IMMOBILIER';
const FAMILLES: Famille[] = ['VEHICULE', 'OBJET', 'IMMOBILIER'];
const BIEN = 41;
const EQUIPEMENT = 4101;

const hint = (role: string, amountMinor: number, o: Partial<EconomicHint> = {}): EconomicHint => ({
  role, amountMinor, currency: 'EUR', amountScope: 'TOTAL', economicDate: null, periodStart: null, periodEnd: null, ...o,
});
const cand = (hints: EconomicHint[], o: Partial<EconomicDocumentCandidate> = {}): EconomicDocumentCandidate => ({
  id: seq++, typeHint: 'ACQUISITION', statusHint: 'REALIZED', sourceRole: 'INVOICE', provider: null, references: [],
  targets: [{ type: 'ASSET', entityId: BIEN }], hints, t3Outcome: null, ...o,
});
/** Facture d'achat qualifiée par T1. */
const facture = (fileId: number, cents: number, o: Partial<EconomicDocumentInput> = {}, c: Partial<EconomicDocumentCandidate> = {}): EconomicDocumentInput => ({
  fileId, title: `Facture ${fileId}`, typeCode: 'ACQUISITION_INVOICE', legacyType: null, date: D_PIECE, supplier: null,
  amountCents: cents, currency: 'EUR', userEditedAmount: false, hash: `h${fileId}`, state: 'ANALYZED', ignoredWith: null,
  linkedAssetIds: [BIEN], multiAsset: false, candidates: [cand([hint('REALIZED_COST', cents)], c)], operations: [], ...o,
});
const lien = (operationId: number, o: Partial<EconomicDocumentOperation> = {}): EconomicDocumentOperation => ({
  operationId, label: 'Achat', inScope: true, cancelled: false, hasAssets: true, exploitable: true, citesDocument: true,
  typeCode: 'ACQUISITION', citesForOtherAssetOnly: false, citesOtherDocuments: false, freeComponents: [], ...o,
});
const comp = (cents: number, o: Partial<LedgerComponent> = {}): LedgerComponent => ({
  id: seq++, operationId: 0, kind: 'REALIZED_COST', amountMinor: cents, currency: 'EUR', amountEurCents: null, economicDate: null,
  periodStart: null, periodEnd: null, targetAssetId: BIEN, ...o,
});
const op = (id: number, components: LedgerComponent[], o: Partial<TcoOperation> = {}, typeCode: BusinessOperationTypeCode = 'ACQUISITION'): TcoOperation => ({
  id, typeCode, status: 'REALIZED', realizedDate: D_PIECE, startDate: null, plannedDate: null, assetIds: [BIEN], label: `Achat ${id}`,
  components: components.map((c) => ({ ...c, operationId: id })), documents: [], sourceKinds: ['DOCUMENT'], ...o,
});
const prov = (o: Partial<ComponentProvenance> = {}): ComponentProvenance => ({
  documentFileIds: [], withdrawnFileIds: [], otherSourceKinds: [], invoiceRefs: [], explained: null, ...o,
});
const prixFiche = (cents = MONTANT, o: Partial<TcoAssetPrice> = {}): TcoAssetPrice => ({ amountMinor: cents, currency: 'EUR', origin: 'USER', evidenceFileIds: [], ...o });
const entree = (famille: Famille, o: Partial<TcoInput> = {}): TcoInput => ({
  assetId: BIEN, today: TODAY, operations: [], assetAcquisitionDate: D_FICHE, assetSaleDate: null, assetStatus: 'ACTIF',
  valuationHistory: [], desiredSalePriceCents: null, budgets: [], readComplete: true, documents: [], assetPrice: null, assetCategory: famille, ...o,
});
const retenues = (t: ReturnType<typeof computeTco>) => t.lines.filter((l) => l.includedCents > 0);

// ═══ Paramètres et cause racine ═════════════════════════════════════════════

describe('L108A — paramètres centralisés et cause racine démontrée', () => {
  it('L108A-U-PARAM — paramètres du rapprochement alignés sur l’identité économique T3 (aucune valeur propre à un exemple)', async () => {
    const ident = await import('../../consolidation/economic-identity');
    expect(TCO_FACT_MATCHING.sameFactDays).toBe(ident.SAME_DATE_DAYS);
    expect(TCO_FACT_MATCHING.purchaseWindowDays).toBe(ident.transactionWindowDays('ACQUISITION'));
    // Aucun montant, fournisseur ou date d'exemple dans le code du rapprochement.
    for (const f of ['fact-matching.ts', 'model.ts', 'fact-identity.ts']) {
      const src = readFileSync(join(process.cwd(), 'src/services/business-operations/tco', f), 'utf8');
      expect(src).not.toMatch(/virvolt|2[\s_]?023|2025-03-0[67]/i);
      expect(src).not.toMatch(/\bsameDay\(/);
    }
  });

  it('L108A-U-RC-01 — fiche (prix saisi, 07/03) + facture d’achat du même achat (06/03), sans preuve T1 du prix : UNE contribution (ancienne règle `sameDay` : deux)', () => {
    const t = computeTco(entree('VEHICULE', { assetPrice: prixFiche(), documents: [facture(701, MONTANT)] }));
    expect(t.summary.cumulativeCostCents).toBe(MONTANT);
    expect(retenues(t)).toHaveLength(1);
    const doc = t.lines.find((l) => l.fileId === 701 && l.source === 'DOCUMENT')!;
    expect(doc).toMatchObject({ status: 'DUPLICATE', reason: 'SAME_AS_ASSET_PRICE', category: 'ACQUISITION', duplicateOf: `asset:${BIEN}:acquisitionPrice` });
    expect(doc.identity?.signals).toEqual(expect.arrayContaining(['+AMOUNT_EQUAL', '+DATE_CLOSE', '+TARGET_EXPLICIT']));
    // La ligne comptée (fiche) ouvre le justificatif : toutes les sources restent reliées et consultables.
    expect(t.lines.find((l) => l.source === 'ASSET_DATA')).toMatchObject({ status: 'RETAINED_DIRECT', fileId: 701 });
    expect(t.status).toBe('COMPLETE');
    expect(t.breakdown).toEqual([expect.objectContaining({ category: 'ACQUISITION', costsCents: MONTANT })]);
  });

  it('L108A-U-RC-02 — T3 : donnée de la fiche (07/03) et facture (06/03) du même achat → deux composantes dans le même événement de référence ; le TCO n’en compte qu’une', async () => {
    const { componentsFromIdentity, consolidateComponents } = await import('../../consolidation/model');
    const { assetDataIdentity } = await import('../../consolidation/asset-data');
    const fiche = assetDataIdentity(BIEN, { nature: 'ACQUISITION', date: D_FICHE, dateBasis: 'FIELD', amountMinor: MONTANT, provider: null, reference: null } as never);
    const piece = { ...fiche, candidateId: 9, candidateKey: 'c9', fileId: 702, structured: undefined, targetAuthority: 'DOCUMENT' as const, role: 'INVOICE' as const,
      dates: { plannedDate: null, startDate: null, realizedDate: D_PIECE, endDate: null },
      hints: [{ role: 'REALIZED_COST', amountMinor: MONTANT, currency: 'EUR', amountScope: 'TOTAL' as const, economicDate: D_PIECE, periodStart: null, periodEnd: null }] };
    const t3 = consolidateComponents([{ sourceId: 1, components: componentsFromIdentity(fiche) }, { sourceId: 2, components: componentsFromIdentity(piece) }]);
    // Contrat T3 inchangé (empreinte sans référence = date exacte) : deux composantes de même montant.
    expect(t3.filter((c) => c.kind === 'REALIZED_COST' && c.amountMinor === MONTANT)).toHaveLength(2);
    const [cFiche, cPiece] = [comp(MONTANT, { economicDate: D_FICHE }), comp(MONTANT, { economicDate: D_PIECE })];
    const achat = op(61, [cFiche, cPiece], { realizedDate: D_FICHE, sourceKinds: ['ASSET_DATA', 'DOCUMENT'], documents: [{ fileId: 702, title: 'Facture', role: 'INVOICE', date: D_PIECE }] });
    const provenance = new Map([[cFiche.id, prov({ otherSourceKinds: ['ASSET_DATA'] })], [cPiece.id, prov({ documentFileIds: [702], explained: true })]]);
    const t = computeTco(entree('VEHICULE', { assetPrice: prixFiche(), operations: [achat], componentProvenance: provenance,
      documents: [facture(702, MONTANT, { operations: [lien(61)] })] }));
    expect(t.summary.cumulativeCostCents).toBe(MONTANT);
    expect(t.lines.find((l) => l.id === `c:${cPiece.id}`)).toMatchObject({ status: 'DUPLICATE', reason: 'SAME_FACT_CROSS_SOURCE', relatedFileId: 702 });
    // Identité CONFIRMÉE : pas de « doublon présumé » à vérifier, total complet.
    expect(t.reliability.warnings).not.toContain('PRESUMED_DUPLICATES');
    expect(t.status).toBe('COMPLETE');
    // T2 (compte entier) applique la même règle (`presumedDuplicateComponents`).
    expect([...presumedDuplicateComponents(achat, provenance).keys()]).toEqual([cPiece.id]);
  });
});

// ═══ Matrice générique ══════════════════════════════════════════════════════

/** Une même dépense d'achat (montant M, fiche au jour J, pièce à J-1) représentée par 1 à 3 sources. */
function scenario(famille: Famille, sources: { fiche?: boolean; facture?: boolean; operation?: boolean }, o: { inverse?: boolean; ecartJours?: number } = {}): TcoInput {
  const dPiece = o.ecartJours == null ? D_PIECE : new Date(Date.parse(`${D_FICHE}T00:00:00Z`) - o.ecartJours * 86_400_000).toISOString().slice(0, 10);
  const fileId = o.inverse ? 9_001 : 801;
  const opId = o.inverse ? 11 : 9_101;
  const c = comp(MONTANT, { economicDate: dPiece });
  const operations = sources.operation ? [op(opId, [c], {
    realizedDate: dPiece, documents: sources.facture ? [{ fileId, title: 'Facture', role: 'INVOICE', date: dPiece }] : [],
  })] : [];
  const documents = sources.facture ? [facture(fileId, MONTANT, { date: dPiece, operations: sources.operation ? [lien(opId)] : [] })] : [];
  const componentProvenance = new Map(sources.operation ? [[c.id, prov(sources.facture ? { documentFileIds: [fileId], explained: true } : { otherSourceKinds: ['USER'] })]] : []);
  return entree(famille, {
    assetPrice: sources.fiche ? prixFiche() : null, operations: o.inverse ? [...operations].reverse() : operations,
    documents: o.inverse ? [...documents].reverse() : documents, componentProvenance,
  });
}

describe('L108A-U-MAT — même dépense sur plusieurs sources : toujours UNE contribution, preuves consultables', () => {
  const combinaisons: Array<[string, { fiche?: boolean; facture?: boolean; operation?: boolean }]> = [
    ['fiche + facture', { fiche: true, facture: true }],
    ['fiche + événement de référence', { fiche: true, operation: true }],
    ['facture + événement de référence', { facture: true, operation: true }],
    ['fiche + facture + événement de référence', { fiche: true, facture: true, operation: true }],
  ];
  for (const famille of FAMILLES) {
    for (const [nom, sources] of combinaisons) {
      for (const ecart of [0, 1, 5]) {
        for (const inverse of [false, true]) {
          it(`${famille} · ${nom} · pièce à J-${ecart} · ordre ${inverse ? 'inversé' : 'direct'}`, () => {
            const t = computeTco(scenario(famille, sources, { ecartJours: ecart, inverse }));
            expect(t.summary.cumulativeCostCents).toBe(MONTANT);
            expect(t.summary.acquisitionCents).toBe(MONTANT);
            expect(retenues(t)).toHaveLength(1);
            expect(t.reliability.warnings).not.toContain('UNCERTAIN_MATCHES');
            expect(t.reliability.warnings).not.toContain('PRESUMED_DUPLICATES');
            // Toutes les sources restent présentes dans le détail (aucune n'est perdue).
            if (sources.facture) expect(t.lines.some((l) => l.fileId === (inverse ? 9_001 : 801))).toBe(true);
            if (sources.fiche) expect(t.lines.some((l) => l.source === 'ASSET_DATA')).toBe(true);
            // Indicateurs annuels dérivés des mêmes lignes : même total.
            expect(t.annual.reconciled).toBe(true);
            expect(t.annual.average.totalCents).toBe(MONTANT);
          });
        }
      }
    }
  }

  it('ÉQUIPEMENT · fiche de l’équipement + sa facture (J-1) + son achat consolidé (J-1) : une contribution', () => {
    const ep: TcoEquipmentPrice = { equipmentId: EQUIPEMENT, name: 'Robot', amountMinor: 49_900, currency: 'EUR', date: D_FICHE, origin: 'USER', evidenceFileIds: [] };
    const doc = facture(811, 49_900, { linkedEquipmentIds: [EQUIPEMENT] }, { targets: [{ type: 'EQUIPMENT', entityId: EQUIPEMENT }] });
    const equipmentAssets = new Map([[EQUIPEMENT, BIEN]]);
    const fFacture = computeTco(entree('IMMOBILIER', { equipmentPrices: [ep], documents: [doc], equipmentAssets }));
    expect(fFacture.summary.cumulativeCostCents).toBe(49_900);
    expect(fFacture.lines.find((l) => l.source === 'EQUIPMENT_DATA')).toMatchObject({ status: 'DUPLICATE', reason: 'SAME_AS_EQUIPMENT_DOCUMENT', fileId: 811 });
    const achatEq = op(12, [comp(49_900, { targetAssetId: null, targetEquipmentId: EQUIPEMENT, economicDate: D_PIECE })]);
    const fOp = computeTco(entree('IMMOBILIER', { equipmentPrices: [ep], operations: [achatEq], equipmentAssets }));
    expect(fOp.summary.cumulativeCostCents).toBe(49_900);
    expect(fOp.lines.find((l) => l.source === 'EQUIPMENT_DATA')).toMatchObject({ status: 'CONSOLIDATED_ELSEWHERE', reason: 'EQUIPMENT_PRICE_CONSOLIDATED' });
    // Jamais confondu avec l'achat du bien lui-même.
    expect(fOp.summary.acquisitionCents).toBe(0);
  });

  it('copie d’une facture déjà reprise par un événement de référence (même référence, même montant, autre fichier) : comptée une fois, quel que soit l’ordre d’import', () => {
    const ref = [{ kind: 'INVOICE', value: 'FA-77' }];
    const c = comp(30_000, { economicDate: D_PIECE });
    const achat = op(13, [c], { documents: [{ fileId: 821, title: 'Facture', role: 'INVOICE', date: D_PIECE }] });
    for (const ordre of [[821, 822], [822, 821]]) {
      const docs = ordre.map((f) => facture(f, 30_000, { hash: `x${f}`, operations: f === 821 ? [lien(13)] : [] }, { references: ref }));
      const t = computeTco(entree('OBJET', { operations: [achat], documents: docs, componentProvenance: new Map([[c.id, prov({ documentFileIds: [821], explained: true })]]) }));
      expect(t.summary.cumulativeCostCents).toBe(30_000);
      expect(t.lines.find((l) => l.fileId === 822 && l.source === 'DOCUMENT')).toMatchObject({ status: 'DUPLICATE', reason: 'DUPLICATE_REFERENCE', relatedFileId: 821 });
    }
  });

  it('deux événements de référence pour le même achat du bien (fiche consolidée + facture consolidée à part) : un seul compté', () => {
    const [cF, cD] = [comp(MONTANT, { economicDate: D_FICHE }), comp(MONTANT, { economicDate: D_PIECE })];
    const deFiche = op(14, [cF], { realizedDate: D_FICHE, sourceKinds: ['ASSET_DATA'] });
    const deFacture = op(15, [cD], { realizedDate: D_PIECE, documents: [{ fileId: 831, title: 'Facture', role: 'INVOICE', date: D_PIECE }] });
    for (const operations of [[deFiche, deFacture], [deFacture, deFiche]]) {
      const t = computeTco(entree('VEHICULE', { assetPrice: prixFiche(), operations, componentProvenance: new Map([[cF.id, prov({ otherSourceKinds: ['ASSET_DATA'] })], [cD.id, prov({ documentFileIds: [831], explained: true })]]) }));
      expect(t.summary.cumulativeCostCents).toBe(MONTANT);
      expect(t.lines.find((l) => l.id === `c:${cD.id}`)).toMatchObject({ status: 'DUPLICATE', reason: 'SAME_FACT_CROSS_SOURCE', duplicateOf: `c:${cF.id}` });
    }
  });

  it('recalcul stable : même entrée → même résultat (réanalyse T1/T3, relecture) ; changement de rattachement → recalcul', () => {
    const e = scenario('OBJET', { fiche: true, facture: true, operation: true });
    expect(computeTco(e).summary).toEqual(computeTco(e).summary);
    // La facture rattachée à un autre bien : elle n'est plus une source de celui-ci, la fiche seule compte.
    const deplacee = { ...e, documents: e.documents!.map((d) => ({ ...d, linkedAssetIds: [999], candidates: d.candidates.map((c) => ({ ...c, targets: [{ type: 'ASSET', entityId: 999 }] })) })), operations: [] };
    expect(computeTco(deplacee).summary.cumulativeCostCents).toBe(MONTANT);
  });
});

describe('L108A-U-DIST — transactions distinctes : jamais fusionnées sur le seul montant, fournisseur ou proximité', () => {
  it('deux achats de même montant, dates éloignées (fiche J, accessoire J+90) : deux coûts, aucun signalement', () => {
    for (const famille of ['VEHICULE', 'OBJET'] as const) {
      const t = computeTco(entree(famille, { assetPrice: prixFiche(), documents: [facture(841, MONTANT, { date: '2025-06-05' })] }));
      expect(t.summary.cumulativeCostCents).toBe(2 * MONTANT);
      expect(t.lines.find((l) => l.fileId === 841)?.uncertain).toBeUndefined();
    }
  });

  it('deux factures de même montant et même date, sans fiche : deux coûts', () => {
    const t = computeTco(entree('OBJET', { documents: [facture(851, 4_500, {}, { typeHint: 'INTERVENTION' }), facture(852, 4_500, {}, { typeHint: 'INTERVENTION' })] }));
    expect(t.summary.cumulativeCostCents).toBe(9_000);
  });

  it('fournisseurs différents connus, ou références de facture différentes : deux coûts malgré même montant et dates proches', () => {
    const fournisseur = computeTco(entree('OBJET', { operations: [op(16, [comp(MONTANT)], { provider: 'Garage Alpha' })], assetPrice: prixFiche(),
      documents: [facture(861, MONTANT, { supplier: 'Boutique Beta' })] }));
    // L'achat consolidé (fournisseur Alpha) est l'achat de la fiche ; la facture d'un autre fournisseur reste distincte.
    expect(fournisseur.summary.cumulativeCostCents).toBe(2 * MONTANT);
    const a: PurchaseFact = { eurCents: 100, date: D_FICHE, supplier: 'X', explicitTarget: true, equipment: false, invoiceRefs: ['F1'] };
    expect(assessSamePurchase(a, { ...a, invoiceRefs: ['F2'] }).verdict).toBe('DISTINCT');
    expect(assessSamePurchase(a, { ...a, invoiceRefs: ['F1'], date: null }).verdict).toBe('SAME');
  });

  it('dates proches mais aucune autre preuve (justificatif sans cible ni fournisseur commun) : comptée, ambiguïté signalée — jamais fusionnée', () => {
    // T1 a vu une cible sans pouvoir la désigner (aucun bien identifié) : le rattachement seul n'est pas une cible explicite.
    const vague = facture(871, MONTANT, {}, { targets: [{ type: 'ASSET', entityId: null }] });
    const t = computeTco(entree('OBJET', { assetPrice: prixFiche(), documents: [vague] }));
    expect(t.summary.cumulativeCostCents).toBe(2 * MONTANT);
    expect(t.lines.find((l) => l.fileId === 871 && l.source === 'DOCUMENT')).toMatchObject({ uncertain: true });
    expect(t.reliability.warnings).toContain('UNCERTAIN_MATCHES');
  });

  it('même montant, date d’achat inconnue : comptée, ambiguïté signalée (règle 75D conservée)', () => {
    const t = computeTco(entree('VEHICULE', { assetPrice: prixFiche(), assetAcquisitionDate: null, documents: [facture(881, MONTANT)] }));
    expect(t.summary.cumulativeCostCents).toBe(2 * MONTANT);
    expect(t.status).toBe('INCOMPLETE');
  });

  it('un achat établi n’absorbe qu’un justificatif : deux factures confirmées → une absorbée, l’autre comptée et signalée', () => {
    const t = computeTco(entree('VEHICULE', { assetPrice: prixFiche(), documents: [facture(891, MONTANT, { date: '2025-03-05', hash: 'a' }), facture(892, MONTANT, { date: D_PIECE, hash: 'b' })] }));
    expect(t.summary.cumulativeCostCents).toBe(2 * MONTANT);
    expect(t.lines.find((l) => l.fileId === 892 && l.source === 'DOCUMENT')).toMatchObject({ status: 'DUPLICATE' });
    expect(t.lines.find((l) => l.fileId === 891 && l.source === 'DOCUMENT')).toMatchObject({ uncertain: true });
  });

  it('équipement acheté puis réparé du même montant : deux coûts (une réparation n’est jamais l’acquisition)', () => {
    const ep: TcoEquipmentPrice = { equipmentId: EQUIPEMENT, name: 'Robot', amountMinor: 49_900, currency: 'EUR', date: D_FICHE, origin: 'USER', evidenceFileIds: [] };
    const rep = facture(895, 49_900, { typeCode: 'REPAIR_INVOICE', linkedEquipmentIds: [EQUIPEMENT] }, { typeHint: 'INTERVENTION', targets: [{ type: 'EQUIPMENT', entityId: EQUIPEMENT }] });
    expect(computeTco(entree('IMMOBILIER', { equipmentPrices: [ep], documents: [rep], equipmentAssets: new Map([[EQUIPEMENT, BIEN]]) })).summary.cumulativeCostCents).toBe(2 * 49_900);
  });
});

describe('L108A-U-MULTI — multi-articles, acomptes / solde : jamais additionnés au même fait', () => {
  it('facture totale + acompte + solde liés (même référence) + prix de la fiche (dates différentes) : une seule contribution', () => {
    const ref = [{ kind: 'INVOICE', value: 'CMD-9' }];
    const docs = [
      facture(901, MONTANT, {}, { references: ref }),
      facture(902, 50_000, { title: 'Facture d’acompte', date: '2025-02-10' }, { references: ref, typeHint: 'ACQUISITION' }),
      facture(903, MONTANT - 50_000, { title: 'Facture de solde', date: D_PIECE }, { references: ref }),
    ];
    docs[1].candidates[0].hints = [hint('REALIZED_COST', 50_000, { amountScope: 'DEPOSIT' })];
    docs[2].candidates[0].hints = [hint('REALIZED_COST', MONTANT - 50_000, { amountScope: 'BALANCE' })];
    const t = computeTco(entree('VEHICULE', { assetPrice: prixFiche(), documents: docs }));
    expect(t.summary.cumulativeCostCents).toBe(MONTANT);
    expect(t.lines.filter((l) => l.status === 'INCLUDED_IN_TOTAL')).toHaveLength(2);
  });

  it('ticket multi-articles : prix de l’article sur la fiche (preuve = le ticket) + total du ticket consolidé : jamais additionnés ; un autre article du ticket reste une dépense indépendante si attribué', () => {
    const c = comp(12_793, { targetAssetId: null, economicDate: D_PIECE });
    const achat = op(17, [c], { documents: [{ fileId: 911, title: 'Ticket', role: 'INVOICE', date: D_PIECE }] });
    const ticket = facture(911, 12_793, { operations: [lien(17)] });
    const t = computeTco(entree('OBJET', { assetPrice: prixFiche(6_999, { origin: 'RECONCILIATION', evidenceFileIds: [911] }), operations: [achat], documents: [ticket],
      componentProvenance: new Map([[c.id, prov({ documentFileIds: [911], explained: true })]]) }));
    expect(t.summary.cumulativeCostCents).not.toBe(6_999 + 12_793);
    expect(t.summary.cumulativeCostCents).toBeLessThanOrEqual(12_793);
  });
});

// ═══ §C et §D ═══════════════════════════════════════════════════════════════

describe('L108A-U-C — sans valorisation actuelle : aucune fausse alerte, TCO historique fonctionnel', () => {
  it('aucun signalement de valorisation, coût net estimé « non calculable » (null), statut inchangé', () => {
    const t = computeTco(entree('VEHICULE', { assetPrice: prixFiche(), valuationHistory: [] }));
    expect(t.reliability.warnings as string[]).not.toContain('NO_RELIABLE_VALUATION');
    expect(t.summary).toMatchObject({ cumulativeCostCents: MONTANT, currentValue: null, netEstimatedCents: null });
    expect(t.status).toBe('COMPLETE');
    expect(Object.keys(TCO_WARNING_LABELS)).not.toContain('NO_RELIABLE_VALUATION');
    expect(toTcoDto(t).warningLabels.join(' ')).not.toMatch(/valorisation/i);
    // L'historique de valorisation reste exploité quand il existe.
    const v = computeTco(entree('VEHICULE', { assetPrice: prixFiche(), valuationHistory: [{ value: 1500, date: '2026-01-01' }] }));
    expect(v.summary.netEstimatedCents).toBe(MONTANT - 150_000);
  });

  it('aucun texte de l’ancienne alerte dans le code (fiche, T2, BO)', () => {
    const fichiers: string[] = [];
    const parcours = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) { if (n !== 'node_modules' && n !== '__tests__' && p !== join(process.cwd(), 'src/test')) parcours(p); } else if (/\.(ts|tsx)$/.test(n)) fichiers.push(p); } };
    parcours(join(process.cwd(), 'src'));
    const avec = fichiers.filter((f) => /Aucune valorisation datée|NO_RELIABLE_VALUATION'/.test(readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '')));
    expect(avec).toEqual([]);
  });
});

describe('L108A-U-D — texte informatif exact, distinct de toute alerte', () => {
  it('texte exact, affiché hors du bloc « Alertes de couverture », ancien texte absent', () => {
    expect(TCO_CALCULATION_INFO).toBe("Le coût total est calculé automatiquement à partir du prix d'achat et des dépenses associées au bien.");
    const section = readFileSync(join(process.cwd(), 'src/components/assets/TcoSection.tsx'), 'utf8');
    expect(section).not.toContain('Ce total est calculé : pour le corriger');
    expect(section).toContain('{TCO_CALCULATION_INFO}');
    const info = section.indexOf('{TCO_CALCULATION_INFO}');
    const alertes = section.indexOf('data-tco-warnings');
    const finAlertes = section.indexOf('</Bloc>', alertes);
    expect(info).toBeGreaterThan(finAlertes);
    expect(section.slice(section.lastIndexOf('<p', info), info)).toContain('text-muted-foreground');
    expect(Object.values(TCO_WARNING_LABELS)).not.toContain(TCO_CALCULATION_INFO);
  });
});

// ═══ Reprise de l'historique : contrôle de cohérence ════════════════════════

describe('L108A-U-COH — contrôle COH-TCO-SAME-FACT (stock repris à la lecture, arbitrage seulement si incertain)', () => {
  it('registré en fin de registre, domaine TCO, sans réparation ni IA (aucune écriture : le TCO n’est pas persisté)', async () => {
    const { COHERENCE_REGISTRY, getCheck } = await import('@/services/coherence/registry');
    const { COVERAGE_INVENTORY } = await import('@/services/coherence/registry/coverage');
    const c = getCheck('COH-TCO-SAME-FACT')!;
    // Ajouté en fin de registre, après les contrôles des lots précédents (lot 108 : plusieurs ajouts en fin).
    const ids = COHERENCE_REGISTRY.map((k) => k.id);
    expect(ids.indexOf('COH-TCO-SAME-FACT')).toBeGreaterThan(ids.indexOf('COH-PRICE-MULTI-ARTICLE'));
    expect(c).toMatchObject({ status: 'ACTIVE', domain: 'tco', objectType: 'asset' });
    expect(c.repair).toBeUndefined();
    expect(c.forbiddenRepairs.join(' ')).toMatch(/décision « Ajouter \/ Retirer du TCO »/);
    expect(COVERAGE_INVENTORY.find((d) => d.domain === 'tco')?.checks).toContain('COH-TCO-SAME-FACT');
  });

  it('audit : faits réunis tracés ; incertitude sans décision → arbitrage ; achat compté deux fois → constat', async () => {
    const { inspectSameFacts } = await import('../same-fact-audit');
    const reuni = inspectSameFacts(computeTco(scenario('VEHICULE', { fiche: true, facture: true })).lines);
    expect(reuni.merged).toEqual([expect.objectContaining({ reason: 'SAME_AS_ASSET_PRICE', against: `asset:${BIEN}:acquisitionPrice` })]);
    expect(reuni.uncertain).toEqual([]);
    expect(reuni.countedTwice).toEqual([]);
    const incertain = inspectSameFacts(computeTco(entree('VEHICULE', { assetPrice: prixFiche(), assetAcquisitionDate: null, documents: [facture(1001, MONTANT)] })).lines);
    expect(incertain.uncertain).toEqual([expect.objectContaining({ fileId: 1001 })]);
    // Décision de l'utilisateur déjà prise sur la ligne : plus d'arbitrage demandé (jamais écrasée).
    const lignes = computeTco(entree('VEHICULE', { assetPrice: prixFiche(), assetAcquisitionDate: null, documents: [facture(1001, MONTANT)] })).lines
      .map((l) => (l.fileId === 1001 ? { ...l, userDecision: { decision: 'INCLUDE', applied: true } as never } : l));
    expect(inspectSameFacts(lignes).uncertain).toEqual([]);
  });

  it('fiche + justificatif dans le même achat consolidé, dates inconnues : deux composantes comptées, ambiguïté signalée (jamais une fusion silencieuse)', () => {
    const [cF, cD] = [comp(MONTANT), comp(MONTANT)];
    const achat = op(18, [cF, cD], { realizedDate: null, sourceKinds: ['ASSET_DATA', 'DOCUMENT'], documents: [{ fileId: 1011, title: 'Facture', role: 'INVOICE', date: null }] });
    const t = computeTco(entree('OBJET', { assetPrice: prixFiche(), assetAcquisitionDate: null, operations: [achat],
      componentProvenance: new Map([[cF.id, prov({ otherSourceKinds: ['ASSET_DATA'] })], [cD.id, prov({ documentFileIds: [1011], explained: true })]]) }));
    expect(t.summary.cumulativeCostCents).toBe(2 * MONTANT);
    expect(t.lines.find((l) => l.id === `c:${cD.id}`)).toMatchObject({ uncertain: true, identity: { verdict: 'UNCERTAIN' } });
    expect(t.reliability.warnings).toContain('UNCERTAIN_MATCHES');
  });
});
