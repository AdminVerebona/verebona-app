/**
 * Lot 34G — dispatcher générique des actions de l'assistant et ouverture
 * directe des parcours de création (ticket « T2 Aide produit », §3, §4, §7).
 *
 *   START_ADD_DOCUMENT    → UnifiedDocumentDialog, pas de navigation /documents
 *   START_ADD_ASSET       → AssetFormDialog, pas de navigation /assets
 *   START_ADD_AGENDA_ITEM → CreateAgendaItemDrawer, pas de navigation /agenda
 *
 * Le dispatcher et la correspondance parcours → formulaire sont purs ; le
 * câblage de l'interface (SpaceContent, hôte global, DashboardLayout) est
 * vérifié sur les sources — l'environnement de test n'a pas de DOM.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CREATE_ACTION_FLOWS, assistantActionKind, createCommandFor, executeAssistantAction, type AssistantActionHandlers,
} from '../assistant-actions';
import { OPEN_CREATE_FLOW, createFlowView, openCreateFlow, parseCreateFlowRequest } from '@/lib/create-flows';

const ROOT = join(__dirname, '../../..');
const source = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function handlers() {
  const h = { navigate: vi.fn(), create: vi.fn(), assistantUi: vi.fn() };
  return h as typeof h & AssistantActionHandlers;
}

const ATTENDU = {
  START_ADD_DOCUMENT: { flow: 'document', component: 'UnifiedDocumentDialog', page: '/documents' },
  START_ADD_ASSET: { flow: 'asset', component: 'AssetFormDialog', page: '/assets' },
  START_ADD_AGENDA_ITEM: { flow: 'agenda_item', component: 'CreateAgendaItemDrawer', page: '/agenda' },
} as const;

describe('HELP2 — dispatcher générique executeAssistantAction', () => {
  it('HELP2-30 — familles : NAVIGATION, OPEN_ENTITY, CREATE, ASSISTANT_UI', () => {
    expect(assistantActionKind('OPEN_HELP')).toBe('NAVIGATION');
    expect(assistantActionKind('OPEN_AGENDA')).toBe('NAVIGATION');
    expect(assistantActionKind('OPEN_DOCUMENT')).toBe('OPEN_ENTITY');
    expect(assistantActionKind('OPEN_ASSET')).toBe('OPEN_ENTITY');
    for (const t of Object.keys(ATTENDU)) expect(assistantActionKind(t)).toBe('CREATE');
    expect(assistantActionKind('SHOW_EXPLANATION')).toBe('ASSISTANT_UI');
    expect(assistantActionKind('RETRY_REQUEST')).toBe('ASSISTANT_UI');
  });

  for (const [type, att] of Object.entries(ATTENDU)) {
    it(`HELP2-31 — ${type} → ${att.component}, pas de navigation ${att.page}`, () => {
      const h = handlers();
      const kind = executeAssistantAction({ type, href: null, command: createCommandFor(type) }, h);
      expect(kind).toBe('CREATE');
      expect(h.navigate).not.toHaveBeenCalled();
      expect(h.create).toHaveBeenCalledWith({ kind: 'CREATE', flow: att.flow, assetId: null });
      expect(createFlowView({ flow: att.flow }).component).toBe(att.component);
    });
  }

  it('HELP2-32 — avec assetId : présélection (document → preselectedAssetId, échéance → prefilledAssetId) ; jamais pour un bien', () => {
    const h = handlers();
    executeAssistantAction({ type: 'START_ADD_DOCUMENT', href: null, command: createCommandFor('START_ADD_DOCUMENT', 'asset:42') }, h);
    expect(h.create).toHaveBeenLastCalledWith({ kind: 'CREATE', flow: 'document', assetId: 42 });
    expect(createFlowView({ flow: 'document', assetId: 42 })).toEqual({ component: 'UnifiedDocumentDialog', preselectedAssetId: 42, quota: 'documents' });
    expect(createFlowView({ flow: 'agenda_item', assetId: 42 })).toEqual({ component: 'CreateAgendaItemDrawer', preselectedAssetId: 42, quota: undefined });
    expect(createCommandFor('START_ADD_ASSET', 'asset:42')).toEqual({ kind: 'CREATE', flow: 'asset', assetId: null });
    expect(createFlowView({ flow: 'asset', assetId: 42 })).toEqual({ component: 'AssetFormDialog', preselectedAssetId: null, quota: 'assets' });
    // Sans cible : ouverture sans bien présélectionné.
    expect(createFlowView({ flow: 'document' }).preselectedAssetId).toBeNull();
  });

  it('HELP2-33 — non-régression générique : START_ADD_* ≠ simple navigation, même avec un ancien href enregistré', () => {
    for (const type of Object.keys(CREATE_ACTION_FLOWS)) {
      const h = handlers();
      const ancienHref = ATTENDU[type as keyof typeof ATTENDU].page;
      executeAssistantAction({ type, href: ancienHref }, h);
      expect(h.navigate, type).not.toHaveBeenCalled();
      expect(h.create, type).toHaveBeenCalledTimes(1);
    }
    // Toute action de création du catalogue passe par le dispatcher.
    expect(Object.keys(CREATE_ACTION_FLOWS).sort()).toEqual(['START_ADD_AGENDA_ITEM', 'START_ADD_ASSET', 'START_ADD_DOCUMENT']);
  });

  it('HELP2-34 — navigation et fiches : href suivi ; action interne : interface de l’espace ; navigation sans href : rien', () => {
    const h = handlers();
    expect(executeAssistantAction({ type: 'OPEN_HELP', href: '/aide?page=%2Faide%2Fajouter-un-document' }, h)).toBe('NAVIGATION');
    expect(h.navigate).toHaveBeenLastCalledWith('/aide?page=%2Faide%2Fajouter-un-document', 'NAVIGATION');
    expect(executeAssistantAction({ type: 'OPEN_DOCUMENT', href: '/documents/9' }, h)).toBe('OPEN_ENTITY');
    expect(executeAssistantAction({ type: 'SHOW_EXPLANATION', href: null }, h)).toBe('ASSISTANT_UI');
    expect(h.assistantUi).toHaveBeenCalledWith('SHOW_EXPLANATION');
    expect(executeAssistantAction({ type: 'OPEN_SEARCH_RESULTS', href: null }, h)).toBeNull();
  });
});

describe('HELP2 — ouverture directe : événement et câblage de l’interface', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('HELP2-35 — openCreateFlow émet la demande validée (bien entier positif seulement)', () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent });
    vi.stubGlobal('CustomEvent', class { constructor(public type: string, public init: { detail: unknown }) {} });
    openCreateFlow({ flow: 'document', assetId: 42 });
    expect(dispatchEvent.mock.calls[0][0]).toMatchObject({ type: OPEN_CREATE_FLOW, init: { detail: { flow: 'document', assetId: 42 } } });
    expect(parseCreateFlowRequest({ flow: 'agenda_item', assetId: -3 })).toEqual({ flow: 'agenda_item', assetId: null });
    expect(parseCreateFlowRequest({ flow: 'autre' })).toBeNull();
  });

  it('HELP2-36 — SpaceContent : les actions passent par executeAssistantAction ; une création n’est jamais un lien', () => {
    const s = source('components/verebona/space/SpaceContent.tsx');
    expect(s).toContain('executeAssistantAction(a, {');
    expect(s).toContain("a.href && assistantActionKind(a.type) !== 'CREATE' ?");
    expect(s).toMatch(/create: \(command\) => \{[^}]*openCreateFlow\(\{ flow: command\.flow, assetId: command\.assetId \}\)/);
    // Aucun cas isolé par action de création dans l'interface.
    expect(s).not.toMatch(/START_ADD_/);
  });

  it('HELP2-37 — hôte global : garde d’écriture standard (droits, quotas), formulaires existants, bien présélectionné ; monté par DashboardLayout', () => {
    const host = source('components/drawers/GlobalCreateFlowHost.tsx');
    expect(host).toContain('useWriteGuard');
    expect(host).toContain('garder(() => setOuvert(r), createFlowView(r).quota)');
    expect(host).toMatch(/<LazyUnifiedDocumentDialog[\s\S]*preselectedAssetId=\{assetId\}/);
    expect(host).toMatch(/<LazyCreateAgendaItemDrawer[\s\S]*prefilledAssetId=\{assetId\}/);
    expect(host).toContain('<LazyAssetFormDialog');
    expect(source('components/DashboardLayout.tsx')).toContain('<GlobalCreateFlowHost />');
  });
});
