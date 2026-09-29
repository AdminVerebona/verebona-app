/**
 * Mappeurs V12 alimentés par les listes structurées des informations
 * complémentaires (schéma v2) — rendu HTML vérifié sur le TEXTE :
 *   · sinistre : dommages (zone / élément / constat / photos), actions datées
 *     avec facture liée, échanges avec l'assureur et l'expert, sinistre de
 *     l'agenda lié (RULE-001) ; texte libre en repli ;
 *   · vente : points forts choisis (ordre, plafond de 4), repli sur les faits ;
 *   · dossier complet : valeur retenue, frais d'acquisition, charges et taxes,
 *     seulement si la section financière est cochée (RULE-002) ;
 *   · souscription : protections détaillées, accessoires et justificatifs.
 * Règles sensibles : une pièce ou une photo NON retenue n'est jamais citée,
 * pas même par sa référence (« A2 », « P3 ») ; estimation jamais imprimée.
 */
import { describe, it, expect } from 'vitest';
import { mapDossierData } from '../data/mappers';
import { buildDefaultChoices, planSelection, type ExportChoices } from '../data/choices';
import { renderDossierHtml } from '../templates';
import type { ResolvedFiles } from '../data/resolved';
import type { ExportSource, InfoSection } from '../data/source';
import type { DossierCode } from '@/services/exports/catalog';
import type {
  DossierCompletData, SinistreData, SouscriptionData, VenteData,
} from '../types';
import { makeSource, doc, photo, event, TODAY } from './fixtures/sources';

const META = { reference: 'VBN-TEST-000002', generatedAt: '2026-09-28T09:14:00+02:00', preparedBy: 'Claire Martin', templateLabel: 'test · v1.0', zipName: null, label: 'Test' };

function resolvedAllOk(source: ExportSource): ResolvedFiles {
  return {
    documents: new Map(source.documents.map((d) => [d.id, { id: d.id, status: 'ok' as const, pages: 1, localPath: `/tmp/d${d.id}` }])),
    photos: new Map(source.photos.map((p) => [p.id, { id: p.id, status: 'ok' as const, url: `file:///tmp/p${p.id}.jpg` }])),
  };
}

function render<T>(code: DossierCode, source: ExportSource, choices: ExportChoices = buildDefaultChoices(code, source, { today: TODAY })) {
  const plan = planSelection(code, source, choices, TODAY);
  const data = mapDossierData(code, { source, plan, resolved: resolvedAllOk(source), meta: META, today: TODAY }) as T;
  const html = renderDossierHtml(code, data as never, { sys: 'SYS/', asset: (f) => (f ? `file:///tmp/${f}.jpg` : null), stylesheets: [], pageMap: null }).html;
  const text = html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ');
  return { plan, data, html, text };
}

// ─── Sinistre ────────────────────────────────────────────────────────────────

function claimSource(claim: Record<string, unknown>): ExportSource {
  return makeSource('IMMOBILIER', 'ASSURANCE_SINISTRE', {
    documents: [
      doc({ id: 7, kind: 'DEVIS', title: 'Devis peinture et plâtrerie', date: '2026-08-19', supplier: 'Artisan peintre', amountCents: 284000 }),
      doc({ id: 4, kind: 'DOCUMENT_BANCAIRE', title: 'RIB compte joint', sensitive: true, date: '2026-08-05' }),
      doc({ id: 10, kind: 'ECHANGE_ASSUREUR', title: 'Accusé de réception assureur', date: '2026-08-04' }),
      doc({ id: 11, kind: 'FACTURE', title: 'Facture location déshumidificateur', date: '2026-08-22', supplier: 'Loxam Lyon', amountCents: 18600 }),
    ],
    photos: [photo(2, { date: '2026-04-21', caption: 'Plafond avant sinistre' }), photo(5, { date: '2026-08-03', caption: 'Auréoles plafond' }), photo(6, { date: '2026-08-03', caption: 'Parquet gonflé' })],
    events: [
      event(3, { title: 'Dégât des eaux salle de bain', category: 'sinistre', date: '2026-08-03', description: 'Infiltration depuis le 4e étage.' }),
      event(8, { title: 'Recherche de fuite', category: 'reparation', date: '2026-08-07', provider: 'Plomberie Bellecour' }),
    ],
    additionalInfo: { commercial: {}, rental: {}, insurance: {}, claim: claim as InfoSection, updatedAt: null },
  });
}

