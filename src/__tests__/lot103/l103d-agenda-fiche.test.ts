/**
 * Lot 103D — fiche Agenda (retours de recette iOS du 31/10) : trois tickets.
 *
 *   L103D-U-HOUSING-SCOPE      Pièces / Équipements seulement pour un logement rattaché (règle pure, vues, API, IA)
 *   L103D-U-STATUT-HISTORIQUE  #715 (lot 113P) : REMPLACÉ — plus de statut ni de sélecteur « Statut » dans le tiroir
 *   L103D-U-RAPPELS            bloc « Rappels sur l'accueil » : seulement un rappel effectif, formulation concrète
 *   L103D-U-WORDING            libellés des associations (« Associations », « Associer à un autre événement »…)
 *   L103D-U-COH                deux contrôles ajoutés EN FIN de registre, couverts, jamais destructeurs
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgendaGroupingView } from '@/lib/agenda/grouping-view';
import {
  AGENDA_HOUSING_REMOVAL_HAS_DEPENDENTS, AGENDA_STRUCTURAL_LINK_INCOMPATIBLE, HOUSING_SCOPE_LABELS,
  agendaHousingAssetIds, agendaShowsRoomsAndEquipments, incompatibleStructuralLinks, isAgendaHousingAsset, restrictToHousing,
} from '@/lib/agenda/housing-scope';
import { agendaReminderRelevance, REMINDER_BLOCK_LABELS } from '@/lib/agenda/reminder-relevance';
import { GROUPING_LABELS, groupingActionToast } from '@/lib/agenda/grouping-view';

(globalThis as { React?: typeof React }).React = React;

const ROOT = resolve(__dirname, '..', '..', '..');
const lire = (p: string) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n?/g, '\n');

const POLO = { id: 1, category: 'VEHICULE', subtype: 'Voiture' };
const MAISON_A = { id: 2, category: 'IMMOBILIER', subtype: 'Maison' };
const APPART_B = { id: 3, category: 'IMMOBILIER', subtype: 'Appartement' };
const MAISON_C = { id: 4, category: 'IMMOBILIER', subtype: 'Maison' };
const PIECES = [{ id: 20, assetId: 2 }, { id: 30, assetId: 3 }, { id: 40, assetId: 4 }];
const EQUIPEMENTS = [{ id: 21, assetId: 2 }, { id: 31, assetId: 3 }, { id: 11, assetId: 1 }];

describe('L103D-U-HOUSING-SCOPE — règle unique « logement rattaché »', () => {
  it('Polo seul ou aucun bien : rubriques Pièces / Équipements absentes', () => {
    expect(isAgendaHousingAsset(POLO)).toBe(false);
    expect(agendaShowsRoomsAndEquipments([POLO])).toBe(false);
    expect(agendaShowsRoomsAndEquipments([])).toBe(false);
  });
  it('Maison A : seulement les pièces et équipements de A (jamais ceux de la Maison C du compte)', () => {
    const logements = agendaHousingAssetIds([MAISON_A]);
    expect(logements).toEqual([2]);
    expect(logements).not.toContain(MAISON_C.id);
    expect(restrictToHousing(PIECES, logements).map((p) => p.id)).toEqual([20]);
    expect(restrictToHousing(EQUIPEMENTS, logements).map((p) => p.id)).toEqual([21]);
  });
  it('Polo + Maison A : uniquement Maison A ; Maison A + Appartement B : A et B', () => {
    expect(agendaHousingAssetIds([POLO, MAISON_A])).toEqual([2]);
    expect(restrictToHousing(PIECES, agendaHousingAssetIds([MAISON_A, APPART_B])).map((p) => p.id)).toEqual([20, 30]);
  });
  it('incompatibilités : bien porteur non rattaché ou non logement ; jamais un logement ajouté implicitement', () => {
    const ko = incompatibleStructuralLinks(agendaHousingAssetIds([POLO, MAISON_A]), PIECES, EQUIPEMENTS);
    expect(ko).toEqual({ roomIds: [30, 40], equipmentIds: [31, 11] });
    expect(incompatibleStructuralLinks([], PIECES, []).roomIds).toEqual([20, 30, 40]);
  });
  it('audit (avant 103D) : le contrôle de cohérence historique des liens ne vérifie rien quand aucun bien n’est choisi', async () => {
    // Cause démontrée de l'acceptation par l'API : `validateLinkCoherence` (inchangée) ne contrôle les pièces
    // que si des biens sont sélectionnés — une pièce de n'importe quel logement du compte passait sans bien.
    const { validateLinkCoherence } = await import('@/services/agenda/AgendaDomainService');
    expect(validateLinkCoherence([], [], [{ id: 20, resolvedAssetId: 2 }], [{ id: 21, resolvedAssetId: 2 }])).toEqual([]);
  });
  it('codes stables et message de confirmation (liens seulement, rien n’est supprimé)', () => {
    expect(AGENDA_STRUCTURAL_LINK_INCOMPATIBLE).toBe('AGENDA_STRUCTURAL_LINK_INCOMPATIBLE');
    expect(AGENDA_HOUSING_REMOVAL_HAS_DEPENDENTS).toBe('AGENDA_HOUSING_REMOVAL_HAS_DEPENDENTS');
    expect(HOUSING_SCOPE_LABELS.confirmBody(2, 1)).toMatch(/2 pièces et 1 équipement.*restent dans Verebona/);
    expect(JSON.stringify(HOUSING_SCOPE_LABELS)).not.toMatch(/Opération|élément de l’agenda/);
  });

  it('tiroir de l’événement de référence : aucune catégorie Pièces / Équipements sans logement (ni titre, ni « Aucun », ni bouton)', async () => {
    const { AgendaGroupingPanel, visibleMainCategories } = await import('@/components/agenda/AgendaGroupingPanel');
    const rien = () => undefined;
    const vue = (allowed: boolean): AgendaGroupingView => ({
      itemId: 1, role: 'MAIN', linkedDocuments: [], main: null, mainWithdrawn: false, counts: null,
      ensemble: { items: [], documents: [], assets: [{ id: 1, name: 'Polo' }], rooms: [], equipments: [] },
      structuralScope: { allowed, housingAssetIds: allowed ? [2] : [] },
    });
    const sans = renderToStaticMarkup(h(AgendaGroupingPanel, { view: vue(false), onAction: rien, onPick: rien, onRelease: rien, onOpenMain: rien }));
    for (const t of ['Pièces', 'Équipements', 'Aucune pièce', 'Aucun équipement', 'Relier une pièce', 'Relier un équipement', 'regroupement-relier-pieces', 'regroupement-categorie-equipements']) {
      expect(sans).not.toContain(t);
    }
    expect(sans).toContain('Biens (1)');
    const avec = renderToStaticMarkup(h(AgendaGroupingPanel, { view: vue(true), onAction: rien, onPick: rien, onRelease: rien, onOpenMain: rien }));
    for (const t of ['Pièces', 'Équipements', 'Relier une pièce', 'Relier un équipement']) expect(avec).toContain(t);
    // Vue d'un serveur antérieur (champ absent) : prudence, aucune des deux catégories.
    expect(visibleMainCategories({})).toEqual(['elements', 'documents', 'biens']);
  });

  it('tiroir Agenda (desktop et mobile) : règle unique, plus de liste « tous les biens » sans logement, confirmation de dissociation', () => {
    const src = lire('src/components/agenda/AgendaItemDrawer.tsx');
    expect(src).not.toContain('allImmoAssets');
    expect(src).toContain('const showStructural = selectedImmoAssets.length > 0;');
    expect(src).toContain('agendaHousingAssetIds(item.assetLinks');
    expect(src).toContain('viewRooms.length > 0');
    expect(src).toContain('AGENDA_HOUSING_REMOVAL_HAS_DEPENDENTS');
    expect(src).toContain('data-testid="agenda-dissociation-logement"');
    // Plus de filtrage silencieux de la sélection au changement de biens.
    expect(src).not.toMatch(/Clear structural selection when asset selection changes/);
    const creation = lire('src/components/agenda/CreateAgendaItemDrawer.tsx');
    expect(creation).toContain('substructureIds: showStructural ? selectedSubstructureIds : []');
  });

  it('serveur : garde dans la transaction pour tous les appelants (refus manuel, filtre IA), routes à code stable', () => {
    const w = lire('src/services/agenda/write-agenda-item.ts');
    expect(w).toContain('links = await enforceHousingScope(tx, agendaItemId, links, mode, accountId, channel);');
    expect(w).toMatch(/if \(channel === 'MANUAL'\) \{[\s\S]*throw new AgendaStructuralLinkError/);
    const svc = lire('src/services/business-operations/grouping/service.ts');
    expect(svc.match(/guardStructuralTarget\(ctx, p\.operationId, p\.origin/g)?.length).toBe(2);
    expect(lire('src/services/business-operations/consolidation/consolidator.ts')).toContain('structuralTargetAllowedFor(drizzleRunner(tx), repo.accountId, opId');
    expect(lire('src/services/equipment/equipment-auto-link.service.ts')).toContain('structuralLinkAllowedForItem(drizzleRunner(db), accountId, agendaId, { equipmentId })');
    for (const r of ['src/app/api/agenda/route.ts', 'src/app/api/agenda/[id]/route.ts']) expect(lire(r)).toContain('structuralLinkRefusal(err)');
    expect(lire('src/app/api/agenda/[id]/liens/route.ts')).toContain('AGENDA_HOUSING_REMOVAL_HAS_DEPENDENTS');
    expect(lire('src/services/business-operations/grouping/read.ts')).toMatch(/s\.asset_id = ANY\(\$5::int\[\]\)/);
  });
});

describe('L103D-U-STATUT-HISTORIQUE — #715 : plus de statut d’événement (remplace la règle « Réalisé sur preuve »)', () => {
  it('tiroir Agenda : ni sélecteur « Statut », ni option « Selon la date » / « Réalisé » / « Annulé » ; module de statut supprimé', () => {
    const src = lire('src/components/agenda/AgendaItemDrawer.tsx');
    expect(src).not.toMatch(/<SelectItem value="(null|realise|annule)">/);
    expect(src).not.toMatch(/automaticStatusOptionLabel|EFFECTIVE_STATUS_LABELS|\/statut`/);
    expect(() => lire('src/lib/agenda/effective-status.ts')).toThrow();
    expect(() => lire('src/services/agenda/historical-completion.ts')).toThrow();
  });
});

describe('L103D-U-RAPPELS — bloc « Rappels sur l’accueil » : rappel effectif seulement', () => {
  const base = { historical: false, dueDate: '2026-12-15', today: '2026-10-31', hasPreference: false, assessment: null };
  // #715 : plus de « sujet clos » par statut ; une date PASSÉE ne crée jamais de rappel.
  it('fait historique, date passée, aucune décision T6, décision « aucune interpellation » : aucun bloc', () => {
    expect(agendaReminderRelevance({ ...base, historical: true, assessment: { interpellation: 'ACT_NOW', action: null, actionDate: null } }).visible).toBe(false);
    expect(agendaReminderRelevance({ ...base, dueDate: '2026-10-01', assessment: { interpellation: 'ACT_NOW', action: null, actionDate: null } })).toMatchObject({ visible: false, reason: 'PAST_DATE' });
    expect(agendaReminderRelevance(base)).toMatchObject({ visible: false, reason: 'NO_REMINDER' });
    expect(agendaReminderRelevance({ ...base, assessment: { interpellation: 'NONE', action: null, actionDate: null } }).visible).toBe(false);
  });
  it('rappel T6 existant ou préférence enregistrée : bloc avec action et date utile', () => {
    expect(agendaReminderRelevance({ ...base, assessment: { interpellation: 'ANTICIPATE', action: 'Prendre rendez-vous pour le ramonage', actionDate: '2026-11-20' } }))
      .toEqual({ visible: true, reason: 'T6_REMINDER', action: 'Prendre rendez-vous pour le ramonage', actionDate: '2026-11-20' });
    expect(agendaReminderRelevance({ ...base, hasPreference: true })).toMatchObject({ visible: true, reason: 'USER_PREFERENCE', actionDate: '2026-12-15' });
  });
  it('formulation : plus de phrase générique, actions à portée explicite', () => {
    const src = lire('src/components/home/T6ReminderControls.tsx');
    expect(src).not.toMatch(/return 'Actifs : Verebona vous sollicite/);
    expect(src).toContain("if (!state || state.relevance?.visible === false) return null;");
    expect(REMINDER_BLOCK_LABELS.snooze).toBe('Reporter ce rappel');
    expect(REMINDER_BLOCK_LABELS.dismiss).toBe('Ne plus rappeler cette échéance');
    expect(REMINDER_BLOCK_LABELS.scope).toMatch(/uniquement cette échéance/);
    // L'accueil (menu « Rappels ») n'est pas modifié : aucune remontée nouvelle.
    expect(src).toContain('<BellRing aria-hidden /> Me le rappeler plus tard');
    expect(lire('src/services/home/mascot/t6-reminders.service.ts')).toContain('relevance,');
  });
});

describe('L103D-U-WORDING — associations Agenda', () => {
  it('libellés validés par le PO (31/10), centralisés', () => {
    expect(GROUPING_LABELS.sectionAlone).toBe('Associations');
    expect(GROUPING_LABELS.add.elements).toBe('Associer à un autre événement');
    expect(GROUPING_LABELS.linkedDocuments).toBe('Documents associés');
    expect(GROUPING_LABELS.empty.documents).toBe('Aucun document associé.');
    expect(GROUPING_LABELS.emptyLinkedEvents).toBe('Aucun événement associé.');
    expect(GROUPING_LABELS.pickerTitle.elements).toBe('Choisir un événement à associer');
    expect(GROUPING_LABELS.pickerSearch.elements).toBe('Rechercher un événement');
    expect(groupingActionToast('relier-element')).toBe('Événement associé');
    expect(groupingActionToast('retirer-element')).toBe('Association retirée');
    expect(GROUPING_LABELS.dissociateEvent('Contrôle')).toBe('Dissocier « Contrôle »');
  });
  it('aucun « élément de l’agenda » ni « Opération » visible dans ces libellés ; boutons « Associer… » sous « Associations »', () => {
    const tout = JSON.stringify(GROUPING_LABELS) + GROUPING_LABELS.dissociateEvent('x');
    expect(tout).not.toMatch(/[ée]l[ée]ment de l.agenda|[ée]l[ée]ment d.agenda|Relier cet élément|Opération/i);
    expect(GROUPING_LABELS.add.documents).toMatch(/^Associer/);
    const doc = lire('src/components/assets/DocumentDrawer.tsx');
    expect(doc).toContain('GROUPING_LABELS.documentLinkedEvents');
    expect(doc).toContain('title={GROUPING_LABELS.pickerTitle.elements}');
    expect(doc).not.toContain('/>Éléments agenda');
  });
});

describe('L103D-U-COH — contrôles du registre', () => {
  it('ajoutés EN FIN de registre, après COH-EQUIPMENT-IDENTITY, couverts (domaine agenda), jamais destructeurs', async () => {
    const { COHERENCE_REGISTRY } = await import('@/services/coherence/registry');
    const { COVERAGE_INVENTORY } = await import('@/services/coherence/registry/coverage');
    const ids = COHERENCE_REGISTRY.map((c) => c.id);
    // Ordre d'ajout en fin de registre (sans réordonner l'existant) : 101A, 103E, 103D, puis lots suivants (105D…).
    const apres = ids.slice(ids.indexOf('COH-EQUIPMENT-IDENTITY'));
    // #715 : COH-AGENDA-HISTORICAL-STATUS retiré (plus de statut d'événement).
    expect(apres.slice(0, 3)).toEqual(['COH-EQUIPMENT-IDENTITY', 'COH-AGENDA-SUPPLIERS', 'COH-AGENDA-STRUCTURAL-HOUSING']);
    expect(ids).not.toContain('COH-AGENDA-HISTORICAL-STATUS');
    const agenda = COVERAGE_INVENTORY.find((d) => d.domain === 'agenda')!;
    expect(agenda.checks).toEqual(expect.arrayContaining(['COH-AGENDA-STRUCTURAL-HOUSING']));
    expect(agenda.checks).not.toContain('COH-AGENDA-HISTORICAL-STATUS');
    const housing = COHERENCE_REGISTRY.find((c) => c.id === 'COH-AGENDA-STRUCTURAL-HOUSING')!;
    expect(housing.immediateSupervision).toEqual(['STRUCTURAL_LINK_HOUSING_AMBIGUOUS']);
    expect(housing.forbiddenRepairs.join(' ')).toMatch(/utilisateur/);
    expect(housing.forbiddenRepairs.join(' ')).toMatch(/supprimer une pièce/);
  });
});
