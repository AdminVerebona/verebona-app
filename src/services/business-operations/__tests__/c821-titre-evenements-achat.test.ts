/**
 * Carte #821 (lot 116I) — événements d'achat : le titre désigne l'OBJET
 * réellement acheté, plus le type « Achat » nu — règles PURES.
 *
 *   C821-U-01  règle de nommage : les trois lignes du tableau de la carte
 *   C821-U-02  rien de fiable : aucun nom (replis existants, libellé neutre) ; rien n'est inventé
 *   C821-U-03  le fournisseur, le bien associé et le nom du justificatif ne nomment jamais l'achat
 *   C821-U-04  catégorie de dépense : référentiel des dépenses d'usage, forme grammaticale
 *   C821-U-05  T3 : nom porté par l'identité du candidat (désignation, catégorie, acquisition du bien)
 *   C821-U-06  T3 : intitulé du système remplacé, intitulé de l'utilisateur jamais touché
 *   C821-U-07  T4 : titre de l'événement = intitulé de l'opération ; libellé neutre sinon
 *   C821-U-08  T4 : événement AUTOMATIQUE intact nommé « Achat » renommé sur place ; titre explicite ou de l'utilisateur intact
 *   C821-U-09  cohérence : le renommage d'un événement d'achat est un écart réparable de la projection
 *
 * Règles remplacées (carte #821), tests réécrits : `c813-bon-de-commande.test.ts` (C813-U-06, titre de
 * l'événement) et `agenda-projection/__tests__/o7-projection.test.ts` (F-142).
 */
import { describe, expect, it } from 'vitest';
import {
  acquisitionEventTitle, acquisitionLabelFromCategory, acquisitionName, designationWithoutNames, isBareAcquisitionName,
} from '@/lib/reference-events/operation-title';
import { expenseCategoryLabelOfWording } from '../consolidation/acquisition-name';
import { usageCategoryOfWording, usageCategoriesOfText } from '../tco/usage-complement';
import { USAGE_BUDGET_CATEGORY_LABELS } from '../tco/model';
import { buildCandidateIdentity, sourceLabelOf, type CandidateIdentity, type CandidateRecord, type SourceContribution } from '../consolidation/model';
import { acquisitionEvidenceIndex, provenAssetAcquisition } from '../consolidation/acquisition-corroboration';
import { acquisitionLabelDecision } from '../consolidation/consolidator';
import {
  decideProjection, isUninformativePurchaseTitle, planOperationProjection, precisePurchaseTitle, projectionFunctionalKey,
  type AgendaItemSnapshot, type OperationSnapshot,
} from '../agenda-projection/model';
import { projectionAnomaly, projectionGaps } from '@/services/coherence/registry/checks/agenda-projection';

const AUJ = '2026-11-20';
const CUPRA = 7;
const FICHIER = 50;
const categoryOf = expenseCategoryLabelOfWording;

// ── T3 : candidat persisté et contexte ──────────────────────────────────────
const persiste = (over: Partial<CandidateRecord> & { payload?: CandidateRecord['payload'] } = {}): CandidateRecord => ({
  id: 1, accountId: 1, fileId: FICHIER, candidateKey: 'op1', established: true, confidence: 'certain', typeHint: 'ACQUISITION', statusHint: 'REALIZED',
  summary: 'Achat',
  payload: {
    sourceRoleHint: 'INVOICE', provider: 'TotalEnergies', temporalHints: { realizedDate: AUJ },
    financialHints: [{ role: 'REALIZED_COST', amountMinor: 6230, currency: 'EUR', amountScope: 'TOTAL', economicDate: AUJ }] as never,
  },
  ...over,
});
const ctxT3 = (over: Partial<Parameters<typeof buildCandidateIdentity>[1]> = {}): Parameters<typeof buildCandidateIdentity>[1] => ({
  fileAssetId: CUPRA, fileDocumentTypeCode: 'ACQUISITION_INVOICE', liveAssetIds: new Set([CUPRA]), equipmentAssets: new Map<number, number>(),
  assetNames: new Map([[CUPRA, 'Cupra']]), ...over,
});
const designation = (subject: string, otherArticles = false) => ({ fileDesignation: { subject, otherArticles } });
const preuveAchatDuBien = { acquisitionEvidence: acquisitionEvidenceIndex([{ target_type: 'ASSET', target_id: CUPRA, file_id: FICHIER }]) };
const contribution = (identity: CandidateIdentity, sourceId = 1): SourceContribution => ({ sourceId, identity });