const STRUCTURED_CLAIM = {
  claimEventKey: 'event:3',
  // Recopiée de l'événement lié par le formulaire (pré-sélection des pièces datées).
  occurredOn: '2026-08-03',
  claimType: 'DEGAT_DES_EAUX',
  declaredOn: '2026-08-04',
  insurerClaimRef: 'SIN-2026-08-77412',
  consequences: 'Plafonds tachés sur 11 m².',
  exchangesSummary: 'Texte libre qui ne doit plus sortir',
  damages: [
    { id: 'd1', zone: 'Salle de bain', element: 'Plafond · 5 m²', finding: 'Auréoles, peinture cloquée', estimatedAmountCents: 284000, photoIds: [5, 6], documentIds: [7, 4] },
    { id: 'd2', zone: 'Chambre 2', element: 'Parquet', finding: 'Lames gonflées', photoIds: [2] },
    { id: 'd3', zone: 'Salle de bain', element: 'Luminaire' },
  ],
  actions: [
    { id: 'a1', date: '2026-08-08', endDate: '2026-08-22', title: 'Séchage', performedBy: 'Loxam Lyon', detail: 'Déshumidificateur en location', invoiceDocumentId: 11 },
    { id: 'a2', status: 'A_REALISER', title: 'Remise en état' },
    { id: 'a3', date: '2026-08-03', title: 'Mesures conservatoires', invoiceDocumentId: 4 },
  ],
  exchanges: [
    { id: 'x2', date: '2026-08-18', direction: 'RECU', party: 'EXPERT', channel: 'COURRIER', summary: "Convocation à l'expertise du 26/08" },
    { id: 'x1', date: '2026-08-04', direction: 'RECU', party: 'ASSUREUR', channel: 'EMAIL', summary: 'Accusé de réception de la déclaration', documentId: 10 },
  ],
};

