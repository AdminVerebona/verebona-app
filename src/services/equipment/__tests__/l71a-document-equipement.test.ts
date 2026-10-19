/**
 * Lot 71A — rapprochement document ↔ équipement (règles pures) et contexte
 * transmis à T3 (ticket P1 « Enrichir les données transmises à T3 »).
 *
 * EQP-10  Garantie du robot : cible T1 vérifiée → l'équipement existant.
 * EQP-11  Deux équipements similaires : jamais confondus (désignation commune
 *         ambiguë ; n° de série / modèle départagent).
 * EQP-12  Associations multiples (facture « chaudière et VMC »).
 * EQP-13  Catégorie / type seuls : jamais une correspondance ; champ absent :
 *         jamais une correspondance.
 * T3EQ-01 Candidat T3 : identifiant, bien parent, marque, modèle, n° de série
 *         (identifiants d'abord), aucune donnée d'achat du bien.
 * T3EQ-02 Sujet document : métadonnées séparées, identifiants lus, faits T1
 *         avec cibles et preuves.
 * T3EQ-03 Troncature : les informations discriminantes ne sont jamais perdues
 *         (parseCandidates conserve 1 000 caractères, champs bornés).
 * T3EQ-04 N° de série exact et unique : décision sans IA (LINKED certain).
 * T3EQ-05 Sens EQUIPMENT_DOCUMENT : candidat document et sujet équipement
 *         enrichis (« à ne pas confondre avec »).
 */
import { describe, it, expect } from 'vitest';
import {
  matchDocumentToEquipments, formatEquipmentCandidate, formatDocumentSubject, formatDocumentCandidate,
  formatEquipmentSubject, joinWithinLimit, T3_CANDIDATE_MAX, type DocumentProfile, type EquipmentProfile,
} from '../document-equipment-matching';
import { parseCandidates } from '@/services/ai/reconciliation/master/link-ambiguity';

const eq = (over: Partial<EquipmentProfile> & { id: number; name: string }): EquipmentProfile => ({
  assetId: 30, assetName: 'Maison', type: null, category: null, brand: null, model: null, serialNumber: null, room: null, features: [], ...over,
});
const doc = (over: Partial<DocumentProfile> = {}): DocumentProfile => ({
  fileId: 900, title: 'Document', typeCode: 'CERTIFICAT_GARANTIE', description: null, supplier: null, documentDate: '2025-03-10',
  amountCents: null, assetIds: [30], assetNames: ['Maison'], facts: [], ...over,
});
const fait = (key: string, value: string, over: Partial<DocumentProfile['facts'][number]> = {}) => ({
  key, value, label: null, targetType: null, targetId: null, targetLabel: null, excerpt: null, ...over,
});

const ROBOT = eq({ id: 1, name: 'Robot aspirateur', type: 'Électroménager', brand: 'iRobot', model: 'Roomba i7', serialNumber: 'R7-2024-0001' });
const ROBOT_ETAGE = eq({ id: 2, name: 'Robot aspirateur étage', type: 'Électroménager', brand: 'iRobot', model: 'Roomba i7', serialNumber: 'R7-2024-0002' });
const CHAUDIERE = eq({ id: 3, name: 'Chaudière', type: 'chaudiere', brand: 'Frisquet', model: 'Prestige' });
const VMC = eq({ id: 4, name: 'VMC double flux', type: 'ventilation' });

describe('EQP-10 — document d’un équipement existant', () => {
  it('cible T1 vérifiée → équipement rattaché', () => {
    const r = matchDocumentToEquipments(doc({ title: 'Garantie', facts: [fait('warrantyEndDate', '2027-03-10', { targetType: 'EQUIPMENT', targetId: 1 })] }), [ROBOT, CHAUDIERE]);
    expect(r).toMatchObject({ status: 'LINKED', links: [{ equipmentId: 1, method: 'VERIFIED_TARGET' }] });
  });
  it('cible vers un équipement d’un AUTRE bien : ignorée', () => {
    const r = matchDocumentToEquipments(doc({ facts: [fait('warrantyEndDate', '2027-03-10', { targetType: 'EQUIPMENT', targetId: 99 })] }), [ROBOT]);
    expect(r.status).toBe('NONE');
  });
  it('désignation unique dans le titre → rattaché', () => {
    expect(matchDocumentToEquipments(doc({ title: 'Garantie chaudière' }), [ROBOT, CHAUDIERE]).links.map((l) => l.equipmentId)).toEqual([3]);
  });
});

describe('EQP-11 — deux équipements similaires ne sont pas confondus', () => {
  it('désignation commune (« Robot aspirateur » ⊂ « Robot aspirateur étage ») : AMBIGUOUS, aucun lien', () => {
    const r = matchDocumentToEquipments(doc({ title: 'Garantie robot aspirateur' }), [ROBOT, ROBOT_ETAGE]);
    expect(r.status).toBe('AMBIGUOUS');
    expect(r.links).toEqual([]);
    expect(r.ambiguous.map((x) => x.equipmentId)).toEqual([1, 2]);
  });
  it('désignation la plus précise lue : seul cet équipement', () => {
    const r = matchDocumentToEquipments(doc({ title: 'Garantie robot aspirateur étage' }), [ROBOT, ROBOT_ETAGE]);
    expect(r).toMatchObject({ status: 'LINKED', links: [{ equipmentId: 2, method: 'DESIGNATION' }] });
  });
  it('même marque et même modèle : ambigu ; le n° de série départage (T3EQ-04 : sans IA)', () => {
    const modele = matchDocumentToEquipments(doc({ facts: [fait('modelName', 'Roomba i7'), fait('brand', 'iRobot')] }), [ROBOT, ROBOT_ETAGE]);
    expect(modele.status).toBe('AMBIGUOUS');
    const serie = matchDocumentToEquipments(doc({ title: 'Garantie robot aspirateur', facts: [fait('modelName', 'Roomba i7'), fait('serialNumber', 'r7 2024 0002')] }), [ROBOT, ROBOT_ETAGE]);
    expect(serie).toMatchObject({ status: 'LINKED', links: [{ equipmentId: 2, method: 'SERIAL_NUMBER', score: 1 }], ambiguous: [] });
  });
  it('n° de série partagé par deux équipements : ambigu', () => {
    const a = eq({ id: 5, name: 'Radiateur A', serialNumber: 'RAD12345' });
    const b = eq({ id: 6, name: 'Radiateur B', serialNumber: 'RAD-12345' });
    expect(matchDocumentToEquipments(doc({ facts: [fait('serialNumber', 'RAD12345')] }), [a, b]).status).toBe('AMBIGUOUS');
  });
  it('marque lue incompatible : le modèle seul ne suffit pas', () => {
    const r = matchDocumentToEquipments(doc({ facts: [fait('modelName', 'Prestige'), fait('brand', 'Saunier Duval')] }), [CHAUDIERE]);
    expect(r.status).toBe('NONE');
  });
});

