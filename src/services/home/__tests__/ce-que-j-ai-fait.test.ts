/**
 * « Ce que j'ai fait » (§3.4) et « Documents récents » (§3.5) — dérivation
 * pure à partir des sources tracées (champs complétés, échéances lues,
 * documents analysés).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { deriveVerebonaWork, docStatus, docTone, joinLabels, relativeAgo, type WorkRawData } from '../home-blocks';

const vide: WorkRawData = { fieldUpdates: [], deadlines: [], documents: [] };

describe('frise à la 1re personne', () => {
  it('champs complétés : un événement par bien et par jour, libellés lisibles', () => {
    const w = deriveVerebonaWork({
      ...vide,
      fieldUpdates: [
        { assetId: 3, assetName: 'Ferrari Testarossa', fieldKey: 'registrationNumber', fieldLabel: 'immatriculation', createdAt: '2026-09-22T10:00:00Z' },
        { assetId: 3, assetName: 'Ferrari Testarossa', fieldKey: 'vin', fieldLabel: 'numéro VIN', createdAt: '2026-09-22T10:00:01Z' },
        { assetId: 3, assetName: 'Ferrari Testarossa', fieldKey: 'notes', fieldLabel: 'notes', createdAt: '2026-09-22T10:00:02Z' },
      ],
    });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({
      kind: 'fields', tone: 'blue', cta: 'Voir les modifications',
      text: 'J’ai complété trois informations sur Ferrari Testarossa : immatriculation, numéro VIN et notes.',
      target: { kind: 'asset', assetId: 3, fieldKey: null },
    });
  });

  it('un seul champ : la fiche s’ouvre sur ce champ', () => {
    const [e] = deriveVerebonaWork({ ...vide, fieldUpdates: [{ assetId: 3, assetName: 'Ferrari', fieldKey: 'vin', fieldLabel: 'numéro VIN', createdAt: '2026-09-22T10:00:00Z' }] });
    expect(e.text).toBe('J’ai complété une information sur Ferrari : numéro VIN.');
    expect(e.target).toEqual({ kind: 'asset', assetId: 3, fieldKey: 'vin' });
  });

  it('lot 22 : champ d’un équipement ou d’une pièce — libellé de l’entité, onglet de l’entité', () => {
    const [seul] = deriveVerebonaWork({ ...vide, fieldUpdates: [
      { assetId: 3, assetName: 'Maison', fieldKey: 'serialNumber', fieldLabel: 'numéro de série', createdAt: '2026-09-22T10:00:00Z', entityLabel: 'Chaudière', entityTab: 'equipments' },
    ] });
    expect(seul.text).toBe('J’ai complété une information sur Maison : numéro de série (Chaudière).');
    expect(seul.target).toEqual({ kind: 'asset', assetId: 3, fieldKey: null, tab: 'equipments' });

    const [mixte] = deriveVerebonaWork({ ...vide, fieldUpdates: [
      { assetId: 3, assetName: 'Maison', fieldKey: 'dpeClass', fieldLabel: 'classe DPE', createdAt: '2026-09-22T10:00:00Z' },
      { assetId: 3, assetName: 'Maison', fieldKey: 'roomArea', fieldLabel: 'surface de la pièce', createdAt: '2026-09-22T10:00:01Z', entityLabel: 'Salon', entityTab: 'rooms' },
    ] });
    expect(mixte.text).toBe('J’ai complété deux informations sur Maison : classe DPE et surface de la pièce (Salon).');
    expect(mixte.target).toEqual({ kind: 'asset', assetId: 3, fieldKey: null });
  });

  it('lot 22 : l’accueil lit la cible des lignes (0236) et ouvre l’onglet de l’entité', () => {
    const svc = readFileSync(join(process.cwd(), 'src/services/home/HomeSummaryService.ts'), 'utf8');
    expect(svc).toMatch(/visibleFieldUpdatesWhere\(cible, ENRICH_VISIBLE_FIELDS\)/);
    expect(svc).toMatch(/entityLabel: r\.targetType \? r\.entityName : null/);
    const ui = readFileSync(join(process.cwd(), 'src/components/home/HomeBlocks.tsx'), 'utf8');
    expect(ui).toMatch(/else if \(t\.tab\) push\(`\/assets\/\$\{t\.assetId\}\?tab=\$\{t\.tab\}`\)/);
  });

  it('échéance lue dans un document', () => {
    const [e] = deriveVerebonaWork({
      ...vide,
      deadlines: [{ id: 12, title: 'Renouvellement', date: '2027-08-28', createdAt: '2026-09-20T08:00:00Z', documentId: 5, documentTitle: 'Contrat d’assurance auto', assetName: 'Ferrari' }],
    });
    expect(e).toMatchObject({
      kind: 'deadline', tone: 'green', cta: 'Voir dans l’agenda', target: { kind: 'agenda', id: 12 },
      text: 'J’ai identifié une nouvelle échéance dans « Contrat d’assurance auto » : renouvellement le 28 août 2027.',
    });
  });

  it('documents : analysé, en analyse, à valider ; un échec n’est pas « fait »', () => {
    const w = deriveVerebonaWork({
      ...vide,
      documents: [
        { id: 1, title: 'Carte grise', assetName: 'Ferrari', analysisState: 'ANALYZING', at: '2026-09-20T08:00:00Z' },
        { id: 2, title: 'Facture', assetName: null, analysisState: 'ANALYSIS_FAILED', at: '2026-09-21T08:00:00Z' },
        { id: 3, title: 'Bail', assetName: 'Maison', analysisState: 'VALIDATION_REQUIRED', at: '2026-09-19T08:00:00Z' },
      ],
    });
    expect(w.map((x) => x.text)).toEqual([
      'J’analyse « Carte grise », rattaché à Ferrari.',
      'J’ai analysé « Bail » : des informations attendent votre validation.',
    ]);
    expect(w[0].target).toEqual({ kind: 'document', id: 1 });
    // Aucune trace ne dit qui a rattaché le document : jamais « j'ai rattaché ».
    expect(w.some((x) => /J’ai rattaché/.test(x.text))).toBe(false);
  });

  it('un document dont l’analyse a complété des champs n’est pas répété', () => {
    const w = deriveVerebonaWork({
      fieldUpdates: [{ assetId: 3, assetName: 'Ferrari', fieldKey: 'vin', fieldLabel: 'numéro VIN', assetFileId: 7, createdAt: '2026-09-22T10:00:00Z' }],
      deadlines: [],
      documents: [{ id: 7, title: 'Carte grise', assetName: 'Ferrari', analysisState: 'ANALYZED', at: '2026-09-22T09:59:00Z' }],
    });
    expect(w.map((x) => x.kind)).toEqual(['fields']);
  });

  it('du plus récent au plus ancien, borné', () => {
    const w = deriveVerebonaWork({
      fieldUpdates: [{ assetId: 1, assetName: 'A', fieldKey: 'vin', fieldLabel: 'numéro VIN', createdAt: '2026-09-18T00:00:00Z' }],
      deadlines: [{ id: 1, title: 'CT', date: null, createdAt: '2026-09-22T00:00:00Z', documentId: null, documentTitle: null, assetName: 'A' }],
      documents: [{ id: 1, title: 'D', assetName: null, analysisState: 'ANALYZED', at: '2026-09-20T00:00:00Z' }],
    }, 2);
    expect(w.map((x) => x.kind)).toEqual(['deadline', 'document']);
    expect(w[0].text).toBe('J’ai identifié une nouvelle échéance pour A : CT, date à préciser.');
  });

  it('libellés et moments', () => {
    expect(joinLabels(['a'])).toBe('a');
    expect(joinLabels(['a', 'b', 'c'])).toBe('a, b et c');
    expect(joinLabels(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c et 2 autres');
    const now = new Date('2026-09-23T12:00:00');
    expect(relativeAgo('2026-09-23T08:00:00', now)).toBe('Aujourd’hui');
    expect(relativeAgo('2026-09-22T08:00:00', now)).toBe('Hier');
    expect(relativeAgo('2026-09-20T08:00:00', now)).toBe('Il y a 3 jours');
    expect(relativeAgo('2026-09-09T08:00:00', now)).toBe('Il y a 2 semaines');
    expect(relativeAgo('2025-06-01T08:00:00', now)).toBe('1 juin 2025');
  });
});

describe('documents récents', () => {
  it('statut seulement s’il appelle un regard ; couleur par rubrique', () => {
    expect(docStatus('ANALYZING')).toBe('En analyse');
    expect(docStatus('ANALYZED')).toBeNull();
    expect(docStatus(null)).toBeNull();
    expect(docTone('INSURANCE_CLAIMS')).toBe('green');
    expect(docTone(null)).toBe('slate');
  });

  it('le résumé de l’accueil expose les deux blocs (sans cartes statistiques)', () => {
    const svc = readFileSync(join(process.cwd(), 'src/services/home/HomeSummaryService.ts'), 'utf8');
    expect(svc).toMatch(/verebonaWork: \{ items: verebonaWork \}/);
    expect(svc).toMatch(/recentDocuments: \{ items: recentDocuments \}/);
    const page = readFileSync(join(process.cwd(), 'src/app/(dashboard)/accueil/page.tsx'), 'utf8');
    expect(page).not.toMatch(/HomeStatsGrid/);
  });
});
