/**
 * Lot 75G — rapprochement documents ↔ équipements : règles pures et contexte
 * T3 (tickets « Rapprochement documents–équipements — écarts résiduels
 * 71A » = RDE-*, et « Biens / équipements — écarts résiduels 71A » = L71R-*).
 *
 * RDE-A1   Équipement certain + ambiguïté résiduelle : lien certain appliqué,
 *          ambiguïté conservée (groupe), jamais de choix arbitraire.
 * L71R-B1  Facture chaudière (n° de série) + VMC (modèle distinctif) : deux liens.
 * L71R-B2  Deux équipements similaires désignés « fort » : aucun lien, ambiguïté.
 * RDE-B1   N° de série lu seulement dans une unité source / un fait non résolu :
 *          rattachement déterministe (indice fort, pas « certain »).
 * RDE-B2   Simple mention dans une unité source (nom) : jamais une correspondance.
 * RDE-C1   Type / catégorie / désignation générique : jamais de lien ; deux
 *          équipements de même désignation générique → ambiguïté proposée.
 * RDE-F1   Sujet T3 volumineux : identifiants exacts et bien parent conservés,
 *          jamais tronqués partiellement, plus de 4 identifiants transmis.
 * RDE-F2   Concurrents « à ne pas confondre » choisis par pertinence.
 */
import { describe, expect, it } from 'vitest';
import {
  formatDocumentSubject, formatEquipmentCandidate, formatEquipmentSubject, matchDocumentToEquipments, T3_CANDIDATE_MAX, T3_SUBJECT_MAX,
  type DocumentFactProfile, type DocumentProfile, type EquipmentProfile,
} from '../document-equipment-matching';

const eq = (over: Partial<EquipmentProfile> & { id: number; name: string }): EquipmentProfile => ({
  assetId: 30, assetName: 'Maison', type: null, category: null, brand: null, model: null, serialNumber: null, room: null, features: [], ...over,
});
const doc = (over: Partial<DocumentProfile> = {}): DocumentProfile => ({
  fileId: 900, title: 'Facture', typeCode: 'FACTURE', description: null, supplier: null, documentDate: '2025-03-10',
  amountCents: null, assetIds: [30], assetNames: ['Maison'], facts: [], ...over,
});
const fait = (key: string, value: string, over: Partial<DocumentFactProfile> = {}): DocumentFactProfile => ({
  key, value, label: null, targetType: null, targetId: null, targetLabel: null, excerpt: null, ...over,
});

const CHAUDIERE = eq({ id: 3, name: 'Chaudière', brand: 'Frisquet', model: 'Prestige', serialNumber: 'FR-2020-77881' });
const ROBOT_A = eq({ id: 10, name: 'Robot aspirateur', brand: 'iRobot', model: 'Roomba i7' });
const ROBOT_B = eq({ id: 11, name: 'Robot aspirateur', brand: 'iRobot', model: 'Roomba i7' });
const VMC = eq({ id: 4, name: 'VMC', brand: 'Aldes', model: 'Dee Fly Cube 370' });

describe('RDE-A1 — ambiguïté partielle : les liens certains ne sont pas perdus, l’ambiguïté non plus', () => {
  it('chaudière certaine (n° de série) + robot ambigu entre deux équipements', () => {
    const r = matchDocumentToEquipments(doc({
      title: 'Facture chaudière et robot aspirateur',
      facts: [fait('serialNumber', 'FR-2020-77881'), fait('designation', 'Robot aspirateur')],
    }), [CHAUDIERE, ROBOT_A, ROBOT_B]);
    expect(r.status).toBe('LINKED');
    expect(r.links.map((l) => [l.equipmentId, l.method])).toEqual([[3, 'SERIAL_NUMBER']]);
    expect(r.ambiguous.map((x) => x.equipmentId)).toEqual([10, 11]);
    expect(r.groups).toEqual([[10, 11]]);
  });
  it('ambiguïté « expliquée » par un lien certain (même groupe) : rien ne reste à arbitrer', () => {
    const r = matchDocumentToEquipments(doc({ title: 'Garantie robot aspirateur', facts: [fait('serialNumber', 'R-0002')] }),
      [eq({ ...ROBOT_A, serialNumber: 'R-0001' }), eq({ ...ROBOT_B, serialNumber: 'R-0002' })]);
    expect(r).toMatchObject({ status: 'LINKED', links: [{ equipmentId: 11 }], ambiguous: [], groups: [] });
  });
});