// ── T4 : instantanés ────────────────────────────────────────────────────────
function op(over: Partial<OperationSnapshot> = {}): OperationSnapshot {
  return {
    id: 10, accountId: 1, typeCode: 'ACQUISITION', status: 'REALIZED', technicalLabel: 'Achat de carburant', provider: 'TotalEnergies',
    plannedDate: null, realizedDate: AUJ, endDate: null, active: true, assetIds: [CUPRA], equipmentIds: [], documentFileIds: [FICHIER],
    contractEffectiveTo: null, claimHistoryEventId: null, disposalKind: 'SALE', assetNames: ['Cupra'],
    documentTitles: ['Ticket de carburant TotalEnergies — 20 novembre 2026', 'Ticket de carburant'], ...over,
  };
}
function item(over: Partial<AgendaItemSnapshot> = {}): AgendaItemSnapshot {
  return {
    id: 100, title: 'Achat', date: AUJ, isAutomatic: true, isAutomaticModified: false, projected: false,
    businessOperationId: null, linkedOperationActive: false, nature: 'HISTORICAL', businessType: 'purchase', homeCategory: 'information', functionalKey: null,
    originRefType: 'asset_file', originRefId: FICHIER, assetIds: [CUPRA], equipmentIds: [], fileIds: [FICHIER], ...over,
  };
}
const plan = (o: OperationSnapshot, p: { linked?: AgendaItemSnapshot[]; candidates?: AgendaItemSnapshot[] } = {}) =>
  planOperationProjection({ op: o, decision: decideProjection(o, AUJ), linked: p.linked ?? [], suppressedKeys: new Set<string>(), candidates: p.candidates ?? [] });
const titreVoulu = (o: OperationSnapshot): string => {
  const d = decideProjection(o, AUJ);
  if (d.kind !== 'PROJECT') throw new Error(`pas de projection : ${d.reason}`);
  return d.desired.title;
};