describe('EQP-12 — un document peut concerner plusieurs équipements', () => {
  it('facture « entretien chaudière et VMC double flux » : deux liens', () => {
    const r = matchDocumentToEquipments(doc({ title: 'Entretien chaudière et VMC double flux' }), [ROBOT, CHAUDIERE, VMC]);
    expect(r.links.map((l) => l.equipmentId)).toEqual([3, 4]);
  });
});

describe('EQP-13 — jamais d’indice inventé', () => {
  it('type / catégorie seuls : aucune correspondance', () => {
    expect(matchDocumentToEquipments(doc({ title: 'Facture électroménager' }), [ROBOT]).status).toBe('NONE');
  });
  it('équipement sans marque / modèle / n° de série : aucun champ absent ne correspond', () => {
    const nu = eq({ id: 7, name: 'Pompe' });
    expect(matchDocumentToEquipments(doc({ title: 'Facture', facts: [fait('serialNumber', 'ABC12345'), fait('modelName', 'X1')] }), [nu]).status).toBe('NONE');
  });
});

describe('T3EQ — contexte transmis à T3', () => {
  it('T3EQ-01 candidat équipement : id, bien parent, marque, modèle, n° de série d’abord ; aucune donnée d’achat', () => {
    const ligne = formatEquipmentCandidate({ ...ROBOT, room: 'Salon', features: ['usage:aucun'] });
    expect(ligne).toBe('[id:1] "Robot aspirateur" | bien parent:#30 "Maison" | marque:iRobot | modèle:Roomba i7 | n° de série:R7-2024-0001 | type:Électroménager | pièce:Salon | usage:aucun');
    expect(ligne).not.toMatch(/achat|prix|acquisition/i);
  });

  it('T3EQ-02 sujet document : métadonnées, identifiants lus, faits T1 avec cible et preuve', () => {
    const s = formatDocumentSubject(doc({
      title: 'Garantie robot aspirateur', supplier: 'Darty', amountCents: 49900,
      facts: [
        fait('warrantyEndDate', '2027-03-10', { label: 'Fin de garantie', targetType: 'EQUIPMENT', targetId: 1, targetLabel: 'Robot', excerpt: 'Garantie jusqu’au 10/03/2027' }),
        fait('serialNumber', 'R7-2024-0001', { excerpt: 'S/N R7-2024-0001' }),
      ],
    }));
    expect(s).toContain('Document #900 « Garantie robot aspirateur »');
    expect(s).toContain('bien(s) parent(s):#30 "Maison"');
    expect(s).toContain('n° de série lu(s):R7-2024-0001');
    expect(s).toContain('fait T1: Fin de garantie = 2027-03-10 [cible EQUIPMENT#1 « Robot »] « Garantie jusqu’au 10/03/2027 »');
    // Identifiants avant les autres faits.
    expect(s.indexOf('serialNumber = R7')).toBeLessThan(s.indexOf('Fin de garantie ='));
  });

  it('T3EQ-03 troncature : identifiants conservés malgré une description très longue', () => {
    const long = { ...ROBOT, features: Array.from({ length: 40 }, (_, i) => `caractéristique ${i} ${'x'.repeat(60)}`) };
    const ligne = formatEquipmentCandidate(long);
    expect(ligne.length).toBeLessThanOrEqual(T3_CANDIDATE_MAX);
    const [c] = parseCandidates(ligne);
    expect(c.description).toContain('n° de série:R7-2024-0001');
    expect(c.description).toContain('modèle:Roomba i7');
    expect(c.description).toBe(ligne.replace('[id:1] ', ''));
    expect(joinWithinLimit(['abc', 'x'.repeat(50), 'de'], 10)).toBe('abc | de');
  });

  it('T3EQ-05 sens EQUIPMENT_DOCUMENT : candidat document et sujet équipement enrichis', () => {
    const c = formatDocumentCandidate(doc({ title: 'Notice', facts: [fait('modelName', 'Roomba i7', { excerpt: 'Modèle Roomba i7' })] }));
    expect(c.startsWith('[id:900] "Notice" | modèle(s) lu(s):Roomba i7')).toBe(true);
    const s = formatEquipmentSubject(ROBOT, [ROBOT_ETAGE]);
    expect(s).toContain('Équipement #1 "Robot aspirateur", bien parent:#30 "Maison", marque:iRobot, modèle:Roomba i7, n° de série:R7-2024-0001');
    expect(s).toContain('à ne pas confondre avec l’équipement #2');
  });
});
