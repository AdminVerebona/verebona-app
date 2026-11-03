/**
 * Lot 106A — représentations équivalentes d'un même fait (ticket P1 « Agenda —
 * doublons DPE non autoréparés ») : règles PURES (L106A-U-EQUIVALENCE).
 *
 *   U01  cas du ticket : 3 représentations (fiche/T4 dossier, générique « Contrôle réalisé », compromis) → CERTAIN, canonique stable,
 *        intitulé « DPE réalisé — Maison », preuve de la même occurrence reportée
 *   U02  réalisation 2020 ≠ échéance 2030 ; dates différentes ; type différent sans absorption → aucun groupe
 *   U03  deux n° ADEME différents → DISTINCT ; équipements différents → DISTINCT
 *   U04  générique d'un AUTRE diagnostic (sujet « Installation électrique ») → INCERTAIN, jamais absorbé
 *   U05  aucune référence stable, sources différentes → INCERTAIN (file T4) ; même source + même champ → CERTAIN
 *   U06  protections : saisi / modifié / statut posé à la main / confirmé / restauré → jamais absorbé ; statut automatique → canonique
 *   U07  représentation d'un événement de référence (Opération, projection) → jamais fusionnée par le code : décision T4
 *   U08  preuves réunies : document de même n° ADEME et même date rattaché à l'UNIQUE représentation ; jamais à un groupe en suspens
 *   U09  empreinte stable ; décision indépendante de l'ordre des éléments (convergence)
 *   U10  prévention à la source : `withoutDossierGenericEvents` (diagnosticDate + dpeDate → aucun « Contrôle réalisé » ; autre diagnostic conservé)
 *   U11  règles centrales : sujet non informatif, référence normalisée, intitulé générique
 */
import { describe, expect, it } from 'vitest';
import { buildGroups, corroborationsOf, decideAsset, decideGroup, protectionOf, type EqAsset, type EqDocument, type EqItem } from '../model';
import { normalizeReference, subjectIsUninformative, isGenericTitle, subjectDesignatesType } from '../rules';
import { withoutDossierGenericEvents } from '@/services/ai/source-analysis/steps/build-agenda-candidates.step';
import type { AgendaCandidate } from '@/services/ai/source-analysis/types';

const D = '2020-12-22';
const ADEME = '2069V2010945W';
const item = (id: number, o: Partial<EqItem> = {}): EqItem => ({
  id, title: 'DPE réalisé — DPE', date: D, nature: 'HISTORICAL', businessType: 'dpe', originType: 'asset_field', originFieldKey: 'dpeDate',
  functionalKey: `k${id}`, originFileId: 309, fileIds: [309], equipmentIds: [], isAutomatic: true, isAutomaticModified: false, manualStatus: null,
  confirmationMode: null, requiresQualification: true, occurrenceNature: 'CONFIRMED', projected: false, operationId: null, operationActive: false,
  completionProofFileId: null, userTouchEvent: false, autoStatusEvent: false, pendingConflict: false, restored: false, ...o,
});
const doc = (fileId: number, title: string, facts: Array<[string | null, string, { subject?: string; type?: string; nature?: string }?]>): EqDocument => ({
  fileId, title, documentTypeCode: null, documentDate: null,
  facts: facts.map(([k, v, x]) => ({ canonicalKey: k, value: v, subject: x?.subject ?? null, semanticType: x?.type ?? null, semanticNature: x?.nature ?? null })),
});
const maison: EqAsset = { assetId: 14, name: 'Maison', fields: {} };
const dossier309 = doc(309, 'Dossier de diagnostic technique', [
  ['dpeDate', D, { type: 'dpe', nature: 'HISTORICAL' }], ['diagnosticDate', D, { type: 'inspection', nature: 'HISTORICAL' }], ['dpeAdemeNumber', ADEME], ['dpeExpiryDate', '2030-12-21'],
]);
const compromis316 = doc(316, 'Compromis de vente', [['dpeDate', D, { type: 'dpe', nature: 'HISTORICAL' }], ['dpeAdemeNumber', `${ADEME.slice(0, 4)} ${ADEME.slice(4)}`]]);
const docs = (...l: EqDocument[]) => new Map(l.map((d) => [d.fileId, d]));
const stock = () => [
  item(102),
  item(103, { title: 'Contrôle réalisé — Maison', businessType: 'inspection', originType: 'qualified_document', originFieldKey: null, completionProofFileId: 309 }),
  item(104, { title: 'DPE réalisé — Maison', originFileId: 316, fileIds: [316] }),
];

