/**
 * Lot 44 — O5, rubrique « Sinistres » de la fiche bien : rendus desktop ET
 * mobile (mêmes composants, mise en page responsive — une colonne sur mobile,
 * grille sur bureau). Aucun terme technique (P09).
 *
 * O5-UI-01 liste : plusieurs sinistres par bien, multi-biens, clôture,
 *          provenance documentaire, ajout, ancienne saisie à reprendre (Q11)
 * O5-UI-02 formulaire : champs de l'ancien formulaire, biens concernés,
 *          événement de l'agenda, coûts brut / indemnité / net (Q4)
 * O5-UI-03 droits (Q3) : rubrique ouverte à toutes les offres ; la
 *          Préparation des dossiers (Premium) n'a plus de sous-rubrique
 *          Sinistre ; l'export choisit le sinistre
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

(globalThis as { React?: typeof React }).React = React;

const { ClaimsListView, ClaimFormView } = await import('../ClaimViews');
const lire = (p: string) => readFileSync(resolve(__dirname, '..', '..', '..', '..', p), 'utf8').replace(/\r\n?/g, '\n');
const txt = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

const CLAIMS = [
  { id: 2, label: 'Dégât des eaux · 12/03/2026', claimType: 'DEGAT_DES_EAUX', occurredOn: '2026-03-12', status: 'EN_ATTENTE_INDEMNISATION', insurerClaimRef: 'SIN-88', estimatedDamageCents: 350000, compensationCents: null, otherAssets: [{ id: 9, name: 'Garage' }], documented: true, closed: false },
  { id: 1, label: 'Vol ou cambriolage · 01/02/2025', claimType: 'VOL', occurredOn: '2025-02-01', status: 'CLOS', insurerClaimRef: null, estimatedDamageCents: null, compensationCents: 120000, otherAssets: [], documented: false, closed: true },
];
const noop = () => undefined;

function liste(over: Partial<Parameters<typeof ClaimsListView>[0]> = {}) {
  return renderToStaticMarkup(h(ClaimsListView, { claims: CLAIMS, legacy: null, readOnly: false, onAdd: noop, onOpen: noop, onResumeLegacy: noop, ...over }));
}

function formulaire(over: Partial<Parameters<typeof ClaimFormView>[0]> = {}) {
  return renderToStaticMarkup(h(ClaimFormView, {
    claimId: 2, idPrefix: 'claim-2', family: 'IMMOBILIER', title: 'Dégât des eaux · 12/03/2026',
    inputs: { 'claim.claimType': 'DEGAT_DES_EAUX', 'claim.occurredOn': '2026-03-12', 'claim.compensationCents': '1 200' },
    errors: {}, lists: { 'claim.damages': [{ id: 'r1', zone: 'Cuisine', element: 'Plafond' }] }, listLocalErrors: {},
    references: { documents: [], photos: [], claimEvents: [{ key: 'agenda:4', title: 'Dégât des eaux', date: '2026-03-12', source: 'agenda' }], highlightSuggestions: [] },
    readOnly: false, saveState: 'saved', notice: null,
    assetOptions: [{ id: 7, name: 'Maison' }, { id: 9, name: 'Garage' }], assetIds: [7, 9], currentAssetId: 7,
    costs: { grossCents: 200000, indemnityCents: 120000, netCents: 80000 }, contractLabel: 'MAAF · n° AU-778', documented: true,
    onBack: noop, onChange: noop, onBlur: noop, onListChange: noop, onEventChange: noop, onToggleAsset: noop, onRetry: noop, onDismissNotice: noop, onDelete: noop,
    ...over,
  }));
}

describe('O5-UI-01 liste des sinistres du bien (desktop et mobile)', () => {
  it('plusieurs sinistres, statut du dossier, référence, montants, multi-biens, clôture, documents', () => {
    const t = txt(liste());
    expect(t).toContain('Dégât des eaux · 12/03/2026');
    expect(t).toContain('En attente d\'indemnisation · Réf. SIN-88 · Estimé 3');
    expect(t).toContain('Concerne aussi : Garage');
    expect(t).toContain('Vol ou cambriolage · 01/02/2025');
    expect(t).toContain('Indemnité 1');
    expect(t).toContain('Clos');
    expect(t).toContain('Documents');
    expect(t).toContain('Ajouter un sinistre');
    expect(t).not.toMatch(/Op[ée]ration/);
  });
  it('lecture seule : pas d\'ajout ; liste vide : invitation', () => {
    expect(txt(liste({ readOnly: true }))).not.toContain('Ajouter un sinistre');
    expect(txt(liste({ claims: [] }))).toContain('Aucun sinistre enregistré pour ce bien');
  });
  it('ancienne saisie non reprise (Q11) : lisible, « Reprendre en sinistre »', () => {
    const t = txt(liste({ claims: [], legacy: { claim: { circumstances: 'Rayure' }, label: 'Sinistre sans date', reason: 'BELOW_THRESHOLD' } }));
    expect(t).toContain('Saisie précédente : Sinistre sans date.');
    expect(t).toContain('Reprendre en sinistre');
  });
  it('mobile : lignes pleine largeur, textes à la ligne (tronqués sur bureau), bouton d\'ajout pleine largeur (sm:w-auto au-delà)', () => {
    const html = liste();
    expect(html).toContain('w-full flex items-start gap-3');
    expect(html).toContain('break-words sm:truncate');
    expect(html).toContain('w-full sm:w-auto');
  });
});

describe('O5-UI-02 formulaire d\'un sinistre (champs existants, biens concernés, montants)', () => {
  it('tous les champs de l\'ancien formulaire, sans le mot « Opération »', () => {
    const t = txt(formulaire());
    for (const label of ['Événement sinistre de l\'agenda', 'Type de sinistre', 'Date du sinistre', 'Date de déclaration à l\'assureur',
      'Référence du dossier sinistre', 'Contrat concerné', 'Avancement', 'Précision sur l\'avancement', 'Circonstances',
      'Dommages constatés (synthèse)', 'Mesures conservatoires (synthèse)', 'Montant estimé des dommages', 'Indemnité reçue',
      'Dommages et éléments concernés', 'Actions et mesures', 'Échanges avec l\'assureur et l\'expert']) {
      expect(t, label).toContain(label);
    }
    expect(t).not.toMatch(/Op[ée]ration/);
  });
  it('biens concernés (un sinistre peut concerner plusieurs biens), contrat reconnu, coûts brut / indemnité / net', () => {
    const t = txt(formulaire());
    expect(t).toContain('Biens concernés');
    expect(t).toContain('Maison');
    expect(t).toContain('Garage');
    expect(t).toContain('Contrat reconnu : MAAF · n° AU-778.');
    expect(t).toContain('Coût des réparations 2');
    expect(t).toContain('Reste à votre charge 800');
    expect(t).toContain('Supprimer ce sinistre');
    expect(t).toContain('Enregistré');
  });
  it('desktop : grille 2 / 3 colonnes ; mobile : une colonne ; variante intégrée (dossier) : une colonne', () => {
    expect(formulaire()).toContain('grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3');
    expect(formulaire()).toContain('grid-cols-1 sm:grid-cols-3');
    const compact = formulaire({ compact: true });
    expect(compact).not.toContain('sm:grid-cols-2 lg:grid-cols-3');
    expect(txt(compact)).not.toContain('Retour à la liste');
  });
  it('lecture seule : champs désactivés, ni suppression', () => {
    const html = formulaire({ readOnly: true });
    expect(html).toMatch(/<fieldset disabled=""/);
    expect(txt(html)).not.toContain('Supprimer ce sinistre');
  });
});

describe('O5-UI-03 droits (Q3) et intégration', () => {
  it('fiche bien : rubrique Sinistres pour toutes les offres (aucun droit Premium), avant la Préparation des dossiers', () => {
    const tab = lire('components/assets/AssetDetailsTab.tsx');
    expect(tab).toMatch(/<AssetClaimsSection\s+assetId=\{asset\.id\}/);
    expect(tab.indexOf('<AssetClaimsSection')).toBeLessThan(tab.indexOf('<AssetAdditionalInfosSection'));
    const section = lire('components/assets/claims/AssetClaimsSection.tsx') + lire('components/assets/claims/ClaimEditor.tsx');
    expect(section).not.toMatch(/canCreateDossiers|dossier-rights|PREMIUM_REQUIRED/);
    const route = lire('services/business-operations/claims/claim-route.ts');
    expect(route).not.toMatch(/canCreateDossiers\(/);
  });
  it('Préparation des dossiers (Premium) : plus de sous-rubrique Sinistre', () => {
    const prep = lire('components/assets/AssetAdditionalInfosSection.tsx');
    expect(prep).toMatch(/sectionsForCategory\(category\)\.filter\(\(s\) => s !== 'claim'\)/);
    expect(prep).not.toMatch(/renderClaimEvent/);
  });
  it('écran de préparation du dossier Assurance-sinistre : choix du sinistre et formulaire intégré', () => {
    const ecran = lire('components/exports/preparation/ExportPreparationScreen.tsx');
    expect(ecran).toMatch(/s\.infoSections\.includes\('claim'\) && prep\.claim \? \(\s*<ClaimExportPanel/);
    const panel = lire('components/exports/preparation/ClaimExportPanel.tsx');
    expect(panel).toContain('Sinistre du dossier');
    expect(panel).toMatch(/<ClaimEditor[\s\S]*compact/);
    expect(lire('lib/exports/preparation-state.ts')).toMatch(/claimOperationId: s\.prep\.claim\.selectedOperationId/);
  });
});
