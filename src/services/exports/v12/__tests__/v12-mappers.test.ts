/**
 * Mappeurs et moteur de sélection V12 : du bien (+ informations
 * complémentaires + choix) au contrat de données de chaque template, rendu en
 * HTML. Règles vérifiées sur le TEXTE RENDU :
 *   · champs vides masqués (PDF-TXT-002/003, IC-GEN-005) ;
 *   · pièces sensibles jamais incluses sans choix explicite (DEC-006, SEL-GEN-007) ;
 *   · estimation Verebona jamais imprimée (VENTE/LOCATION-RULE-001) ;
 *   · données d'occupant jamais imprimées (garde-fou des maquettes) ;
 *   · numéros de série / VIN masqués comme dans le design ;
 *   · pré-sélection par dossier (§6.2, §24), coûts de location jamais rendus.
 */
import { describe, it, expect } from 'vitest';
import { mapDossierData } from '../data/mappers';
import {
  buildDefaultChoices, choicesFromLegacyOptions, parseChoicesPayload, planSelection, resolveMode, eventKind,
  type ExportChoices,
} from '../data/choices';
import { classifyDocument, fileFormatOf } from '../data/documents';
import { renderDossierHtml } from '../templates';
import type { ResolvedFiles } from '../data/resolved';
import type { ExportSource } from '../data/source';
import type { DossierCode } from '@/services/exports/catalog';
import { makeSource, doc, photo, event, TODAY } from './fixtures/sources';

const META = { reference: 'VBN-TEST-000001', generatedAt: '2026-09-28T09:14:00+02:00', preparedBy: 'Claire Martin', templateLabel: 'test · v1.0', zipName: null, label: 'Test' };

function resolvedAllOk(source: ExportSource): ResolvedFiles {
  return {
    documents: new Map(source.documents.map((d) => [d.id, { id: d.id, status: 'ok' as const, pages: 2, localPath: `/tmp/d${d.id}`, imageUrl: d.format === 'PDF' ? undefined : `file:///tmp/d${d.id}.jpg` }])),
    photos: new Map(source.photos.map((p) => [p.id, { id: p.id, status: 'ok' as const, url: `file:///tmp/p${p.id}.jpg` }])),
  };
}

function render(code: DossierCode, source: ExportSource, choices: ExportChoices = buildDefaultChoices(code, source, { today: TODAY }), resolved: ResolvedFiles | null = resolvedAllOk(source)) {
  const plan = planSelection(code, source, choices, TODAY);
  const data = mapDossierData(code, { source, plan, resolved, meta: META, today: TODAY });
  const html = renderDossierHtml(code, data as never, { sys: 'SYS/', asset: (f) => (f ? `file:///tmp/${f}.jpg` : null), stylesheets: [], pageMap: null }).html;
  const text = html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/[  ]/g, ' ').replace(/\s+/g, ' ');
  return { plan, data, html, text };
}

const ALL: Array<[DossierCode, 'IMMOBILIER' | 'VEHICULE' | 'OBJET']> = [
  ['CIL', 'IMMOBILIER'], ['DOSSIER_COMPLET', 'IMMOBILIER'], ['DOSSIER_COMPLET', 'VEHICULE'], ['DOSSIER_COMPLET', 'OBJET'],
  ['VENTE', 'VEHICULE'], ['VENTE', 'IMMOBILIER'], ['VENTE', 'OBJET'], ['LOCATION', 'IMMOBILIER'],
  ['ASSURANCE_SOUSCRIPTION', 'OBJET'], ['ASSURANCE_SOUSCRIPTION', 'IMMOBILIER'], ['ASSURANCE_SOUSCRIPTION', 'VEHICULE'],
  ['ASSURANCE_SINISTRE', 'IMMOBILIER'], ['ASSURANCE_SINISTRE', 'VEHICULE'],
];