describe('ASSURANCE_SINISTRE · listes structurées', () => {
  const { data, text, plan } = render<SinistreData>('ASSURANCE_SINISTRE', claimSource(STRUCTURED_CLAIM));

  it('pré-sélection inchangée : pièces liées au sinistre, RIB sensible non retenu, photos du sinistre', () => {
    expect(plan.documents.map((d) => d.doc.id).sort()).toEqual([10, 11, 7]);
    expect(plan.photos.filter((p) => p.mode === 'PDF').map((p) => p.photo.id)).toEqual([5, 6]);
  });

  it('dommages : zone, élément, constat, montant estimé saisi, photos P1–P2 retenues seulement', () => {
    expect(data.damages!.map((d) => d.zone)).toEqual(['Salle de bain', 'Chambre 2', 'Salle de bain']);
    expect(data.damages![0]).toMatchObject({ photoRefs: 'P1, P2', docIds: ['d7'] });
    expect(data.damages![0].finding!.replace(/[\u00a0\u202f]/g, ' ')).toBe('Auréoles, peinture cloquée · Montant estimé : 2 840 €');
    // Photo « avant » non retenue et pièce sensible non cochée : jamais citées.
    expect(data.damages![1].photoRefs).toBeNull();
    expect(data.damages![0].docIds).not.toContain('d4');
    expect(text).toContain('Dommages et éléments concernés');
    expect(text).toContain('Photos · pièces');
    expect(text).toMatch(/P1, P2 · A\d/);
    // Note de couverture recalculée : 2 zones distinctes (PDF-TXT-001).
    expect(text).toContain('2 zones endommagées');
  });

  it('actions : période, « Non réalisé », intervenant, facture renvoyée vers son annexe ; pièce sensible jamais citée', () => {
    expect(data.actions!.map((a) => [a.title, a.whenLabel ?? a.date])).toEqual([
      ['Séchage', '08/08 → 22/08/2026'], ['Remise en état', 'Non réalisé'], ['Mesures conservatoires', '2026-08-03'],
    ]);
    expect(data.actions![0].text).toBe('Déshumidificateur en location · Intervenant : Loxam Lyon');
    expect(data.actions![0].docId).toBe('d11');
    expect(data.actions![2].docId).toBeNull();
    expect(text).toMatch(/Intervenant : Loxam Lyon · facture · annexe A\d/);
    // Synthèse : les mesures en texte libre ne sont pas masquées par la liste (design : les deux).
    expect(data.claim!.measures).toBeNull(); // non saisies ici
  });

  it('échanges : triés par date, interlocuteur et canal, pièce citée une seule fois ; texte libre ignoré', () => {
    expect(data.exchanges!.map((x) => [x.date, x.title, x.channel])).toEqual([
      ['2026-08-04', 'Accusé de réception de la déclaration', 'Assureur · E-mail reçu'],
      ['2026-08-18', "Convocation à l'expertise du 26/08", 'Expert · Courrier reçu'],
    ]);
    expect(data.exchanges!.every((x) => x.linkedToClaim)).toBe(true);
    expect(text).not.toContain('Texte libre qui ne doit plus sortir');
    expect(text).not.toContain('Accusé de réception assureur Courrier'); // pas de doublon « correspondance »
  });

  it('RULE-001 : sinistre de l’agenda lié — date, circonstances, pastille rouge, sans entrée en double', () => {
    expect(data.claim).toMatchObject({ date: '2026-08-03', circumstances: 'Infiltration depuis le 4e étage.', typeLabel: 'Dégât des eaux' });
    const keyed = data.timeline!.filter((t) => t.tone === 'key');
    expect(keyed.map((t) => t.id)).toEqual(['event:3']);
    expect(data.timeline!.map((t) => t.id)).not.toContain('claim');
    expect(data.timeline!.map((t) => t.date)).toEqual([...data.timeline!.map((t) => t.date)].sort());
  });

  it('règles sensibles et vides', () => {
    expect(text).not.toContain('RIB compte joint');
    expect(text).not.toMatch(/\b(undefined|null|NaN)\b/);
    expect(text).not.toContain('Estimation Verebona');
  });

  it('section « dommages » décochée : tableau absent', () => {
    const src = claimSource(STRUCTURED_CLAIM);
    const c = buildDefaultChoices('ASSURANCE_SINISTRE', src, { today: TODAY });
    const r = render<SinistreData>('ASSURANCE_SINISTRE', src, { ...c, origin: 'user', sections: { ...c.sections, damages: false } });
    expect(r.data.damages).toEqual([]);
    expect(r.text).not.toContain('Dommages et éléments concernés');
  });

  it('repli sans listes : mesures ligne à ligne en cartes, résumé des échanges, aucun dommage inventé', () => {
    const r = render<SinistreData>('ASSURANCE_SINISTRE', claimSource({
      claimType: 'DEGAT_DES_EAUX', occurredOn: '2026-08-03', consequences: 'Plafonds tachés.',
      measures: 'Coupure électrique\nBâchage', exchangesSummary: 'Relance du 15/09',
    }));
    expect(r.data.damages).toEqual([]);
    expect(r.data.actions!.map((a) => a.title)).toEqual(['Coupure électrique', 'Bâchage']);
    expect(r.data.claim!.measures).toBeNull();
    expect(r.text).toContain('Relance du 15/09');
    expect(r.text).not.toContain('Dommages et éléments concernés');
    // Sans lien : entrée « sinistre » saisie temporairement (RULE-002).
    expect(r.data.timeline!.find((t) => t.tone === 'key')?.title).toBe('Sinistre : dégât des eaux');
  });

  it('événement lié sans date saisie : la date du sinistre vient de l’agenda', () => {
    const { occurredOn: _o, ...noDate } = STRUCTURED_CLAIM;
    void _o;
    const r = render<SinistreData>('ASSURANCE_SINISTRE', claimSource(noDate));
    expect(r.data.claim!.date).toBe('2026-08-03');
    expect(r.text).toContain('Sinistre survenu le 03/08/2026');
  });

  it('pièce liée supprimée depuis (absente de la source) : ignorée sans erreur', () => {
    const r = render<SinistreData>('ASSURANCE_SINISTRE', claimSource({ ...STRUCTURED_CLAIM, damages: [{ id: 'd', zone: 'Cuisine', photoIds: [999], documentIds: [998] }] }));
    expect(r.data.damages![0]).toMatchObject({ zone: 'Cuisine', photoRefs: null, docIds: [] });
  });
});