describe('C821-U-01 — règle de nommage : les trois lignes du tableau de la carte', () => {
  it('carburant destiné à la Cupra → « Achat de carburant » (catégorie) ; la Cupra, bien associé, n’entre pas dans le titre', () => {
    for (const d of ['de carburant', 'Carburant', 'de carburant TotalEnergies', 'de carburant Cupra', 'carburant chez TotalEnergies', 'Sans plomb', 'Gazole']) {
      expect(acquisitionName({ designation: d, provider: 'TotalEnergies', assetNames: ['Cupra'], categoryOf }), d).toEqual({ label: 'Achat de carburant', basis: 'CATEGORY' });
    }
    // Aucune désignation : la catégorie est lue dans le résumé du candidat quand il n'est QUE cette catégorie.
    for (const s of ['Carburant', 'Achat de carburant', 'carburants']) {
      expect(acquisitionName({ designation: null, summary: s, assetNames: ['Cupra'], categoryOf }), s).toEqual({ label: 'Achat de carburant', basis: 'CATEGORY' });
    }
  });
  it('accessoire Polisport groovy coussin gris → « Achat Polisport groovy coussin gris » (désignation), jamais le vélo', () => {
    expect(acquisitionName({ designation: 'Polisport groovy coussin gris', provider: 'Cycles Exemple', assetNames: ['Jean Fourche'], categoryOf }))
      .toEqual({ label: 'Achat Polisport groovy coussin gris', basis: 'DESIGNATION' });
    expect(acquisitionName({ designation: 'Polisport groovy coussin gris', otherArticles: true, categoryOf })?.label).toBe('Achat Polisport groovy coussin gris et autres articles');
    // Une désignation plus précise qu'une catégorie reste la désignation (jamais ramenée à la catégorie).
    expect(acquisitionName({ designation: 'Bouchon de réservoir essence', assetNames: ['Cupra'], categoryOf })).toEqual({ label: 'Achat Bouchon de réservoir essence', basis: 'DESIGNATION' });
    expect(acquisitionName({ designation: 'Sans plomb 98', categoryOf })).toEqual({ label: 'Achat Sans plomb 98', basis: 'DESIGNATION' });
  });
  it('véhicule Cupra lui-même, acquisition établie → « Achat Cupra » ; jamais sur le seul rattachement', () => {
    expect(acquisitionName({ designation: null, summary: 'Achat', assetNames: ['Cupra'], acquiredAssetName: 'Cupra', categoryOf })).toEqual({ label: 'Achat Cupra', basis: 'ASSET_ACQUISITION' });
    expect(acquisitionName({ designation: 'Cupra', assetNames: ['Cupra'], acquiredAssetName: 'Cupra', categoryOf })).toEqual({ label: 'Achat Cupra', basis: 'DESIGNATION' });
    expect(acquisitionName({ designation: 'Cupra Formentor VZ', assetNames: ['Cupra'], acquiredAssetName: 'Cupra', categoryOf })?.label).toBe('Achat Cupra Formentor VZ');
    // Sans preuve d'acquisition : le nom du bien associé ne nomme pas l'achat.
    expect(acquisitionName({ designation: 'Cupra', assetNames: ['Cupra'], categoryOf })).toBeNull();
    expect(acquisitionName({ designation: null, summary: 'Achat', assetNames: ['Cupra'], categoryOf })).toBeNull();
  });
});

describe('C821-U-02 — rien de fiable : aucun nom, rien n’est inventé', () => {
  it('ni désignation, ni catégorie, ni acquisition établie : null (replis existants, puis libellé neutre)', () => {
    expect(acquisitionName({ categoryOf })).toBeNull();
    expect(acquisitionName({ designation: '  ', summary: null, categoryOf })).toBeNull();
    expect(acquisitionName({ designation: '42', summary: 'Achat', categoryOf })).toBeNull();
    expect(acquisitionName({ designation: 'Achat', summary: 'Achat', categoryOf })).toBeNull();
    // Un résumé qui dit autre chose qu'une catégorie n'est pas recopié par cette règle (il reste le repli existant de T3).
    expect(acquisitionName({ designation: null, summary: 'Plein de la voiture avant le départ', categoryOf })).toBeNull();
    expect(acquisitionName({ designation: null, summary: 'Bouchon de réservoir essence', categoryOf })).toBeNull();
    // Sans référentiel fourni : aucune catégorie n'est devinée.
    expect(acquisitionName({ designation: null, summary: 'Carburant' })).toBeNull();
  });
  it('« Achat », « Achats », « Acquisition » seuls ne sont pas un intitulé descriptif', () => {
    for (const t of ['Achat', 'achats', ' Acquisition ']) expect(isBareAcquisitionName(t), t).toBe(true);
    for (const t of ['Achat de carburant', 'Achat Cupra', '', null]) expect(isBareAcquisitionName(t), String(t)).toBe(false);
  });
});