/** Un bien complet, avec pièges : estimation, occupant, sensible, coûts. */
function richSource(code: DossierCode, family: 'IMMOBILIER' | 'VEHICULE' | 'OBJET'): ExportSource {
  return makeSource(family, code, {
    documents: [
      doc({ id: 1, kind: 'FACTURE', title: 'Facture achat', amountCents: 549000 }),
      doc({ id: 2, kind: 'DPE', title: 'DPE 2024' }),
      doc({ id: 3, kind: 'ACTE_NOTARIE', title: 'Acte de vente notarié', sensitive: true }),
      doc({ id: 4, kind: 'DOCUMENT_BANCAIRE', title: 'RIB compte joint', sensitive: true }),
      doc({ id: 5, kind: 'LOCATIF', title: 'Bail locataire Garnier', occupantData: true }),
      doc({ id: 6, kind: 'GARANTIE', title: 'Garantie constructeur' }),
      doc({ id: 7, kind: 'DEVIS', title: 'Devis réparation fuite', date: '2026-08-02' }),
      doc({ id: 8, kind: 'PLAN_CONSTRUCTION', title: 'Plan appartement', format: 'PNG', mimeType: 'image/png' }),
    ],
    photos: [photo(1), photo(2), photo(3), photo(4), photo(5, { date: '2026-08-01' }), photo(6, { date: '2026-08-02' })],
    events: [
      event(1, { title: 'Révision annuelle', provider: 'Atelier Lyon', costCents: 12345 }),
      event(2, { title: 'Remplacement chaudière', category: 'travaux', date: '2024-02-10', costCents: 450000 }),
      event(3, { title: 'Dégât des eaux cuisine', category: 'sinistre', date: '2026-08-01' }),
      event(4, { title: 'Contrôle chaudière', date: '2026-11-15', status: 'prevu' }),
    ],
    additionalInfo: {
      commercial: { desiredSalePriceCents: 390000, salePitch: 'Modèle 2022, entretien suivi.', saleConditions: 'Paiement par virement' },
      rental: { monthlyRentCents: 115000, monthlyChargesCents: 14000, depositCents: 0, leaseType: 'NON_MEUBLE', chargesMode: 'PROVISION' },
      insurance: { insuranceObjective: 'AJOUT_OBJET', desiredInsuredAmountCents: 125000, valueToInsureCents: 125000, protections: 'Garage fermé à clé\nRack mural verrouillable' },
      claim: { claimType: 'DEGAT_DES_EAUX', occurredOn: '2026-08-01', declaredOn: '2026-08-03', insurerClaimRef: 'SIN-2026-0412', status: 'DECLARE', circumstances: 'Fuite sous l’évier.' },
      updatedAt: null,
    },
    cil: code === 'CIL' ? {
      readiness: { globalStatus: 'ready', completion: { resolvedBlocks: 5, applicableBlocks: 8, totalBlocks: 8, percentage: 62 }, blockingBlocks: [],
        blocks: ['B1', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9'].map((id) => ({ id, label: id, status: ['B1', 'B3', 'B8', 'B9'].includes(id) ? 'complete' as const : 'unknown' as const, blocking: false, missingItems: [] })) },
      profile: null, materials: [], works: [{ id: 1, category: 'chauffage', title: 'Chaudière condensation', description: null, completedAt: null, companyName: null }], resolutions: [],
    } : null,
  });
}

describe('Invariants de rendu, pour chaque dossier et chaque famille éligible', () => {
  for (const [code, family] of ALL) {
    it(`${code} · ${family}`, () => {
      const src = richSource(code, family);
      const { text, html } = render(code, src);
      // Estimation Verebona jamais imprimée.
      for (const s of ['342 000', '330 000', '355 000', 'Estimation Verebona']) expect(text, s).not.toContain(s);
      // Données d'occupant jamais imprimées.
      expect(text).not.toContain('Garnier');
      expect(text).not.toMatch(/Locataire M\./);
      // Pièces sensibles non cochées par défaut → absentes partout.
      expect(text).not.toContain('Acte de vente notarié');
      expect(text).not.toContain('RIB compte joint');
      // Identifiants en clair absents.
      for (const raw of ['UA22F0000004871', 'FW-SS58-H-25004318', 'AB-123-CD']) expect(text).not.toContain(raw);
      // Aucune valeur technique vide.
      expect(text).not.toMatch(/\b(undefined|null|NaN)\b/);
      expect(text).not.toContain('[object Object]');
      // Coûts d'entretien jamais dans le dossier de location (RULE-004).
      if (code === 'LOCATION') expect(text).not.toMatch(/123,45|4 500/);
      expect(html).toContain('Ce dossier a été préparé avec Verebona.');
    });
  }
});

describe('Champs vides masqués (PDF-TXT-002/003)', () => {
  it.each(ALL)('%s · %s : bien quasi vide, sections optionnelles absentes', (code, family) => {
    const src = makeSource(family, code, {
      asset: { ...makeSource(family, code).asset, characteristics: {}, purchasePriceCents: null, warrantyEndDate: null, purchaseDate: null, address: family === 'IMMOBILIER' ? '1 rue' : null, city: null, postalCode: null, equipmentList: [] },
      cil: code === 'CIL' ? richSource(code, family).cil : null,
    });
    const { text } = render(code, src);
    expect(text).not.toMatch(/\b(undefined|null|NaN)\b/);
    for (const t of ['Conditions de vente', 'Conditions de location', 'Mise en valeur du bien', 'Éléments de suivi', 'Photos du bien', 'Photos d’identification', 'Index des annexes intégrées', 'Garanties et contrats utiles', 'Chronologie']) {
      expect(text, t).not.toContain(t);
    }
  });
});

describe('Masquage des identifiants (design)', () => {
  it('VIN du kit de vente véhicule masqué « UA22F•••••4871 »', () => {
    expect(render('VENTE', richSource('VENTE', 'VEHICULE')).text).toContain('UA22F•••••4871');
  });
  it('numéro de série de l’assurance objet masqué « FW-SS58-H-25•••318 »', () => {
    expect(render('ASSURANCE_SOUSCRIPTION', richSource('ASSURANCE_SOUSCRIPTION', 'OBJET')).text).toContain('FW-SS58-H-25•••318');
  });
  it('immatriculation masquée hors design (lignes de famille)', () => {
    expect(render('DOSSIER_COMPLET', richSource('DOSSIER_COMPLET', 'VEHICULE')).text).toContain('AB•••CD');
  });
});

describe('Pièces sensibles et occupant (DEC-006, SEL-GEN-007)', () => {
  const src = richSource('DOSSIER_COMPLET', 'IMMOBILIER');

  it('tiroir historique : une pièce sensible cochée (pré-cochage) reste exclue', () => {
    const choices = choicesFromLegacyOptions('DOSSIER_COMPLET', src, { customDocIds: [1, 3, 4, 5] }, { outputFormat: 'PDF', today: TODAY });
    const { plan, text } = render('DOSSIER_COMPLET', src, choices);
    expect(plan.documents.map((d) => d.doc.id)).toEqual([1]);
    expect(text).not.toContain('Acte de vente notarié');
  });

  it('choix explicite de l’écran de préparation : la pièce sensible est incluse', () => {
    const parsed = parseChoicesPayload('DOSSIER_COMPLET', { outputFormat: 'PDF', sections: [{ id: 'documents', enabled: true, items: [{ sourceType: 'document', sourceId: 3, selected: true, mode: 'PDF' }] }] });
    expect(parsed.ok).toBe(true);
    const { text } = render('DOSSIER_COMPLET', src, (parsed as { ok: true; choices: ExportChoices }).choices);
    expect(text).toContain('Acte de vente notarié');
  });

  it('données d’occupant : jamais retenues, même cochées explicitement', () => {
    const parsed = parseChoicesPayload('DOSSIER_COMPLET', { items: [{ sourceType: 'document', sourceId: 5, selected: true }] });
    const { plan, text } = render('DOSSIER_COMPLET', src, (parsed as { ok: true; choices: ExportChoices }).choices);
    expect(plan.excluded).toContainEqual(expect.objectContaining({ sourceId: 5, reason: 'occupant_data' }));
    expect(text).not.toContain('Garnier');
  });

  it('classement : RIB, acte, taxe foncière sensibles ; bail, état des lieux « occupant »', () => {
    expect(classifyDocument({ id: 1, documentTypeCode: 'PROPERTY_TAX_NOTICE' }).sensitive).toBe(true);
    expect(classifyDocument({ id: 1, documentType: 'ACTE_TRANSACTION' }).sensitive).toBe(true);
    expect(classifyDocument({ id: 1, documentType: 'FACTURE', retainedTitle: 'RIB Banque Populaire' }).sensitive).toBe(true);
    expect(classifyDocument({ id: 1, documentTypeCode: 'MOVE_OUT_REPORT' }).occupantData).toBe(true);
    expect(classifyDocument({ id: 1, documentType: 'CONTRAT', retainedTitle: 'Bail meublé 2023' }).occupantData).toBe(true);
    expect(classifyDocument({ id: 1, documentType: 'FACTURE', retainedTitle: 'Facture chaudière' })).toEqual({ kind: 'FACTURE', sensitive: false, occupantData: false });
  });
});

describe('Pré-sélection par dossier (§6.2, matrice §24)', () => {
  const ids = (c: ExportChoices, t: string) => c.items.filter((i) => i.sourceType === t && i.selected).map((i) => i.sourceId).sort();

  it('vente / location : documents et suivi proposés non cochés, 4 photos au plus', () => {
    for (const code of ['VENTE', 'LOCATION'] as const) {
      const c = buildDefaultChoices(code, richSource(code, 'IMMOBILIER'), { today: TODAY });
      expect(ids(c, 'document')).toEqual([]);
      expect(ids(c, 'photo')).toEqual([1, 2, 3, 4]);
      expect(c.sections.followUp).toBe(false);
    }
  });

  it('dossier complet : factures, garanties et contrats pré-cochés ; finances décochées (RULE-002)', () => {
    const src = richSource('DOSSIER_COMPLET', 'IMMOBILIER');
    const c = buildDefaultChoices('DOSSIER_COMPLET', src, { today: TODAY });
    expect(ids(c, 'document')).toEqual([1, 6]);
    expect(c.sections.finance).toBe(false);
    expect(render('DOSSIER_COMPLET', src, c).text).not.toContain('Valeur, acquisition et informations financières');
    const withFinance = { ...c, origin: 'user' as const, sections: { ...c.sections, finance: true } };
    const r = render('DOSSIER_COMPLET', src, withFinance);
    expect(r.text).toContain('Valeur, acquisition et informations financières');
    expect(r.text).toContain('5 490 €');
  });

  it('CIL : diagnostics et plans pré-cochés, factures proposées non cochées', () => {
    const c = buildDefaultChoices('CIL', richSource('CIL', 'IMMOBILIER'), { today: TODAY });
    expect(ids(c, 'document')).toEqual([2, 8]);
    expect(ids(c, 'photo')).toEqual([]);
  });

  it('sinistre : pièces et photos liées au sinistre seulement (datées du sinistre ou après)', () => {
    const src = richSource('ASSURANCE_SINISTRE', 'IMMOBILIER');
    const c = buildDefaultChoices('ASSURANCE_SINISTRE', src, { today: TODAY });
    expect(ids(c, 'document')).toEqual([7]);
    expect(ids(c, 'photo')).toEqual([5, 6]);
    const { text } = render('ASSURANCE_SINISTRE', src, c);
    expect(text).toContain('Dégât des eaux cuisine');
    expect(text).toContain('SIN-2026-0412');
  });

  it('assurance souscription : preuves de valeur pré-cochées, entretien retenu', () => {
    const src = richSource('ASSURANCE_SOUSCRIPTION', 'OBJET');
    const c = buildDefaultChoices('ASSURANCE_SOUSCRIPTION', src, { today: TODAY });
    expect(ids(c, 'document')).toEqual([1, 6]);
    const { text } = render('ASSURANCE_SOUSCRIPTION', src, c);
    expect(text).toContain('Ajouter ce bien à un contrat existant');
    expect(text).toContain('1 250 €');
    expect(text).toContain('Facture · annexe A1');
  });

  it('prix de vente et loyer : saisies manuelles uniquement', () => {
    expect(render('VENTE', richSource('VENTE', 'VEHICULE')).text).toContain('3 900 €');
    const loc = render('LOCATION', richSource('LOCATION', 'IMMOBILIER')).text;
    expect(loc).toContain('1 150 €');
    // Dépôt à 0 € explicitement saisi : affiché (IC-GEN-008).
    expect(loc).toContain('0 €');
  });
});

describe('Modes PDF / ZIP (SEL-GEN-002/005, ALT-002)', () => {
  it('non intégrable : ZIP si archive demandée, exclu sinon', () => {
    expect(resolveMode(undefined, false, 'ZIP')).toBe('ZIP');
    expect(resolveMode(undefined, false, 'PDF')).toBeNull();
    expect(resolveMode('ZIP', true, 'PDF')).toBeNull();
    expect(resolveMode('PDF', true, 'PDF')).toBe('PDF');
  });

  it('une notice DOCX demandée en PDF est jointe au ZIP et listée « Joint au ZIP »', () => {
    const src = makeSource('IMMOBILIER', 'DOSSIER_COMPLET', { documents: [doc({ id: 9, kind: 'GARANTIE', title: 'Notice chaudière', format: 'DOCX', integrable: false, fileName: 'Notice chaudière.docx' })] });
    const parsed = parseChoicesPayload('DOSSIER_COMPLET', { outputFormat: 'ZIP', items: [{ sourceType: 'document', sourceId: 9, selected: true, mode: 'PDF' }] });
    const choices = (parsed as { ok: true; choices: ExportChoices }).choices;
    const { plan, text } = render('DOSSIER_COMPLET', src, choices);
    expect(plan.documents[0].mode).toBe('ZIP');
    expect(text).toContain('Joint au ZIP');
    expect(text).toContain('/documents/notice-chaudiere.docx');
  });

  it('fichier manquant ou illisible : exclu partout (SEL-GEN-006, ZIP-008)', () => {
    const src = richSource('DOSSIER_COMPLET', 'IMMOBILIER');
    const resolved = resolvedAllOk(src);
    resolved.documents.set(1, { id: 1, status: 'corrupted', pages: null });
    const { text } = render('DOSSIER_COMPLET', src, undefined, resolved);
    expect(text).not.toContain('Facture achat');
    expect(text).toContain('Garantie constructeur');
  });

  it('payload invalide refusé avec le chemin fautif', () => {
    const r = parseChoicesPayload('VENTE', { outputFormat: 'DOCX', items: [{ sourceType: 'x', sourceId: -1 }] });
    expect(r.ok).toBe(false);
    expect((r as { issues: Array<{ path: string }> }).issues.map((i) => i.path)).toEqual(['outputFormat', 'items[0].sourceType']);
  });
});

describe('Outils', () => {
  it('format de fichier depuis le type MIME ou l’extension', () => {
    expect(fileFormatOf('application/pdf', 'x')).toBe('PDF');
    expect(fileFormatOf(null, 'photo.JPEG')).toBe('JPG');
    expect(fileFormatOf('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a.docx')).toBe('DOCX');
  });
  it('nature d’événement', () => {
    expect(eventKind({ category: null, title: 'Révision annuelle' })).toBe('ENTRETIEN');
    expect(eventKind({ category: 'sinistre', title: 'x' })).toBe('SINISTRE');
    expect(eventKind({ category: null, title: 'Pose isolation combles' })).toBe('TRAVAUX');
  });
});