describe('L71R-B — associations multiples démontrées', () => {
  it('L71R-B1 chaudière par n° de série + VMC par modèle distinctif : deux liens', () => {
    const r = matchDocumentToEquipments(doc({ facts: [fait('serialNumber', 'FR 2020 77881'), fait('modelName', 'Dee Fly Cube 370')] }),
      [CHAUDIERE, VMC, ROBOT_A]);
    expect(r.links.map((l) => [l.equipmentId, l.method])).toEqual([[3, 'SERIAL_NUMBER'], [4, 'BRAND_MODEL']]);
    expect(r.ambiguous).toEqual([]);
  });
  it('L71R-B2 deux équipements similaires désignés chacun par un indice « fort » : aucun lien automatique', () => {
    const a = eq({ id: 20, name: 'Pompe de relevage', model: 'DRAIN-5000' });
    const b = eq({ id: 21, name: 'Pompe de relevage cave', model: 'DRAIN-5000X' });
    // Modèle de A (unique) et nom complet de B : deux équipements « semblables » (noms inclus l'un dans l'autre).
    const r = matchDocumentToEquipments(doc({ title: 'Remplacement pompe de relevage cave', facts: [fait('modelName', 'DRAIN-5000')] }), [a, b]);
    expect(r.links).toEqual([]);
    expect(r.status).toBe('AMBIGUOUS');
    expect(r.ambiguous.map((x) => x.equipmentId)).toEqual([20, 21]);
  });
  it('un indice fort semblable à un équipement certain est écarté (jamais deux robots pour un seul n° de série)', () => {
    const r = matchDocumentToEquipments(doc({ title: 'Robot aspirateur étage', facts: [fait('serialNumber', 'R-0001')] }),
      [eq({ id: 1, name: 'Robot aspirateur', serialNumber: 'R-0001' }), eq({ id: 2, name: 'Robot aspirateur étage' })]);
    expect(r.links.map((l) => l.equipmentId)).toEqual([1]);
  });
});

describe('RDE-B — sources persistées secondaires (unités source, faits non résolus)', () => {
  const PAC = eq({ id: 7, name: 'Chauffage salon', serialNumber: 'PAC-998877' });
  it('RDE-B1 n° de série seulement dans une unité source : rattachement, indice fort (pas certain)', () => {
    const r = matchDocumentToEquipments(doc({ sourceTexts: ['Appareil : n° de série PAC 998877, contrôle annuel'] }), [PAC, CHAUDIERE]);
    expect(r.status).toBe('LINKED');
    expect(r.links).toEqual([expect.objectContaining({ equipmentId: 7, method: 'SERIAL_NUMBER' })]);
    expect(r.links[0].score).toBeLessThan(1);
  });
  it('RDE-B1 n° de série seulement dans un fait non résolu : rattachement', () => {
    const r = matchDocumentToEquipments(doc({ facts: [fait('numeroSerie', 'PAC998877', { provenance: 'UNRESOLVED', label: 'N° de série' })] }), [PAC, CHAUDIERE]);
    expect(r.links.map((l) => l.equipmentId)).toEqual([7]);
  });
  it('RDE-B1 un fait non résolu ne vaut jamais « cible vérifiée »', () => {
    const r = matchDocumentToEquipments(doc({ facts: [fait('x', 'y', { provenance: 'UNRESOLVED', targetType: 'EQUIPMENT', targetId: 3 })] }), [CHAUDIERE]);
    expect(r.status).toBe('NONE');
  });
  it('RDE-B2 nom d’équipement cité dans une unité source : simple mention, aucune correspondance', () => {
    const r = matchDocumentToEquipments(doc({ sourceTexts: ['Prévoir aussi la chaudière lors du prochain passage'] }), [CHAUDIERE, VMC]);
    expect(r.status).toBe('NONE');
  });
});