describe('C821-U-03 — le fournisseur, le bien associé et le nom du justificatif ne nomment jamais l’achat', () => {
  it('désignation réduite au fournisseur ou au bien associé : aucune désignation', () => {
    expect(designationWithoutNames('TotalEnergies', ['TotalEnergies', 'Cupra'])).toBeNull();
    expect(designationWithoutNames('Cupra', ['TotalEnergies', 'Cupra'])).toBeNull();
    expect(designationWithoutNames('de TotalEnergies', ['TotalEnergies'])).toBeNull();
    expect(designationWithoutNames('TotalEnergies Cupra', ['TotalEnergies', 'Cupra'])).toBeNull();
    expect(acquisitionName({ designation: 'TotalEnergies', summary: 'Achat', provider: 'TotalEnergies', assetNames: ['Cupra'], categoryOf })).toBeNull();
  });
  it('nom placé en fin de désignation : retiré avec son mot de liaison ; le reste est gardé tel quel', () => {
    expect(designationWithoutNames('de carburant TotalEnergies', ['TotalEnergies'])).toBe('de carburant');
    expect(designationWithoutNames('Housse de selle pour Jean Fourche', ['Jean Fourche'])).toBe('Housse de selle');
    expect(designationWithoutNames('Polisport groovy coussin gris', ['Cycles Exemple', 'Jean Fourche'])).toBe('Polisport groovy coussin gris');
    // Un nom en tête ou au milieu n'est pas retiré (« Cupra Formentor » ne devient pas « Formentor »).
    expect(designationWithoutNames('Cupra Formentor', ['Cupra'])).toBe('Cupra Formentor');
    expect(designationWithoutNames('Classe A', ['Mercedes'])).toBe('Classe A');
    expect(designationWithoutNames(null, ['Cupra'])).toBeNull();
  });
  it('intitulé automatique « Achat », « Achat — <bien> », « Achat — <prestataire> », « Achat — <titre du justificatif> » : ne dit pas ce qui a été acheté', () => {
    const o = op();
    for (const t of ['Achat', 'Achat — Cupra', 'Achat — TotalEnergies', 'Achat — Ticket de carburant', 'Achat — Ticket de carburant TotalEnergies — 20 novembre 2026']) {
      expect(isUninformativePurchaseTitle(t, o), t).toBe(true);
    }
    for (const t of ['Achat de carburant', 'Achat — Pneus hiver', 'Plein du 20 novembre', 'Entretien réalisé']) expect(isUninformativePurchaseTitle(t, o), t).toBe(false);
    // Carte #832 : « Achat Cupra » SANS tiret attendait `false` — c'est l'écart constaté le
    // 22/11/2026. Le nom du bien ne dit pas ce qui a été acheté, avec ou sans ponctuation :
    // il est désormais insuffisant comme les autres. Une VRAIE acquisition du véhicule garde
    // pourtant son intitulé, parce que rien n'est renommé sans un intitulé d'Opération plus
    // précis (`precisePurchaseTitle` rend `null` dans ce cas) — voir `c832-titres-achat-sans-tiret`.
    expect(isUninformativePurchaseTitle('Achat Cupra', o)).toBe(true);
  });
});

describe('C821-U-04 — catégorie de dépense : référentiel des dépenses d’usage, forme grammaticale', () => {
  it('la catégorie vient du référentiel existant (vocabulaire et libellés du coût de possession), appliqué au texte ENTIER', () => {
    expect(usageCategoryOfWording('Carburant')).toBe('FUEL');
    expect(usageCategoryOfWording('sans  plomb')).toBe('FUEL');
    expect(usageCategoryOfWording('Péage')).toBe('TOLLS');
    expect(usageCategoryOfWording('Recharge électrique')).toBe('CHARGING');
    // Un texte qui dit autre chose en plus ne désigne pas une catégorie, alors que le classement lexical du coût de possession y lit un mot.
    expect(usageCategoriesOfText('Bouchon de réservoir essence')).toEqual(['FUEL']);
    expect(usageCategoryOfWording('Bouchon de réservoir essence')).toBeNull();
    for (const t of ['', null, undefined, 'TotalEnergies', 'Cupra', 'Autre dépense d’usage', 'Coussin']) expect(usageCategoryOfWording(t), String(t)).toBeNull();
    expect(expenseCategoryLabelOfWording('gazole')).toBe(USAGE_BUDGET_CATEGORY_LABELS.FUEL);
    expect(expenseCategoryLabelOfWording('Coussin')).toBeNull();
  });
  it('forme du libellé pour CHAQUE catégorie reconnaissable du référentiel : « Achat de … », élision devant une voyelle', () => {
    expect(acquisitionLabelFromCategory(USAGE_BUDGET_CATEGORY_LABELS.FUEL)).toBe('Achat de carburant');
    expect(acquisitionLabelFromCategory(USAGE_BUDGET_CATEGORY_LABELS.CHARGING)).toBe('Achat de recharge électrique');
    expect(acquisitionLabelFromCategory(USAGE_BUDGET_CATEGORY_LABELS.TOLLS)).toBe('Achat de péages');
    expect(acquisitionLabelFromCategory('Électricité')).toBe('Achat d’électricité');
    expect(acquisitionLabelFromCategory('GPL')).toBe('Achat de GPL');
    expect(acquisitionLabelFromCategory('')).toBeNull();
    expect(acquisitionLabelFromCategory(null)).toBeNull();
  });
});