// ─── Vente ───────────────────────────────────────────────────────────────────

function saleSource(commercial: Record<string, unknown>): ExportSource {
  return makeSource('VEHICULE', 'VENTE', {
    documents: [doc({ id: 1, kind: 'FACTURE', title: 'Facture achat' })],
    events: [event(1, { title: 'Révision complète', provider: 'Cyclable Lyon', date: '2025-07-03' })],
    additionalInfo: { commercial: commercial as InfoSection, rental: {}, insurance: {}, claim: {}, updatedAt: null },
  });
}

describe('VENTE · points forts choisis', () => {
  it('ordre de l’utilisateur, 4 au plus, précision facultative', () => {
    const chosen = [
      { id: 'h4', title: 'Stationnement abrité', text: 'Garage fermé depuis l’achat.' },
      { id: 'h1', title: 'Entretien en atelier agréé', origin: 'suggestion:maintenance' },
      { id: 'h2', title: 'Pièces d’usure récentes', text: 'Plaquettes et chaîne remplacées le 03/07/2025.' },
      { id: 'h3', title: 'Batterie d’origine' },
      { id: 'h5', title: 'Cinquième, jamais affiché' },
    ];
    const { data, text } = render<VenteData>('VENTE', saleSource({ highlights: chosen, desiredSalePriceCents: 390000 }));
    expect(data.highlights!.map((h) => h.title)).toEqual(['Stationnement abrité', 'Entretien en atelier agréé', 'Pièces d’usure récentes', 'Batterie d’origine']);
    expect(data.highlights![1].text).toBeNull();
    expect(text).toContain('Mise en valeur du bien');
    expect(text).not.toContain('Cinquième');
    expect(text).not.toContain('suggestion:maintenance');
  });

  it('aucun choix : repli sur les faits documentés (comportement historique)', () => {
    const { data } = render<VenteData>('VENTE', saleSource({}));
    expect(data.highlights!.map((h) => h.id)).toEqual(['h-maintenance', 'h-warranty', 'h-invoices']);
  });

  it('section décochée : aucun point fort', () => {
    const src = saleSource({ highlights: [{ id: 'h', title: 'X' }] });
    const c = buildDefaultChoices('VENTE', src, { today: TODAY });
    expect(render<VenteData>('VENTE', src, { ...c, origin: 'user', sections: { ...c.sections, highlights: false } }).data.highlights).toEqual([]);
  });
});

// ─── Dossier complet ─────────────────────────────────────────────────────────

const FINANCE: Record<string, unknown> = {
  retainedValueCents: 33500000, retainedValueSource: 'SAISIE', retainedValueDate: '2026-06-01', acquisitionFeesCents: 2340000,
  charges: [
    { id: 'c1', kind: 'COPROPRIETE', amountCents: 216000, period: 'AN' },
    { id: 'c2', kind: 'TAXE_FONCIERE', amountCents: 128500, year: 2025 },
    { id: 'c3', kind: 'AUTRE', label: 'Contrat entretien chaudière', amountCents: 1240, period: 'MOIS' },
  ],
};

