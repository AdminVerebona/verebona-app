/**
 * Lot 89B — demande PO du 25/10/2026 « Style du tiroir document » (desktop ET
 * mobile : mêmes composants).
 *
 *   L89B-UI01  plus de pastille de Type sous le titre ; le Type reste dans « Informations »
 *   L89B-UI02  « Statut : analysé » (et équivalents) au lieu de « Automatique — Analysé »
 *   L89B-UI03  libellés centralisés : « Associer à l’agenda », « Associer un document », « Retirer l’association »
 *   L89B-UI04  bouton d'association au style neutre (pas d'accent pétrole, pas d'anneau cuivre)
 *   L89B-UI05  « Associer à l’agenda » ouvre la sélection des éléments existants ; la création est une
 *              action distincte et explicite « Créer un élément d’agenda »
 *   L89B-SRV01 la route d'association et le service ne créent jamais d'élément d'agenda
 */
import * as React from 'react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgendaGroupingView } from '@/lib/agenda/grouping-view';
import { GROUPING_LABELS as L } from '@/lib/agenda/grouping-view';
import { documentStatusLabel, documentStatusValue } from '@/lib/documents/document-status-label';

(globalThis as { React?: typeof React }).React = React;
const { AgendaGroupingPanel, ASSOCIATION_BTN } = await import('../AgendaGroupingPanel');

const lire = (p: string) => readFileSync(resolve(__dirname, '..', '..', '..', p), 'utf8').replace(/\r\n?/g, '\n');
const rien = () => undefined;
const rendre = (view: AgendaGroupingView) => renderToStaticMarkup(h(AgendaGroupingPanel, {
  view, onAction: rien, onPick: rien, onCreateStep: rien, onRelease: rien, onOpenMain: rien, onOpenDocument: rien,
}));
const tiroir = lire('components/assets/DocumentDrawer.tsx');

describe('L89B-UI01 — en-tête du tiroir document', () => {
  it('aucune pastille de Type sous le titre ; ligne « Type » de « Informations » conservée', () => {
    expect(tiroir).not.toMatch(/DocumentTypeBadge/);
    expect(tiroir).toMatch(/<\/SheetTitle>\s*<\/div>/);
    expect(tiroir).toContain('<span className="text-muted-foreground">Type</span>');
    expect(tiroir).toContain('{rubricTypeLabels(fullData).type}');
  });
});

describe('L89B-UI02 — statut d’analyse sobre', () => {
  it('libellés « Statut : … » pour chaque état', () => {
    expect(documentStatusLabel('ANALYZED')).toBe('Statut : analysé');
    expect(documentStatusLabel('ANALYZING')).toBe('Statut : analyse en cours');
    expect(documentStatusLabel('UPLOADED')).toBe('Statut : en file d’attente');
    expect(documentStatusLabel('UPLOADING')).toBe('Statut : en file d’attente');
    expect(documentStatusLabel('ANALYSIS_FAILED')).toBe('Statut : analyse non finalisée');
    expect(documentStatusLabel('ANALYSIS_FAILED', 'NEEDS_USER_ACTION')).toBe('Statut : action requise');
    expect(documentStatusLabel('CONFLICT_DETECTED')).toBe('Statut : conflit détecté');
    expect(documentStatusLabel('FUSION_SUGGESTED')).toBe('Statut : doublon possible');
  });
  it('état inconnu : jamais un échec, lu « analysé »', () => {
    expect(documentStatusValue('QUELQUE_CHOSE')).toBe('analysé');
    expect(documentStatusValue(null)).toBe('analysé');
  });
  it('tiroir : plus de « Automatique — » ; détail dépliable seulement s’il apporte quelque chose', () => {
    expect(tiroir).not.toMatch(/Automatique —/);
    expect(tiroir).not.toContain('Informations déjà complètes');
    expect(tiroir).toContain('documentStatusLabel(analysisState, fullData?.processingStatus)');
    expect(tiroir).toContain('{hasDetail ? (');
    expect(tiroir).toContain('aria-expanded={showDetectedInfo}');
  });
});