describe('C821-U-05 — T3 : nom porté par l’identité du candidat', () => {
  it('ticket de carburant rattaché à la Cupra : « Achat de carburant », fondement CATÉGORIE ; le nom de la règle antérieure est tracé', () => {
    const id = buildCandidateIdentity(persiste(), ctxT3(designation('de carburant TotalEnergies')));
    expect(id).toMatchObject({ designationLabel: 'Achat de carburant', designationBasis: 'CATEGORY', supersededDesignationLabel: 'Achat de carburant TotalEnergies', assetIds: [CUPRA] });
    expect(sourceLabelOf(id)).toBe('Achat de carburant');
    // Désignation déjà exacte : rien à tracer.
    const exact = buildCandidateIdentity(persiste(), ctxT3(designation('de carburant')));
    expect(exact.designationLabel).toBe('Achat de carburant');
    expect(exact.supersededDesignationLabel).toBeUndefined();
  });
  it('catégorie seule (aucune désignation) : lue dans le résumé du candidat ; résumé non catégoriel : repli existant (résumé)', () => {
    expect(buildCandidateIdentity(persiste({ summary: 'Carburant' }), ctxT3())).toMatchObject({ designationLabel: 'Achat de carburant', designationBasis: 'CATEGORY' });
    const libre = buildCandidateIdentity(persiste({ summary: 'Plein avant le départ' }), ctxT3());
    expect(libre.designationLabel).toBeUndefined();
    expect(sourceLabelOf(libre)).toBe('Plein avant le départ');
  });
  it('désignation réduite au fournisseur ou au bien associé : aucun nom ; l’ancien nom (#813) est tracé comme intitulé du système', () => {
    const tiers = buildCandidateIdentity(persiste(), ctxT3(designation('TotalEnergies')));
    expect(tiers.designationLabel).toBeUndefined();
    expect(tiers.supersededDesignationLabel).toBe('Achat TotalEnergies');
    const bien = buildCandidateIdentity(persiste(), ctxT3(designation('Cupra')));
    expect(bien.designationLabel).toBeUndefined();
    expect(bien.supersededDesignationLabel).toBe('Achat Cupra');
  });
  it('« Achat Cupra » seulement quand CE document est la preuve canonique de l’acquisition de la Cupra', () => {
    const achat = { fileId: FICHIER, established: true, status: 'REALIZED', role: 'INVOICE' as const, assetIds: [CUPRA], equipmentIds: [] };
    expect(provenAssetAcquisition(achat, preuveAchatDuBien.acquisitionEvidence)).toBe(CUPRA);
    expect(provenAssetAcquisition(achat, undefined)).toBeNull();
    expect(provenAssetAcquisition({ ...achat, fileId: 51 }, preuveAchatDuBien.acquisitionEvidence)).toBeNull(); // preuve d'un autre document
    expect(provenAssetAcquisition({ ...achat, role: 'ORDER' }, preuveAchatDuBien.acquisitionEvidence)).toBeNull();
    expect(provenAssetAcquisition({ ...achat, status: 'ENVISAGED' }, preuveAchatDuBien.acquisitionEvidence)).toBeNull();
    expect(provenAssetAcquisition({ ...achat, equipmentIds: [3] }, preuveAchatDuBien.acquisitionEvidence)).toBeNull();
    expect(provenAssetAcquisition({ ...achat, assetIds: [CUPRA, 8] }, preuveAchatDuBien.acquisitionEvidence)).toBeNull();

    expect(buildCandidateIdentity(persiste(), ctxT3(preuveAchatDuBien))).toMatchObject({ designationLabel: 'Achat Cupra', designationBasis: 'ASSET_ACQUISITION' });
    // Même candidat, même bien associé, SANS preuve d'acquisition : jamais « Achat Cupra ».
    expect(buildCandidateIdentity(persiste(), ctxT3()).designationLabel).toBeUndefined();
    // La désignation du véhicule acheté garde la priorité sur son nom dans le compte.
    expect(buildCandidateIdentity(persiste(), ctxT3({ ...preuveAchatDuBien, ...designation('Cupra Formentor VZ') })).designationLabel).toBe('Achat Cupra Formentor VZ');
  });
  it('document à plusieurs achats : la désignation du document ne nomme aucun d’eux ; autre type que l’achat : aucun nom', () => {
    const a = persiste({ id: 1, candidateKey: 'op1', summary: 'Carburant' });
    const b = persiste({ id: 2, candidateKey: 'op2', summary: 'Lavage' });
    const ctx = ctxT3({ ...designation('de carburant'), documentCandidates: [a, b] });
    expect(buildCandidateIdentity(a, ctx)).toMatchObject({ designationLabel: 'Achat de carburant', designationBasis: 'CATEGORY' }); // catégorie de SON résumé
    expect(buildCandidateIdentity(b, ctx).designationLabel).toBeUndefined();
    expect(buildCandidateIdentity(persiste({ typeHint: 'INTERVENTION', summary: 'Carburant' }), ctxT3(designation('de carburant'))).designationLabel).toBeUndefined();
  });
});