describe('RDE-C1 — jamais de lien sur un type, une catégorie ou une désignation générique', () => {
  it('type seul : aucune correspondance', () => {
    expect(matchDocumentToEquipments(doc({ title: 'Facture électroménager' }), [eq({ id: 1, name: 'Robot', type: 'Électroménager', category: 'electromenager' })]).status).toBe('NONE');
  });
  it('désignation générique partagée (« radiateur ») : ambiguïté entre les radiateurs, aucun lien', () => {
    const r = matchDocumentToEquipments(doc({ title: 'Facture radiateur', description: 'Remplacement radiateur' }),
      [eq({ id: 1, name: 'Radiateur salon' }), eq({ id: 2, name: 'Radiateur chambre' }), eq({ id: 3, name: 'Ballon' })]);
    expect(r).toMatchObject({ status: 'AMBIGUOUS', links: [] });
    expect(r.ambiguous.map((x) => x.equipmentId)).toEqual([1, 2]);
  });
  it('désignation générique d’un seul équipement : aucune correspondance (insuffisant)', () => {
    expect(matchDocumentToEquipments(doc({ title: 'Facture radiateur' }), [eq({ id: 1, name: 'Radiateur salon' })]).status).toBe('NONE');
  });
});

describe('RDE-F — contexte T3 borné, priorisé, identifiants jamais tronqués', () => {
  it('RDE-F1 sujet volumineux : n° de série, modèles et bien parent conservés en entier, plus de 4 identifiants', () => {
    const series = Array.from({ length: 7 }, (_, i) => `SN-2025-${String(i).padStart(4, '0')}`);
    const d = doc({
      title: 'Facture multi-équipements', description: 'x'.repeat(2000),
      facts: [
        ...Array.from({ length: 60 }, (_, i) => fait(`ligne${i}`, `Article divers ${i} ${'y'.repeat(80)}`, { excerpt: 'z'.repeat(100) })),
        ...series.map((s) => fait('serialNumber', s, { excerpt: `S/N ${s}` })),
      ],
    });
    const s = formatDocumentSubject(d);
    expect(s.length).toBeLessThanOrEqual(T3_SUBJECT_MAX);
    const resume = s.split(' | ').filter((x) => x.startsWith('n° de série lu(s)')).join(' ');
    for (const x of series) expect(resume).toContain(x);
    expect(s).toContain('bien(s) parent(s):#30');
    expect(s.indexOf('n° de série lu(s)')).toBeLessThan(s.indexOf('description:') === -1 ? Infinity : s.indexOf('description:'));
  });
  it('RDE-F1 identifiant trop long pour la borne : omis en entier, jamais coupé', () => {
    const geant = `SER${'9'.repeat(200)}`;
    const ligne = formatEquipmentCandidate(eq({ id: 1, name: 'Pompe', serialNumber: geant, model: 'M-12345' }));
    expect(ligne.length).toBeLessThanOrEqual(T3_CANDIDATE_MAX);
    expect(ligne).toContain('modèle:M-12345');
    expect(ligne.includes('SER999')).toBe(ligne.includes(geant));
  });
  it('RDE-F2 concurrents par pertinence : l’équipement semblable passe avant les autres, quel que soit l’ordre de lecture', () => {
    const autres = Array.from({ length: 8 }, (_, i) => eq({ id: 100 + i, name: `Appareil ${i}`, type: 'divers' }));
    const jumeau = eq({ id: 999, name: 'Robot aspirateur étage', brand: 'iRobot', model: 'Roomba i7' });
    const s = formatEquipmentSubject(ROBOT_A, [...autres, jumeau]);
    expect(s).toContain('à ne pas confondre avec l’équipement #999');
    expect(s.indexOf('#999')).toBeLessThan(s.indexOf('#100') === -1 ? Infinity : s.indexOf('#100'));
    expect(s.length).toBeLessThanOrEqual(T3_SUBJECT_MAX);
  });
});