describe('DOSSIER_COMPLET · valeur retenue, charges et taxes', () => {
  const src = makeSource('IMMOBILIER', 'DOSSIER_COMPLET', {
    additionalInfo: { commercial: {}, rental: {}, insurance: {}, claim: {}, finance: FINANCE as InfoSection, updatedAt: null },
  });
  const choices = buildDefaultChoices('DOSSIER_COMPLET', src, { today: TODAY });

  it('RULE-002 : section financière non cochée par défaut → rien de tout cela', () => {
    const { text } = render<DossierCompletData>('DOSSIER_COMPLET', src, choices);
    for (const t of ['Valeur retenue', '335 000', 'Charges et taxes', 'Taxe foncière', "Frais d'acquisition"]) expect(text, t).not.toContain(t);
  });

  it('section cochée : valeur retenue avec origine et date, frais, charges avec périodicité', () => {
    const { data, text } = render<DossierCompletData>('DOSSIER_COMPLET', src, { ...choices, origin: 'user', sections: { ...choices.sections, finance: true } });
    expect(data.finance!.retainedValue).toEqual({ amountCents: 33500000, sourceLabel: 'Saisie utilisateur', date: '2026-06-01' });
    expect(data.finance!.lines!.map((l) => l.label)).toEqual(["Prix d'achat", "Frais d'acquisition"]);
    expect(data.finance!.charges).toEqual([
      { label: 'Charges de copropriété', amountCents: 216000, period: 'an' },
      { label: 'Taxe foncière (2025)', amountCents: 128500, period: 'an' },
      { label: 'Contrat entretien chaudière', amountCents: 1240, period: 'mois' },
    ]);
    expect(text).toContain('Valeur retenue');
    expect(text).toContain('335 000 €');
    expect(text).toContain('Saisie utilisateur · 01/06/2026');
    expect(text).toContain('Charges et taxes déclarées');
    expect(text).toContain('2 160 € / an');
    expect(text).toContain('12,40 € / mois');
    expect(text).not.toContain('Estimation Verebona');
  });

  it('snapshot antérieur à la migration 0214 (sans `finance`) : section sans valeur retenue ni charges', () => {
    const old = makeSource('IMMOBILIER', 'DOSSIER_COMPLET');
    const { data } = render<DossierCompletData>('DOSSIER_COMPLET', old, { ...choices, origin: 'user', sections: { ...choices.sections, finance: true } });
    expect(data.finance!.retainedValue).toBeUndefined();
    expect(data.finance!.charges).toEqual([]);
  });
});

// ─── Souscription ────────────────────────────────────────────────────────────

describe('ASSURANCE_SOUSCRIPTION · protections détaillées et éléments à assurer', () => {
  const src = makeSource('OBJET', 'ASSURANCE_SOUSCRIPTION', {
    documents: [
      doc({ id: 1, kind: 'FACTURE', title: 'Facture achat planche' }),
      doc({ id: 2, kind: 'FACTURE', title: 'Facture dérives', date: '2025-04-02' }),
      doc({ id: 3, kind: 'DOCUMENT_BANCAIRE', title: 'Relevé bancaire', sensitive: true }),
    ],
    additionalInfo: {
      commercial: {}, rental: {}, claim: {}, updatedAt: null,
      insurance: {
        insuranceObjective: 'AJOUT_OBJET', protections: 'Texte libre remplacé',
        protectionItems: [
          { id: 'p1', title: 'Garage fermé à clé', text: 'Porte motorisée · accès résidents uniquement' },
          { id: 'p2', title: 'Housse rembourrée' },
        ],
        insuredItems: [
          { id: 'i1', label: 'Dérives FCS II', valueCents: 10900, documentId: 2 },
          { id: 'i2', label: 'Housse 6\'0', valueCents: 5100 },
          { id: 'i3', label: 'Leash', valueCents: 5900, documentId: 3 },
        ],
      },
    },
  });
  const { data, text } = render<SouscriptionData>('ASSURANCE_SOUSCRIPTION', src);

  it('protections : titre et précision, texte libre en repli seulement', () => {
    expect(data.protections!.map((p) => [p.title, p.text])).toEqual([
      ['Garage fermé à clé', 'Porte motorisée · accès résidents uniquement'], ['Housse rembourrée', null],
    ]);
    expect(text).toContain('Équipements et protections');
    expect(text).not.toContain('Texte libre remplacé');
  });

  it('accessoires : valeur déclarée, facture citée si retenue, sinon déclaratif (pièce sensible jamais citée)', () => {
    const acc = data.items!.filter((i) => i.kind === 'accessory');
    expect(acc.map((i) => [i.label, i.valueCents, i.docId, i.proofLabel])).toEqual([
      ['Dérives FCS II', 10900, 'd2', 'Facture'],
      ["Housse 6'0", 5100, null, 'Déclaratif · sans facture'],
      ['Leash', 5900, null, 'Déclaratif · sans facture'],
    ]);
    expect(data.insurance!.accessoriesLabel).toBe('3 éléments déclarés');
    expect(text).toContain('219 €'); // 109 + 51 + 59
    expect(text).toMatch(/Facture · annexe A\d/);
    expect(text).not.toContain('Relevé bancaire');
  });
});