describe('L106A-U-EQUIVALENCE — représentations équivalentes (pur)', () => {
  it('U01 — cas du ticket : une occurrence, canonique stable, intitulé et preuve', () => {
    const [d] = decideAsset(stock(), docs(dossier309, compromis316), maison);
    expect(d.group).toMatchObject({ key: `${D}|HISTORICAL|dpe`, memberIds: [102, 104], genericIds: [103] });
    expect(d).toMatchObject({ verdict: 'CONSOLIDATE', reason: 'SAME_STABLE_REFERENCE', canonicalId: 102, absorbIds: [103, 104] });
    expect(d.retitle).toEqual({ from: 'DPE réalisé — DPE', to: 'DPE réalisé — Maison' });
    expect(d.proofFileId).toBe(309);
    expect(d.evidence.references).toEqual([ADEME]);
  });

  it('U02 — réalisation ≠ échéance ; autre date ; autre type non absorbé → aucun groupe', () => {
    const l = [item(1), item(2, { nature: 'DEADLINE', originFieldKey: 'dpeExpiryDate', date: '2030-12-21', fileIds: [309] }),
      item(3, { date: '2020-12-23', originFileId: 316, fileIds: [316] }), item(4, { businessType: 'maintenance', title: 'Entretien chaudière', originFieldKey: null })];
    expect(buildGroups(l)).toEqual([]);
  });

  it('U03 — références stables différentes ou équipements différents → DISTINCT', () => {
    const autre = doc(316, 'Compromis', [['dpeDate', D], ['dpeAdemeNumber', '2169V9999999Z']]);
    expect(decideAsset([item(1), item(2, { originFileId: 316, fileIds: [316] })], docs(dossier309, autre), maison)[0]).toMatchObject({ verdict: 'DISTINCT', reason: 'STABLE_REFERENCES_DIFFER' });
    const m = [item(1, { businessType: 'maintenance', title: 'Entretien réalisé — Chaudière', originFieldKey: 'lastMaintenanceDate', equipmentIds: [7] }),
      item(2, { businessType: 'maintenance', title: 'Entretien réalisé — PAC', originFieldKey: 'lastMaintenanceDate', equipmentIds: [8] })];
    expect(decideAsset(m, docs(), maison)[0]).toMatchObject({ verdict: 'DISTINCT', reason: 'DIFFERENT_EQUIPMENTS' });
  });

  it('U04 — générique d’un AUTRE diagnostic du même dossier → incertain, jamais absorbé', () => {
    const elec = doc(309, 'Dossier', [['dpeDate', D], ['diagnosticDate', D, { subject: 'Installation électrique', type: 'inspection', nature: 'HISTORICAL' }], ['dpeAdemeNumber', ADEME]]);
    const l = [item(1), item(2, { title: 'Contrôle réalisé — Installation électrique', businessType: 'inspection', originType: 'qualified_document', originFieldKey: null }),
      item(3, { originFileId: 316, fileIds: [316] })];
    const [d] = decideAsset(l, docs(elec, compromis316), maison);
    expect(d.verdict).toBe('CONSOLIDATE');
    expect(d.absorbIds).toEqual([3]);
    expect(d.uncertainIds).toEqual([2]);
    expect(d.kept).toContainEqual({ id: 2, why: 'IDENTITY_UNCERTAIN' });
  });

  it('U05 — sans référence stable : sources différentes → incertain ; même source et même champ → certain', () => {
    const sans = (f: number) => doc(f, `Doc ${f}`, [['dpeDate', D]]);
    const [u] = decideAsset([item(1), item(2, { originFileId: 316, fileIds: [316] })], docs(sans(309), sans(316)), maison);
    expect(u).toMatchObject({ verdict: 'UNCERTAIN', reason: 'NO_STABLE_REFERENCE', uncertainIds: [1, 2], operationIds: [] });
    const [c] = decideAsset([item(1, { businessType: 'maintenance', originFieldKey: 'lastMaintenanceDate', title: 'Entretien réalisé — Chaudière' }),
      item(2, { businessType: 'maintenance', originFieldKey: 'lastMaintenanceDate', title: 'Entretien réalisé — Chaudière' })], docs(sans(309)), maison);
    expect(c).toMatchObject({ verdict: 'CONSOLIDATE', reason: 'SAME_SOURCE_SAME_FIELD', canonicalId: 1, absorbIds: [2] });
  });

  it('U06 — protections de l’utilisateur ; statut automatique tracé → canonique, jamais absorbé', () => {
    expect(protectionOf(item(1, { isAutomatic: false }))).toBe('USER');
    expect(protectionOf(item(1, { isAutomaticModified: true }))).toBe('USER');
    expect(protectionOf(item(1, { confirmationMode: 'USER' }))).toBe('USER');
    expect(protectionOf(item(1, { userTouchEvent: true }))).toBe('USER');
    expect(protectionOf(item(1, { restored: true }))).toBe('USER');
    expect(protectionOf(item(1, { manualStatus: 'realise' }))).toBe('USER');
    expect(protectionOf(item(1, { manualStatus: 'realise', autoStatusEvent: true }))).toBe('STATUS');
    expect(protectionOf(item(1, { pendingConflict: true }))).toBe('CONFLICT');
    expect(protectionOf(item(1))).toBeNull();
    const l = stock();
    l[2] = { ...l[2], isAutomaticModified: true, title: 'Mon DPE' };
    const [d] = decideAsset(l, docs(dossier309, compromis316), maison);
    expect(d).toMatchObject({ verdict: 'CONSOLIDATE', canonicalId: 104, absorbIds: [102, 103], retitle: null });
    const s = stock();
    s[2] = { ...s[2], manualStatus: 'realise', autoStatusEvent: true };
    const [e] = decideAsset(s, docs(dossier309, compromis316), maison);
    expect(e).toMatchObject({ canonicalId: 104, absorbIds: [102, 103] });
    const deux = stock();
    deux[0] = { ...deux[0], userTouchEvent: true };
    deux[2] = { ...deux[2], isAutomaticModified: true };
    const [f] = decideAsset(deux, docs(dossier309, compromis316), maison);
    expect(f).toMatchObject({ canonicalId: 102, absorbIds: [103] });
    expect(f.kept).toContainEqual({ id: 104, why: 'PROTECTED_USER' });
  });

  it('U07 — représentation d’un événement de référence (Opération active, projection) → décision T4, aucune fusion par le code', () => {
    const l = stock();
    l[2] = { ...l[2], operationId: 55, operationActive: true };
    const [d] = decideAsset(l, docs(dossier309, compromis316), maison);
    expect(d).toMatchObject({ verdict: 'UNCERTAIN', reason: 'OPERATION_REPRESENTATION_T4', absorbIds: [], operationIds: [55] });
    expect(d.uncertainIds).toEqual([102, 103, 104]);
    const p = stock();
    p[0] = { ...p[0], projected: true, operationId: 56, operationActive: true };
    expect(decideAsset(p, docs(dossier309, compromis316), maison)[0]).toMatchObject({ verdict: 'UNCERTAIN', operationIds: [56] });
  });

  it('U08 — preuves réunies : même n° ADEME, même date → rattaché à l’unique représentation ; jamais à un groupe en suspens', () => {
    const seul = [item(1)];
    expect(corroborationsOf(seul, docs(dossier309, compromis316), maison, [309, 316], decideAsset(seul, docs(dossier309, compromis316), maison)))
      .toEqual([{ itemId: 1, fileId: 316, reference: ADEME }]);
    const autreDate = doc(316, 'Compromis', [['dpeDate', '2021-01-05'], ['dpeAdemeNumber', ADEME]]);
    expect(corroborationsOf(seul, docs(dossier309, autreDate), maison, [316], [])).toEqual([]);
    const l = stock();
    l[2] = { ...l[2], operationId: 55, operationActive: true };
    const dd = docs(dossier309, compromis316);
    expect(corroborationsOf(l, dd, maison, [309, 316], decideAsset(l, dd, maison))).toEqual([]);
  });

  it('U09 — empreinte stable et décision indépendante de l’ordre', () => {
    const a = decideAsset(stock(), docs(dossier309, compromis316), maison)[0];
    const b = decideAsset([...stock()].reverse(), docs(compromis316, dossier309), maison)[0];
    expect(b.fingerprint).toBe(a.fingerprint);
    expect([b.canonicalId, b.absorbIds, b.retitle]).toEqual([a.canonicalId, a.absorbIds, a.retitle]);
    const g = buildGroups(stock())[0];
    const parId = new Map(stock().map((i) => [i.id, i]));
    const autre = decideGroup(g, new Map([...parId].map(([k, v]) => [k, k === 104 ? { ...v, title: 'Autre' } : v])), docs(dossier309, compromis316), maison);
    expect(autre.fingerprint).not.toBe(a.fingerprint);
  });

  it('U10 — prévention à la source : date de dossier + DPE de même date → aucun « Contrôle réalisé » ; autre diagnostic conservé', () => {
    const c = (o: Partial<AgendaCandidate>): AgendaCandidate => ({ title: 'x', date: D, confidence: 'certain', excerpt: 'e', nature: 'HISTORICAL', target: { type: 'ASSET', id: 14 }, ...o } as AgendaCandidate);
    const dpe = c({ title: 'DPE réalisé — DPE', originFieldKey: 'dpeDate', businessType: 'dpe' });
    const gen = c({ title: 'Contrôle réalisé — Maison', businessType: 'inspection' });
    const fin = c({ title: 'Fin de validité du DPE', date: '2030-12-21', nature: 'DEADLINE', originFieldKey: 'dpeExpiryDate', businessType: 'dpe' });
    expect(withoutDossierGenericEvents([dpe, gen, fin], [{ key: 'dpeDate', subject: 'DPE' }, { key: 'diagnosticDate', subject: null, targetLabel: 'Maison' }, { key: 'dpeExpiryDate', subject: null }], { documentTitle: 'Dossier' }))
      .toEqual([dpe, fin]);
    expect(withoutDossierGenericEvents([dpe, gen], [{ key: 'dpeDate', subject: null }, { key: 'diagnosticDate', subject: 'Installation électrique' }], { documentTitle: 'Dossier' }))
      .toEqual([dpe, gen]);
    // Générique sans date de dossier (fait libre) : jamais retiré à la source.
    expect(withoutDossierGenericEvents([dpe, gen], [{ key: 'dpeDate', subject: null }, { key: null, subject: null }], { documentTitle: null })).toEqual([dpe, gen]);
    // Autre date, ou autre cible : conservé.
    expect(withoutDossierGenericEvents([dpe, { ...gen, date: '2020-12-23' }], [{ key: 'dpeDate', subject: null }, { key: 'diagnosticDate', subject: null }], { documentTitle: null })).toHaveLength(2);
    expect(withoutDossierGenericEvents([dpe, { ...gen, target: { type: 'EQUIPMENT', id: 3 } }], [{ key: 'dpeDate', subject: null }, { key: 'diagnosticDate', subject: null }], { documentTitle: null })).toHaveLength(2);
  });

  it('U11 — règles centrales : sujet non informatif, référence normalisée, intitulé générique', () => {
    expect(subjectIsUninformative('DPE réalisé — DPE')).toBe(true);
    expect(subjectIsUninformative('DPE réalisé — Compromis de vente', { documentTitles: ['Compromis de vente'] })).toBe(true);
    expect(subjectIsUninformative('DPE réalisé — Maison', { assetName: 'Maison' })).toBe(false);
    expect(subjectIsUninformative('DPE réalisé — Appartement Lyon', { documentTitles: ['Compromis'] })).toBe(false);
    expect(normalizeReference('2069 V20-10945w')).toBe(ADEME);
    expect(normalizeReference('12')).toBeNull();
    expect(isGenericTitle('Contrôle réalisé — Maison')).toBe(true);
    expect(isGenericTitle('Contrôle de la chaudière')).toBe(false);
    expect(subjectDesignatesType('Diagnostic de performance énergétique', 'dpe')).toBe(true);
    expect(subjectDesignatesType('Installation électrique', 'dpe')).toBe(false);
  });
});
