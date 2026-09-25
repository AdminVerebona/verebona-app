/**
 * Tiroirs généralisés — lien profond et routage des fiches.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseDrawerParam, drawerHref, drawerFromHref, openDrawerFromLink,
  OPEN_DOCUMENT_DRAWER, OPEN_ENTITY_DRAWER,
} from '../drawers';
import { hrefEntite } from '@/services/verebona-assistant/core/entity-ref';

describe('paramètre ?tiroir=', () => {
  it('lit les quatre fiches et leurs synonymes', () => {
    expect(parseDrawerParam('document:12')).toEqual({ kind: 'document', id: 12 });
    expect(parseDrawerParam('agenda:3')).toEqual({ kind: 'echeance', id: 3 });
    expect(parseDrawerParam('equipment:7')).toEqual({ kind: 'equipement', id: 7 });
    expect(parseDrawerParam('room:9')).toEqual({ kind: 'piece', id: 9 });
  });

  it('refuse tout le reste', () => {
    for (const v of [null, '', 'bien:4', 'document:', 'document:0', 'document:-1', 'document:1;drop', 'document:abc']) {
      expect(parseDrawerParam(v)).toBeNull();
    }
  });

  it('construit et relit un lien, en gardant la requête existante', () => {
    const href = drawerHref({ kind: 'equipement', id: 5 }, '/assets/2?tab=equipments');
    expect(href).toBe('/assets/2?tab=equipments&tiroir=equipement%3A5');
    expect(drawerFromHref(href)).toEqual({ kind: 'equipement', id: 5 });
    expect(drawerFromHref('/agenda')).toBeNull();
  });
});

describe('ouverture', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('le document garde son événement historique, les autres fiches passent par l’hôte', () => {
    const events: Array<[string, unknown]> = [];
    vi.stubGlobal('window', { dispatchEvent: (e: CustomEvent) => { events.push([e.type, e.detail]); return true; } });
    vi.stubGlobal('CustomEvent', class { constructor(public type: string, init?: { detail?: unknown }) { this.detail = init?.detail; } detail: unknown; });
    const e = { preventDefault: vi.fn() };
    expect(openDrawerFromLink(e, '/documents?tiroir=document:4')).toBe(true);
    expect(openDrawerFromLink(e, '/agenda?tiroir=echeance:8')).toBe(true);
    expect(openDrawerFromLink({ ...e, metaKey: true }, '/agenda?tiroir=echeance:8')).toBe(false);
    expect(openDrawerFromLink(e, '/assets/2')).toBe(false);
    expect(events).toEqual([
      [OPEN_DOCUMENT_DRAWER, { docId: 4, showAnalysisResults: undefined }],
      [OPEN_ENTITY_DRAWER, { kind: 'echeance', id: 8 }],
    ]);
  });
});

describe('sources de l’assistant', () => {
  it('ouvrent la fiche elle-même, pas une liste', () => {
    expect(hrefEntite({ kind: 'document', id: 4, sourceId: 'doc_4' } as never)).toBe('/documents?tiroir=document%3A4');
    expect(hrefEntite({ kind: 'agenda_item', id: 8, sourceId: 'x' } as never)).toBe('/agenda?tiroir=echeance%3A8');
    expect(hrefEntite({ kind: 'equipment', id: 5, sourceId: 'x' } as never, { assetId: 2 }))
      .toBe('/assets/2?tab=equipments&tiroir=equipement%3A5');
    expect(hrefEntite({ kind: 'room', id: 6, sourceId: 'x' } as never)).toBe('/accueil?tiroir=piece%3A6');
  });
});