describe('L89B-UI03 — libellés d’association centralisés', () => {
  it('valeurs validées par le PO', () => {
    expect(L.documentAgendaTitle).toBe('Associer à l’agenda');
    expect(L.add.documents).toBe('Associer un document');
    expect(L.detach).toBe('Retirer l’association');
    expect(L.detachFromItem('Devis')).toBe('Retirer l’association avec « Devis »');
    expect(L.detachItemFromDocument('Visite')).toBe('Retirer l’association avec « Visite »');
    expect(L.createAgendaItem).toBe('Créer un élément d’agenda');
    const textes = [L.documentAgendaTitle, L.add.documents, L.detach, L.createAgendaItem, L.associatedToast, L.detachedToast].join(' ');
    expect(textes).not.toMatch(/opération|principal|Relier|Détacher/i);
  });
  it('tiroir document : libellés lus dans GROUPING_LABELS, aucun libellé en dur', () => {
    expect(tiroir).toContain('{GROUPING_LABELS.documentAgendaTitle}');
    expect(tiroir).toContain('GROUPING_LABELS.associatedToast');
    expect(tiroir).not.toMatch(/Relier à un élément|'Document relié'|>Détacher</);
  });
  it('tiroir agenda : « Associer un document » et « Retirer l’association avec … »', () => {
    const html = rendre({ itemId: 9, role: 'NONE', main: null, mainWithdrawn: false, ensemble: null, counts: null,
      linkedDocuments: [{ id: 10, title: 'Facture', documentDate: null, link: 'DIRECT' }] });
    expect(html).toContain('Associer un document');
    expect(html).toContain('aria-label="Retirer l’association avec « Facture »"');
    expect(html).toContain('title="Retirer l’association"');
    expect(html).not.toMatch(/Détacher|Relier un document/);
  });
});

describe('L89B-UI04 — style neutre des boutons d’association', () => {
  it('pas d’accent ni de cuivre ; focus clavier neutre conservé', () => {
    expect(ASSOCIATION_BTN).not.toMatch(/--accent|--attention|--focus-ring-color|--danger/);
    expect(ASSOCIATION_BTN).toContain('focus-visible:outline-[color:var(--text-muted)]');
    expect(ASSOCIATION_BTN).toContain('hover:border-[color:var(--border)]');
  });
  it('tiroir document et tiroir agenda : même classe, anneau cuivre désactivé sur ces seuls boutons', () => {
    const fin = tiroir.indexOf('data-testid="document-relier-agenda"');
    const btn = tiroir.slice(tiroir.lastIndexOf('<Button', fin), fin);
    expect(btn).toContain('${ASSOCIATION_BTN}');
    expect(btn).toContain('data-focus-ring="off"');
    const html = rendre({ itemId: 9, role: 'NONE', main: null, mainWithdrawn: false, ensemble: null, counts: null, linkedDocuments: [] });
    const b = html.match(/<button[^>]*data-testid="regroupement-relier-documents"[^>]*>/)?.[0] ?? '';
    expect(b).toContain('data-focus-ring="off"');
    expect(b).toContain('min-h-11 sm:min-h-8');
    expect(b).not.toContain('hover:border-[color:var(--accent)]');
  });
});

describe('L89B-UI05 — associer ≠ créer', () => {
  it('le bouton ouvre la sélection ; choisir relie un élément EXISTANT', () => {
    expect(tiroir).toContain('onClick={() => garder(() => setAgendaPickerOpen(true))} data-testid="document-relier-agenda"');
    expect(tiroir).toContain('onPick={(c) => { setAgendaPickerOpen(false); void relierAgenda(c.id); }}');
    // `relierAgenda` n'appelle que la route d'association.
    const relier = tiroir.slice(tiroir.indexOf('const relierAgenda = async'), tiroir.indexOf('const detacherAgenda = async'));
    expect(relier).toContain('apiClient.post(`/api/documents/${doc.id}/agenda-liens`, { itemId })');
    expect(relier).not.toMatch(/setAgendaDrawerOpen|\/api\/agenda['`]/);
  });
  it('création : action distincte, explicite, en pied du choix', () => {
    expect(tiroir).toContain('label: GROUPING_LABELS.createAgendaItem');
    expect(tiroir).toContain("testId: 'document-creer-element-agenda'");
    const panel = lire('components/agenda/AgendaGroupingPanel.tsx');
    expect(panel).toContain('{createAction && (');
    expect(panel).toContain('onClick={createAction.onCreate}');
  });
});

describe('L89B-SRV01 — la route d’association ne crée jamais d’élément d’agenda', () => {
  it('route POST /api/documents/:id/agenda-liens : geste « relier-document » seulement', () => {
    const route = lire('app/api/documents/[id]/agenda-liens/route.ts');
    expect(route).toContain("action: 'relier-document'");
    expect(route).not.toMatch(/INSERT INTO agenda_items|createAgendaItem|\/api\/agenda['`]/i);
  });
  it('service `linkDocumentToAgendaItem` : élément relu dans le compte (introuvable → erreur), aucune insertion d’élément', () => {
    const svc = lire('services/business-operations/grouping/service.ts');
    const corps = svc.slice(svc.indexOf('export async function linkDocumentToAgendaItem'), svc.indexOf('export async function detachDocumentFromAgendaGroup'));
    expect(corps).toContain('await loadItem(ctx, p.itemId)');
    expect(corps).not.toMatch(/INSERT INTO agenda_items|createAgendaItem|agendaItems\)/i);
  });
});