describe('C821-U-06 — T3 : intitulé du système remplacé, intitulé de l’utilisateur jamais touché', () => {
  // Carte #859 : l'autorité est celle du CHAMP intitulé (SYSTEM / USER / INCONNU, `title-provenance.ts`), plus la garde
  // globale `fullyManaged` ni l'égalité avec un résumé ou une valeur enregistrée (`recordedLabel`) — défauts déclarés
  // par la carte. Les attentes sur la règle de NOMMAGE (#813, #821) sont inchangées.
  const SYSTEM = { authority: 'SYSTEM' as const };
  const USER = { authority: 'USER' as const };
  const INCONNU = { authority: 'UNKNOWN' as const };
  const source = contribution(buildCandidateIdentity(persiste(), ctxT3(designation('de carburant TotalEnergies'))));
  const decision = (technicalLabel: string | null, over: Partial<Parameters<typeof acquisitionLabelDecision>[0]> = {}) =>
    acquisitionLabelDecision({ typeCode: 'ACQUISITION', technicalLabel, authority: SYSTEM, contributions: [source], ...over });
  it('intitulé absent, égal au résumé (« Achat ») ou à l’ancien nom (#813) : remplacé par « Achat de carburant »', () => {
    expect(decision(null)).toBe('Achat de carburant');
    expect(decision('Achat')).toBe('Achat de carburant');
    expect(decision('Achat de carburant TotalEnergies')).toBe('Achat de carburant');
  });
  it('déjà à jour : rien à écrire (idempotence)', () => {
    expect(decision('Achat de carburant')).toBeUndefined();
  });
  it('intitulé de l’utilisateur (même égal au résumé « Achat ») ou de provenance inconnue : jamais remplacé', () => {
    expect(decision('Plein du départ en vacances', { authority: USER })).toBeUndefined();
    expect(decision('Achat', { authority: USER })).toBeUndefined();
    expect(decision('Achat de carburant TotalEnergies', { authority: USER })).toBeUndefined();
    expect(decision('Achat', { authority: INCONNU })).toBeUndefined();
    expect(decision(null, { authority: INCONNU })).toBeUndefined();
  });
  it('intitulé SYSTEM qu’aucune source ne porte plus : amélioré ; fondement retiré (plus de nom d’objet) : repli existant, le résumé', () => {
    expect(decision('Achat carburant Total')).toBe('Achat de carburant');
    const sansNom = contribution(buildCandidateIdentity(persiste({ summary: 'Achat' }), ctxT3()));
    expect(acquisitionLabelDecision({ typeCode: 'ACQUISITION', technicalLabel: 'Achat Cupra', authority: SYSTEM, contributions: [sansNom] })).toBe('Achat');
    expect(acquisitionLabelDecision({ typeCode: 'ACQUISITION', technicalLabel: 'Achat Cupra', authority: INCONNU, contributions: [sansNom] })).toBeUndefined();
  });
  it('autre type que l’achat : la règle ne s’applique pas', () => {
    expect(decision('Achat', { typeCode: 'INTERVENTION' })).toBeUndefined();
  });
  it('ancien nom (#813) sans nom d’objet aujourd’hui (« Achat TotalEnergies ») : retour au repli existant, le résumé', () => {
    const tiers = contribution(buildCandidateIdentity(persiste({ summary: 'Ticket de caisse' }), ctxT3(designation('TotalEnergies'))));
    expect(acquisitionLabelDecision({ typeCode: 'ACQUISITION', technicalLabel: 'Achat TotalEnergies', authority: SYSTEM, contributions: [tiers] })).toBe('Ticket de caisse');
    expect(acquisitionLabelDecision({ typeCode: 'ACQUISITION', technicalLabel: 'Ticket de caisse', authority: SYSTEM, contributions: [tiers] })).toBeUndefined();
    expect(acquisitionLabelDecision({ typeCode: 'ACQUISITION', technicalLabel: 'Mon plein', authority: USER, contributions: [tiers] })).toBeUndefined();
  });
});

