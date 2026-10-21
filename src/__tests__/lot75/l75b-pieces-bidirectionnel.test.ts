/**
 * Lot 75 (75B) — Pièces : gestion bidirectionnelle des équipements et
 * documents, filtres Pièce / Équipement de « Mes documents » et « Mon agenda ».
 *
 * Environnement `node` : logique pure, rendu serveur des composants
 * partagés, routes avec service simulé, contrats lus dans les sources. Les
 * associations réelles (directes, indirectes, multiples, dissociations,
 * réaffectations, isolation) sont prouvées sur PostgreSQL 16 par
 * `src/test/e2e/scenarios/l75b-pieces-bidirectionnel.e2e.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';

(globalThis as { React?: typeof React }).React = React;
vi.mock('@/db', () => ({ db: {}, pgClient: vi.fn() }));
const session = vi.hoisted(() => ({ current: { userId: 1, currentAccountId: 10 } as { userId: number; currentAccountId: number | null } }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: vi.fn(async () => session.current),
    handleSessionError: () => new Response(null, { status: 401 }),
  },
}));
vi.mock('@/lib/write-access-guard', () => ({ refuserSiLectureSeule: vi.fn(async () => null) }));
vi.mock('@/lib/asset-quota-guard', () => ({ refuserSiModificationBiensSuspendue: vi.fn(async () => null) }));
vi.mock('@/services/verebona-assistant/events/business-events', () => ({ emitBusinessEvent: vi.fn(async () => {}) }));
const svc = vi.hoisted(() => ({
  getRoomInAccount: vi.fn(),
  associateEquipmentsToRoom: vi.fn(),
  dissociateEquipmentFromRoom: vi.fn(),
  associateDocumentsToRoom: vi.fn(),
  dissociateDocumentFromRoom: vi.fn(),
  listRoomEquipments: vi.fn(),
  listRoomDocuments: vi.fn(),
}));
vi.mock('@/services/rooms/room-scope.service', async (orig) => {
  const actual = await orig<typeof import('@/services/rooms/room-scope.service')>();
  return {
    ...actual,
    getRoomInAccount: (...a: unknown[]) => svc.getRoomInAccount(...a),
    associateEquipmentsToRoom: (...a: unknown[]) => svc.associateEquipmentsToRoom(...a),
    dissociateEquipmentFromRoom: (...a: unknown[]) => svc.dissociateEquipmentFromRoom(...a),
    associateDocumentsToRoom: (...a: unknown[]) => svc.associateDocumentsToRoom(...a),
    dissociateDocumentFromRoom: (...a: unknown[]) => svc.dissociateDocumentFromRoom(...a),
    listRoomEquipments: (...a: unknown[]) => svc.listRoomEquipments(...a),
    listRoomDocuments: (...a: unknown[]) => svc.listRoomDocuments(...a),
  };
});

import {
  buildRoomFilterModel, parseRoomFilter, roomFilterParam, selectedRoomId,
} from '@/lib/filters/room-filter';
import {
  canDissociateRoomDocument, reassignConfirmationText, roomDocumentProvenance,
} from '@/lib/rooms/room-associations';
import { buildFeedQuery, parseFeedParams } from '@/lib/documents/document-feed';
import {
  EMPTY_FILTERS, activeFilterChips, activeFilterCount, setRoomFilter, toggleFilter,
} from '@/components/documents/v2/documents-view';
import { agendaFilterChips } from '@/lib/agenda/agenda-filters';
import { RoomFilterSection } from '@/components/filters/RoomFilterSection';
import { RoomAssociationError, cleanRoomIds } from '@/services/rooms/room-scope.service';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const sansCommentaires = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const ROOM = { id: 7, name: 'Cuisine', assetId: 3, assetName: 'Maison' };
const req = (url: string, init?: { method?: string; body?: unknown }) =>
  new NextRequest(`http://localhost${url}`, { method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.stringify(init.body) } : {}) });
const p = <T,>(v: T) => ({ params: Promise.resolve(v) });

beforeEach(() => {
  session.current = { userId: 1, currentAccountId: 10 };
  Object.values(svc).forEach((f) => f.mockReset());
  svc.getRoomInAccount.mockResolvedValue(ROOM);
});

// ── Filtre Pièce : logique pure ────────────────────────────────────────────

describe('L75B-FILT — filtre Pièce (pur)', () => {
  it('L75B-FILT-01 — lecture défensive : identifiant positif, sinon « Toutes »', () => {
    expect(parseRoomFilter('12')).toBe('12');
    expect(parseRoomFilter('0')).toBe('all');
    expect(parseRoomFilter('abc')).toBe('all');
    expect(parseRoomFilter(null)).toBe('all');
    expect(roomFilterParam('all')).toBeNull();
    expect(selectedRoomId('42')).toBe(42);
  });

  it('L75B-FILT-02 — masqué sans bien retenu ou sans pièce ; visible et groupé par bien sinon', () => {
    expect(buildRoomFilterModel({ items: [] }, 'all', 1).visible).toBe(false);
    expect(buildRoomFilterModel({ items: [{ id: 1, name: 'Cuisine', assetId: 3, assetName: 'Maison', count: 2 }] }, 'all', 0).visible).toBe(false);
    const m = buildRoomFilterModel({
      items: [
        { id: 1, name: 'Cuisine', assetId: 3, assetName: 'Maison', count: 3 },
        { id: 2, name: 'Cellier', assetId: 3, assetName: 'Maison', count: 0 },
      ],
    }, '1', 1);
    expect(m.visible).toBe(true);
    expect(m.general[0]).toMatchObject({ label: 'Toutes les pièces', active: false });
    expect(m.groups[0].options.map((o) => [o.label, o.count, o.active])).toEqual([['Cuisine', 3, true], ['Cellier', 0, false]]);
    expect(m.chipLabel).toBe('Cuisine');
    const multi = buildRoomFilterModel({
      items: [{ id: 1, name: 'Cuisine', assetId: 3, assetName: 'Maison', count: 1 }, { id: 9, name: 'Cuisine', assetId: 4, assetName: 'Studio', count: 0 }],
    }, '9', 2);
    expect(multi.multi).toBe(true);
    expect(multi.chipLabel).toBe('Studio · Cuisine');
  });

  it('L75B-FILT-03 — pièce inconnue des biens retenus : pas de pastille (l’écran la retire)', () => {
    const m = buildRoomFilterModel({ items: [{ id: 1, name: 'Cuisine', assetId: 3, assetName: 'Maison', count: 1 }] }, '99', 1);
    expect(m.chipLabel).toBeNull();
    expect(m.value).toBe('all');
  });

  it('L75B-FILT-04 — « Mes documents » : paramètre `piece` lu et transmis, changement de bien = réinitialisation', () => {
    const params = parseFeedParams(new URLSearchParams('biens=3&piece=7&equipment=12'));
    expect(params.filters).toMatchObject({ biens: ['3'], piece: '7', equipment: '12' });
    expect(parseFeedParams(new URLSearchParams('piece=x')).filters.piece).toBeUndefined();
    const q = buildFeedQuery({ assetIds: [], sort: 'added', direction: 'desc', grouped: false, ids: null, filters: { biens: ['3'], rubrics: [], types: [], piece: '7' } });
    expect(new URLSearchParams(q).get('piece')).toBe('7');

    const f = setRoomFilter({ ...EMPTY_FILTERS, biens: ['3'], equipment: '12' }, '7');
    expect(activeFilterCount(f)).toBe(3);
    expect(activeFilterChips(f, { biens: [{ value: '3', label: 'Maison', count: 1, active: true }], rubrics: [], types: [] }, 'Four', 'Cuisine')
      .map((c) => `${c.dim}:${c.label}`)).toEqual(['biens:Maison', 'piece:Cuisine', 'equipment:Four']);
    // Bien changé : Pièce ET Équipement réinitialisés (valeurs devenues invalides).
    const apres = toggleFilter(f, 'biens', '4');
    expect(apres.piece).toBeUndefined();
    expect(apres.equipment).toBeUndefined();
    expect(setRoomFilter(f, 'all').piece).toBeUndefined();
  });

  it('L75B-FILT-05 — « Mon agenda » : pastille Pièce entre Bien et Équipement', () => {
    expect(agendaFilterChips({
      period: 'all', assetIds: [3], includeCancelled: false, assetOptions: [{ id: 3, name: 'Maison' }],
      equipmentChipLabel: 'Four', roomChipLabel: 'Cuisine',
    }).map((c) => c.key)).toEqual(['bien:3', 'piece', 'equipment']);
  });

  it('L75B-FILT-06 — section partagée : choix unique en pastilles, masquée sans pièce (desktop et mobile : même composant)', () => {
    const model = buildRoomFilterModel({ items: [{ id: 1, name: 'Cuisine', assetId: 3, assetName: 'Maison', count: 4 }] }, 'all', 1);
    const html = renderToStaticMarkup(h(RoomFilterSection, { id: 'f-piece', model, onSelect: () => {} }));
    expect(html).toContain('Pièce');
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('Cuisine · 4');
    expect(html).toContain('data-testid="filtre-piece"');
    expect(renderToStaticMarkup(h(RoomFilterSection, { id: 'x', model: buildRoomFilterModel(null, 'all', 1), onSelect: () => {} }))).toBe('');
  });
});

// ── Tiroir Pièce : provenance ──────────────────────────────────────────────

describe('L75B-DRAW — provenance et dissociation (pur)', () => {
  it('L75B-DRAW-01 — « Pièce », « Via [équipement] », ou les deux pour un document trouvé par deux chemins', () => {
    expect(roomDocumentProvenance({ direct: true, via: [] })).toEqual(['Pièce']);
    expect(roomDocumentProvenance({ direct: false, via: [{ id: 1, name: 'Réfrigérateur' }] })).toEqual(['Via Réfrigérateur']);
    expect(roomDocumentProvenance({ direct: true, via: [{ id: 1, name: 'Four' }, { id: 2, name: 'Réfrigérateur' }] }))
      .toEqual(['Pièce', 'Via Four, Réfrigérateur']);
  });

  it('L75B-DRAW-02 — dissociation directe seulement pour un lien direct', () => {
    expect(canDissociateRoomDocument({ direct: true })).toBe(true);
    expect(canDissociateRoomDocument({ direct: false })).toBe(false);
  });

  it('L75B-DRAW-03 — texte de confirmation de réaffectation (cardinalité : une pièce au plus)', () => {
    const t = reassignConfirmationText('equipment', 'Cellier', [{ id: 1, title: 'Réfrigérateur', currentRoom: { id: 7, name: 'Cuisine' } }]);
    expect(t).toContain('« Réfrigérateur » (actuellement : Cuisine)');
    expect(t).toContain('déplacé vers « Cellier »');
    expect(cleanRoomIds([3, 3, 0, -1, 2.5, 4])).toEqual([3, 4]);
  });
});

// ── Routes ─────────────────────────────────────────────────────────────────

describe('L75B-API — routes du tiroir Pièce (service simulé)', () => {
  it('L75B-API-01 — pièce d’un autre compte ou absente : 404 avant toute lecture ou écriture', async () => {
    svc.getRoomInAccount.mockResolvedValue(null);
    const { GET } = await import('@/app/api/substructures/[id]/associations/route');
    expect((await GET(req('/api/substructures/7/associations'), p({ id: '7' }))).status).toBe(404);
    const { POST } = await import('@/app/api/substructures/[id]/equipments/route');
    expect((await POST(req('/api/substructures/7/equipments', { method: 'POST', body: { equipmentIds: [1] } }), p({ id: '7' }))).status).toBe(404);
    expect(svc.associateEquipmentsToRoom).not.toHaveBeenCalled();
    expect(svc.getRoomInAccount).toHaveBeenCalledWith(10, 7);
  });

  it('L75B-API-02 — lecture consolidée : équipements + documents', async () => {
    svc.listRoomEquipments.mockResolvedValue([{ id: 1, name: 'Four', type: null, status: 'EN_SERVICE', archived: false }]);
    svc.listRoomDocuments.mockResolvedValue([{ id: 5, publicId: 'x', title: 'Manuel', documentTypeLabel: null, documentDate: null, mimeType: null, direct: false, via: [{ id: 1, name: 'Four' }] }]);
    const { GET } = await import('@/app/api/substructures/[id]/associations/route');
    const res = await GET(req('/api/substructures/7/associations'), p({ id: '7' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.room).toEqual(ROOM);
    expect(body.documents[0].via).toEqual([{ id: 1, name: 'Four' }]);
  });

  it('L75B-API-03 — réaffectation sans confirmation : 409 avec les conflits (details), rien d’écrit ; confirmée : 200', async () => {
    const conflicts = [{ id: 1, title: 'Réfrigérateur', currentRoom: { id: 8, name: 'Cellier' } }];
    svc.associateEquipmentsToRoom.mockResolvedValueOnce({ status: 'confirm', conflicts });
    const { POST } = await import('@/app/api/substructures/[id]/equipments/route');
    const r1 = await POST(req('/x', { method: 'POST', body: { equipmentIds: [1] } }), p({ id: '7' }));
    expect(r1.status).toBe(409);
    expect((await r1.json()).details.conflicts).toEqual(conflicts);
    svc.associateEquipmentsToRoom.mockResolvedValueOnce({ status: 'done', associated: [1] });
    const r2 = await POST(req('/x', { method: 'POST', body: { equipmentIds: [1], confirmReassign: true } }), p({ id: '7' }));
    expect(r2.status).toBe(200);
    expect(svc.associateEquipmentsToRoom).toHaveBeenLastCalledWith(10, ROOM, [1], true);
  });

  it('L75B-API-04 — corps invalide : 400 ; équipement d’un autre bien : 400', async () => {
    const { POST } = await import('@/app/api/substructures/[id]/equipments/route');
    expect((await POST(req('/x', { method: 'POST', body: { equipmentIds: [] } }), p({ id: '7' }))).status).toBe(400);
    expect((await POST(req('/x', { method: 'POST', body: { equipmentIds: ['a'] } }), p({ id: '7' }))).status).toBe(400);
    svc.associateEquipmentsToRoom.mockRejectedValueOnce(new RoomAssociationError('OTHER_ASSET', 'autre bien'));
    expect((await POST(req('/x', { method: 'POST', body: { equipmentIds: [3] } }), p({ id: '7' }))).status).toBe(400);
  });

  it('L75B-API-05 — dissocier un document seulement « Via » : 409 NOT_DIRECT ; direct : 200', async () => {
    const { DELETE } = await import('@/app/api/substructures/[id]/documents/[fileId]/route');
    svc.dissociateDocumentFromRoom.mockRejectedValueOnce(new RoomAssociationError('NOT_DIRECT', 'via'));
    const r1 = await DELETE(req('/x', { method: 'DELETE' }), p({ id: '7', fileId: '5' }));
    expect(r1.status).toBe(409);
    expect((await r1.json()).error).toBe('NOT_DIRECT');
    svc.dissociateDocumentFromRoom.mockResolvedValueOnce(undefined);
    expect((await DELETE(req('/x', { method: 'DELETE' }), p({ id: '7', fileId: '5' }))).status).toBe(200);
    expect((await DELETE(req('/x', { method: 'DELETE' }), p({ id: '7', fileId: 'abc' }))).status).toBe(400);
  });

  it('L75B-API-06 — écriture refusée en lecture seule (garde standard)', async () => {
    const guard = await import('@/lib/write-access-guard');
    vi.mocked(guard.refuserSiLectureSeule).mockResolvedValueOnce(new Response(null, { status: 403 }) as never);
    const { DELETE } = await import('@/app/api/substructures/[id]/equipments/[equipmentId]/route');
    expect((await DELETE(req('/x', { method: 'DELETE' }), p({ id: '7', equipmentId: '1' }))).status).toBe(403);
    expect(svc.dissociateEquipmentFromRoom).not.toHaveBeenCalled();
  });
});

// ── Contrats : une seule résolution, interface ───────────────────────────────

describe('L75B-SRC — centralisation et interface', () => {
  it('L75B-SRC-01 — tiroir, « Mes documents » et « Mon agenda » lisent le même service central', () => {
    const feed = sansCommentaires(read('src/services/documents/rubric-query.service.ts'));
    expect(feed).toMatch(/from '@\/services\/rooms\/room-scope\.service'/);
    expect(feed).toContain('roomDocumentLinksSql(');
    expect(feed).toContain('documentRoomFilterCondition(');
    const agenda = sansCommentaires(read('src/services/agenda/AgendaQueryService.ts'));
    expect(agenda).toContain('agendaItemIdsByRoom(');
    const service = read('src/services/rooms/room-scope.service.ts');
    // Résolution des documents d'une pièce : une seule définition, réutilisée.
    expect(service.match(/export function roomDocumentLinksSql/g)).toHaveLength(1);
    expect(sansCommentaires(service)).toContain('${roomDocumentLinksSql(ids)}');
    // Aucun lien n'est créé pour l'indirect : seules les colonnes de rattachement existantes sont écrites.
    expect(sansCommentaires(service)).not.toMatch(/INSERT INTO/i);
  });

  it('L75B-SRC-02 — tiroir Pièce : cartes EntityCard (lot 75H), associer / créer / importer / dissocier, garde d’écriture', () => {
    expect(read('src/components/assets/RoomDrawer.tsx')).toContain('<RoomAssociations roomId={room!.id}');
    const ui = sansCommentaires(read('src/components/assets/RoomAssociations.tsx'));
    expect(ui).toContain('<EntityCard');
    expect(ui).toContain('kind="equipement"');
    expect(ui).toContain('kind="document"');
    expect(ui).toContain('initialSubstructureId={roomId}');
    expect(ui).toContain('preselectedSubstructureId={roomId}');
    expect(ui).toContain('canDissociateRoomDocument(d) ?');
    expect(ui).toContain('useWriteGuard');
    expect(ui).toContain('REASSIGN_CONFIRMATION');
  });

  it('L75B-SRC-03 — synchronisation : tiroirs Équipement et Document, listes et filtres écoutent l’événement', () => {
    for (const f of [
      'src/components/assets/EquipmentDrawer.tsx', 'src/components/assets/DocumentDrawer.tsx',
      'src/components/assets/RoomAssociations.tsx', 'src/components/documents/v2/DocumentsByRubric.tsx',
    ]) {
      expect(sansCommentaires(read(f)), f).toContain('ROOM_ASSOCIATIONS_CHANGED');
    }
    // Les échéances de la pièce suivent : « Mon agenda » relit sur `agenda-mutated`.
    expect(read('src/lib/rooms/room-associations.ts')).toContain("new CustomEvent('agenda-mutated')");
  });

  it('L75B-SRC-04 — « Mon agenda » et l’onglet Agenda d’un bien : section Pièce dans le panneau intégré (pas de tiroir)', () => {
    const page = sansCommentaires(read('src/app/(dashboard)/agenda/page.tsx'));
    expect(page).toContain('<RoomFilterSection');
    expect(page).toContain("if (piece) params.set('piece', piece);");
    expect(page).not.toMatch(/<Sheet\b/);
    expect(sansCommentaires(read('src/components/assets/AssetAgendaFilters.tsx'))).toContain('<RoomFilterSection');
    expect(sansCommentaires(read('src/components/documents/v2/DocumentsFilterPanel.tsx'))).toContain('<RoomFilterSection');
  });
});