describe('C821-U-07 — T4 : titre de l’événement = intitulé de l’opération ; libellé neutre sinon', () => {
  it('« Achat de carburant », « Achat Polisport groovy coussin gris », « Achat Cupra » : tels qu’enregistrés', () => {
    expect(titreVoulu(op())).toBe('Achat de carburant');
    expect(titreVoulu(op({ technicalLabel: 'Achat Polisport groovy coussin gris', assetNames: ['Jean Fourche'] }))).toBe('Achat Polisport groovy coussin gris');
    expect(titreVoulu(op({ technicalLabel: 'Achat Cupra' }))).toBe('Achat Cupra');
  });
  it('aucun intitulé descriptif : « Achat » — jamais « Achat — Cupra » ni « Achat — TotalEnergies »', () => {
    for (const technicalLabel of [null, 'Achat', '   ']) expect(titreVoulu(op({ technicalLabel })), String(technicalLabel)).toBe('Achat');
    expect(acquisitionEventTitle({ label: null })).toBe('Achat');
    expect(precisePurchaseTitle(op({ technicalLabel: 'Achat' }))).toBeNull();
    expect(precisePurchaseTitle(op({ technicalLabel: null }))).toBeNull();
    expect(precisePurchaseTitle(op({ technicalLabel: 'Cupra' }))).toBeNull(); // un intitulé qui n'est que le bien associé ne renomme rien
  });
  it('projection intacte du stock nommée « Achat » : même événement, titre seul modifié ; second passage : plan vide', () => {
    const fk = projectionFunctionalKey(10, 'ACQUISITION');
    const stock = item({ id: 201, projected: true, businessOperationId: 10, linkedOperationActive: true, functionalKey: fk, originRefType: 'business_operation', originRefId: 10, fileIds: [] });
    expect(plan(op(), { linked: [stock] })).toEqual([{ kind: 'SYNC', itemId: 201, changes: { title: 'Achat de carburant' } }]);
    expect(plan(op(), { linked: [{ ...stock, title: 'Achat de carburant' }] })).toEqual([]);
    // Modifiée par l'utilisateur : jamais réécrite.
    expect(plan(op(), { linked: [{ ...stock, title: 'Plein du 20', isAutomaticModified: true }] })).toEqual([]);
  });
});

describe('C821-U-08 — T4 : événement automatique intact nommé « Achat » renommé sur place', () => {
  it('événement du justificatif non encore relié : rattaché par provenance ET renommé (aucune création)', () => {
    expect(plan(op(), { candidates: [item()] })).toEqual([
      { kind: 'LINK', itemId: 100, reason: expect.any(String) },
      { kind: 'RETITLE', itemId: 100, title: 'Achat de carburant', from: 'Achat' },
    ]);
  });
  it('événement déjà relié qui porte l’achat : renommé ; « Achat — Cupra » aussi ; second passage : rien', () => {
    const relie = item({ businessOperationId: 10, linkedOperationActive: true, carriedFact: 'ACQUISITION', carrierOrigin: 'SYSTEM' });
    expect(plan(op(), { linked: [relie] })).toEqual([{ kind: 'RETITLE', itemId: 100, title: 'Achat de carburant', from: 'Achat' }]);
    expect(plan(op(), { linked: [{ ...relie, title: 'Achat — Cupra' }] })).toEqual([{ kind: 'RETITLE', itemId: 100, title: 'Achat de carburant', from: 'Achat — Cupra' }]);
    expect(plan(op(), { linked: [{ ...relie, title: 'Achat de carburant' }] })).toEqual([]);
  });
  it('titre explicite, titre saisi ou modifié par l’utilisateur, statut ouvert : jamais renommé', () => {
    const relie = item({ businessOperationId: 10, linkedOperationActive: true, carriedFact: 'ACQUISITION', carrierOrigin: 'SYSTEM' });
    expect(plan(op(), { linked: [{ ...relie, title: 'Achat — Pneus hiver' }] })).toEqual([]); // titre explicite
    expect(plan(op(), { linked: [{ ...relie, isAutomaticModified: true }] })).toEqual([]); // « Achat » gardé par l'utilisateur après modification
    expect(plan(op(), { linked: [{ ...relie, isAutomatic: false }] })).toEqual([]); // saisi à la main
    expect(plan(op(), { linked: [{ ...relie, pendingStatus: true }] })).toEqual([]);
  });
  it('opération sans intitulé précis : « Achat » reste « Achat » (rien n’est inventé, pas de « Achat — Cupra »)', () => {
    const relie = item({ businessOperationId: 10, linkedOperationActive: true, carriedFact: 'ACQUISITION', carrierOrigin: 'SYSTEM' });
    expect(plan(op({ technicalLabel: 'Achat' }), { linked: [relie] })).toEqual([]);
    expect(plan(op({ technicalLabel: null }), { linked: [relie] })).toEqual([]);
  });
  it('les autres types ne sont pas concernés ; l’intitulé générique d’une intervention garde sa règle (lot 76H)', () => {
    const relie = item({ businessOperationId: 10, linkedOperationActive: true, businessType: 'sale', title: 'Vente' });
    expect(plan(op({ typeCode: 'DISPOSAL', technicalLabel: 'Vente de la Cupra' }), { linked: [relie] }).some((a) => a.kind === 'RETITLE')).toBe(false);
  });
});

describe('C821-U-09 — cohérence : le renommage est un écart réparable de la projection', () => {
  it('RETITLE d’un achat : EVENT_OUT_OF_SYNC ; d’une intervention : laissé à COH-AGENDA-OCCURRENCES', () => {
    const actions = [{ kind: 'RETITLE', itemId: 100 }];
    expect(projectionGaps('ACQUISITION', actions)).toEqual(actions);
    expect(projectionAnomaly(projectionGaps('ACQUISITION', actions))).toBe('EVENT_OUT_OF_SYNC');
    expect(projectionGaps('INTERVENTION', actions)).toEqual([]);
    expect(projectionGaps('CONTRACT', actions)).toEqual([]);
  });
});
