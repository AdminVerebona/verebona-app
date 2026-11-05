/**
 * Lot 111I — règles pures du rattachement multiple (L111I-U-PLAN).
 * Comportement SQL (déclencheur 0221, routes, TCO, Duo, reprise) :
 * `src/test/e2e/scenarios/l111i-rattachement-multiple.e2e.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  assertSelectionKnown, bodyHasTargetLists, currentSelection, diffLinks, linkKey, parseIdList, principalColumns, provenanceOf,
  resolveSelection, selectionFromBody, TargetSelectionError, DOCUMENT_TARGETS_MAX_PER_LEVEL,
  type ActiveTargetLink, type TargetCatalog, type TargetColumns,
} from '../plan';
import { multiEquipmentPurchaseCoverage } from '@/services/business-operations/tco/multi-equipment-attribution';
import {
  impliedLabel, impliedTargets, principalOf, removeAsset, removeRoom, hasExtraTargets, valueFromTargetsView, matchesFilter,
  type TargetOptionGroupView,
} from '@/lib/documents/document-targets-selection';

// Bien 1 « T3 Annecy » : cuisine (11), salon (12), four (101, cuisine), micro-onde (102, cuisine), TV (103, sans pièce).
// Bien 2 « Garage » : atelier (21), compresseur (201).
const cat: TargetCatalog = {
  assets: new Map([[1, { id: 1, name: 'T3 Annecy', writable: true }], [2, { id: 2, name: 'Garage', writable: true }]]),
  rooms: new Map([[11, { id: 11, name: 'Cuisine', assetId: 1 }], [12, { id: 12, name: 'Salon', assetId: 1 }], [21, { id: 21, name: 'Atelier', assetId: 2 }]]),
  equipments: new Map([
    [101, { id: 101, name: 'Four', assetId: 1, roomId: 11 }], [102, { id: 102, name: 'Micro-onde', assetId: 1, roomId: 11 }],
    [103, { id: 103, name: 'TV', assetId: 1, roomId: null }], [201, { id: 201, name: 'Compresseur', assetId: 2, roomId: 21 }],
  ]),
};
const cols = (o: Partial<TargetColumns> = {}): TargetColumns => ({ assetId: null, linkedAssetId: null, substructureId: null, equipmentId: null, linkedRoomId: null, ...o });
let nextId = 1;
const link = (o: Partial<ActiveTargetLink>): ActiveTargetLink => ({
  id: nextId++, assetId: null, roomId: null, substructureId: null, equipmentId: null, linkRole: 'SECONDARY', origin: 'USER', ...o,
});

describe('L111I-U-PLAN — lecture des listes et rétrocompatibilité', () => {
  it('listes dédoublonnées, ordre conservé, 0 / null / "" ignorés ; identifiant invalide refusé', () => {
    expect(parseIdList([3, '3', 1, 0, null, ''], 'x')).toEqual([3, 1]);
    expect(parseIdList(undefined, 'x')).toBeUndefined();
    expect(parseIdList(null, 'x')).toEqual([]);
    expect(() => parseIdList(['abc'], 'x')).toThrow(TargetSelectionError);
    expect(() => parseIdList([-1], 'x')).toThrow(TargetSelectionError);
    expect(() => parseIdList('1', 'x')).toThrow(TargetSelectionError);
    expect(() => parseIdList(Array.from({ length: DOCUMENT_TARGETS_MAX_PER_LEVEL + 1 }, (_, i) => i + 1), 'x')).toThrow(/au plus/);
  });
  it('ancien appel à valeur unique : aucune liste → chemin historique (null)', () => {
    expect(bodyHasTargetLists({ assetId: 1, equipmentId: 101 })).toBe(false);
    expect(selectionFromBody({ assetId: 1, equipmentId: 101 }, null)).toBeNull();
  });
  it('niveau absent : sélection actuelle conservée ; `roomIds` accepté comme alias', () => {
    const cur = { assetIds: [1], roomIds: [11], equipmentIds: [101] };
    expect(selectionFromBody({ equipmentIds: [101, 102] }, cur)).toEqual({ assetIds: [1], roomIds: [11], equipmentIds: [101, 102] });
    expect(selectionFromBody({ roomIds: [] }, cur)).toEqual({ assetIds: [1], roomIds: [], equipmentIds: [101] });
  });
  it('cible inconnue du compte : NOT_FOUND sans détail métier (anti-énumération)', () => {
    try {
      assertSelectionKnown({ assetIds: [1, 999], roomIds: [], equipmentIds: [888] }, cat);
      throw new Error('attendu');
    } catch (e) {
      expect(e).toBeInstanceOf(TargetSelectionError);
      expect((e as TargetSelectionError).code).toBe('NOT_FOUND');
      expect((e as TargetSelectionError).message).toBe('Bien, pièce ou équipement introuvable');
      expect((e as TargetSelectionError).refs).toEqual(['asset:999', 'equipment:888']);
    }
  });
});

describe('L111I-U-PLAN — implications et principal', () => {
  it('équipement → son bien et sa pièce (impliqués, jamais matérialisés) ; pièce → son bien', () => {
    const r = resolveSelection({ assetIds: [], roomIds: [21], equipmentIds: [101, 102] }, cat);
    expect(r.impliedAssetIds).toEqual([1, 2]);
    expect(r.impliedRoomIds).toEqual([11]);
    expect(r.effectiveAssetIds).toEqual([1, 2]);
  });
  it('photo cuisine → Four ET Micro-onde : principal = bien 1, cuisine, Four (premier) ; principal actuel conservé', () => {
    const r = resolveSelection({ assetIds: [1], roomIds: [11], equipmentIds: [101, 102] }, cat);
    expect(principalColumns(cols(), r, cat)).toEqual(cols({ assetId: 1, substructureId: 11, equipmentId: 101 }));
    // Micro-onde déjà principal : il le reste (aucun déplacement silencieux).
    expect(principalColumns(cols({ assetId: 1, equipmentId: 102 }), r, cat)).toMatchObject({ assetId: 1, equipmentId: 102 });
  });
  it('contrat deux biens : principal = bien actuel s’il reste choisi ; triplet toujours sur UN bien', () => {
    const r = resolveSelection({ assetIds: [2, 1], roomIds: [21, 11], equipmentIds: [201] }, cat);
    const c = principalColumns(cols({ assetId: 1 }), r, cat);
    expect(c).toEqual(cols({ assetId: 1, substructureId: 11, equipmentId: null }));
    const c2 = principalColumns(cols(), r, cat);
    expect(c2).toEqual(cols({ assetId: 2, substructureId: 21, equipmentId: 201 }));
  });
  it('tout retiré : colonnes vidées ; linked_asset_id gardé seulement s’il reste choisi', () => {
    expect(principalColumns(cols({ assetId: 1, equipmentId: 101 }), resolveSelection({ assetIds: [], roomIds: [], equipmentIds: [] }, cat), cat)).toEqual(cols());
    expect(principalColumns(cols({ assetId: 1, linkedAssetId: 2 }), resolveSelection({ assetIds: [1, 2], roomIds: [], equipmentIds: [] }, cat), cat).linkedAssetId).toBe(2);
    expect(principalColumns(cols({ assetId: 1, linkedAssetId: 2 }), resolveSelection({ assetIds: [1], roomIds: [], equipmentIds: [] }, cat), cat).linkedAssetId).toBeNull();
  });
});

describe('L111I-U-PLAN — écart des liens (retrait = dissociation, USER prime)', () => {
  it('ajoute les cibles non couvertes ; ne retire JAMAIS un LEGACY_COLUMN ni un MENTIONED', () => {
    const actifs = [
      link({ assetId: 1, origin: 'LEGACY_COLUMN', linkRole: 'PRIMARY' }),
      link({ assetId: 1, equipmentId: 101, origin: 'LEGACY_COLUMN' }),
      link({ assetId: 2, origin: 'AI', linkRole: 'MENTIONED' }),
    ];
    const d = diffLinks(actifs, resolveSelection({ assetIds: [1], roomIds: [], equipmentIds: [101, 102] }, cat), cat, 'replace');
    expect(d.remove).toEqual([]);
    expect(d.add).toEqual([{ assetId: 1, substructureId: null, equipmentId: 102 }]);
  });
  it('retire un lien AI / USER non désiré ; mode « add » ne retire rien', () => {
    const ai = link({ assetId: 1, equipmentId: 103, origin: 'AI' });
    const user = link({ assetId: 2, origin: 'USER' });
    const r = resolveSelection({ assetIds: [1], roomIds: [], equipmentIds: [] }, cat);
    expect(diffLinks([ai, user], r, cat, 'replace').remove.map((l) => l.id)).toEqual([ai.id, user.id]);
    expect(diffLinks([ai, user], r, cat, 'add').remove).toEqual([]);
  });
  it('un lien MENTIONED d’une cible choisie est PROMU (une citation devient un rattachement choisi)', () => {
    const cite = link({ assetId: 2, origin: 'AI', linkRole: 'MENTIONED' });
    const d = diffLinks([cite], resolveSelection({ assetIds: [2], roomIds: [], equipmentIds: [] }, cat), cat, 'replace');
    expect(d.promote.map((l) => l.id)).toEqual([cite.id]);
    expect(d.add).toEqual([]);
  });
  it('pièce historique `rooms` : gardée tant que son bien reste effectif', () => {
    const r = link({ assetId: 1, roomId: 5, origin: 'MIGRATION' });
    expect(diffLinks([r], resolveSelection({ assetIds: [], roomIds: [], equipmentIds: [101] }, cat), cat, 'replace').remove).toEqual([]);
    expect(diffLinks([r], resolveSelection({ assetIds: [2], roomIds: [], equipmentIds: [] }, cat), cat, 'replace').remove).toEqual([r]);
  });
  it('clé de cible : l’équipement prime sur la pièce, la pièce sur le bien', () => {
    expect(linkKey({ assetId: 1, roomId: null, substructureId: 11, equipmentId: 101 })).toBe('E:101');
    expect(linkKey({ assetId: 1, roomId: null, substructureId: 11, equipmentId: null })).toBe('S:11');
    expect(linkKey({ assetId: 1, roomId: null, substructureId: null, equipmentId: null })).toBe('A:1');
  });
  it('sélection actuelle : colonnes d’abord, puis liens PRIMARY / SECONDARY (MENTIONED exclu)', () => {
    const sel = currentSelection(cols({ assetId: 1, equipmentId: 101 }), [
      link({ assetId: 1, equipmentId: 102, origin: 'USER' }), link({ assetId: 2, origin: 'AI', linkRole: 'MENTIONED' }),
      link({ assetId: 2, origin: 'AI', linkRole: 'SECONDARY' }),
    ]);
    expect(sel).toEqual({ assetIds: [1, 2], roomIds: [], equipmentIds: [101, 102] });
  });
  it('provenance : USER (lien USER ou colonne marquée) > IA > historique', () => {
    expect(provenanceOf(['LEGACY_COLUMN'], true, true)).toBe('USER');
    expect(provenanceOf(['LEGACY_COLUMN'], false, true)).toBe('HISTORY');
    expect(provenanceOf(['AI'], false, false)).toBe('AI');
    expect(provenanceOf(['AI', 'USER'], false, false)).toBe('USER');
    expect(provenanceOf(['MIGRATION'], false, false)).toBe('HISTORY');
  });
});

describe('L111I-U-TCO — facture couvrant plusieurs équipements', () => {
  const prix = [{ equipmentId: 101, eurMinor: 60000, date: '2026-03-01' }, { equipmentId: 102, eurMinor: 40000, date: '2026-03-01' }];
  it('somme EXACTE des prix des fiches, dates compatibles : chaque prix couvert par la facture', () => {
    const m = multiEquipmentPurchaseCoverage([{ fileId: 7, eurMinor: 100000, date: '2026-03-02', linkedEquipmentIds: [101, 102] }], prix);
    expect([...m.entries()]).toEqual([[101, 7], [102, 7]]);
  });
  it('somme différente, prix manquant, un seul équipement ou dates éloignées : rien (comportement antérieur)', () => {
    expect(multiEquipmentPurchaseCoverage([{ fileId: 7, eurMinor: 99000, date: '2026-03-02', linkedEquipmentIds: [101, 102] }], prix).size).toBe(0);
    expect(multiEquipmentPurchaseCoverage([{ fileId: 7, eurMinor: 100000, date: '2026-03-02', linkedEquipmentIds: [101, 102, 103] }], prix).size).toBe(0);
    expect(multiEquipmentPurchaseCoverage([{ fileId: 7, eurMinor: 60000, date: '2026-03-02', linkedEquipmentIds: [101] }], prix).size).toBe(0);
    expect(multiEquipmentPurchaseCoverage([{ fileId: 7, eurMinor: 100000, date: '2024-01-01', linkedEquipmentIds: [101, 102] }], prix).size).toBe(0);
  });
  it('deux factures candidates pour un même équipement : aucune rapprochée (tout ou rien)', () => {
    const m = multiEquipmentPurchaseCoverage([
      { fileId: 7, eurMinor: 100000, date: '2026-03-02', linkedEquipmentIds: [101, 102] },
      { fileId: 8, eurMinor: 100000, date: '2026-03-02', linkedEquipmentIds: [102, 101] },
    ], prix);
    expect(m.size).toBe(0);
  });
});

describe('L111I-U-UI — sélection côté écran', () => {
  const groups: TargetOptionGroupView[] = [
    { asset: { id: 1, name: 'T3 Annecy', category: 'IMMOBILIER', writable: true }, rooms: [{ id: 11, name: 'Cuisine' }],
      equipments: [{ id: 101, name: 'Four', roomId: 11 }, { id: 102, name: 'Micro-onde', roomId: 11 }] },
    { asset: { id: 2, name: 'Garage', category: 'IMMOBILIER', writable: true }, rooms: [], equipments: [{ id: 201, name: 'Compresseur', roomId: null }] },
  ];
  it('implications affichées « via » ; retirer un bien retire ses pièces et équipements', () => {
    const v = { assetIds: [], roomIds: [], equipmentIds: [101, 102] };
    expect(impliedTargets(groups, v)).toEqual({ assets: [{ id: 1, via: 'Four', viaKind: 'equipment' }], rooms: [{ id: 11, via: 'Four', viaKind: 'equipment' }] });
    expect(impliedTargets(groups, { assetIds: [], roomIds: [11], equipmentIds: [] }).assets).toEqual([{ id: 1, via: 'Cuisine', viaKind: 'room' }]);
    // Décision PO 05/11 : libellés des cibles déduites.
    expect(impliedLabel('equipment', 'Four')).toBe('par l’équipement Four');
    expect(impliedLabel('room', 'Cuisine')).toBe('par la pièce Cuisine');
    expect(removeAsset(groups, { assetIds: [1, 2], roomIds: [11], equipmentIds: [101, 201] }, 1)).toEqual({ assetIds: [2], roomIds: [], equipmentIds: [201] });
    expect(removeRoom(groups, { assetIds: [], roomIds: [11], equipmentIds: [101, 201] }, 11)).toEqual({ assetIds: [], roomIds: [], equipmentIds: [201] });
  });
  it('principal d’un dépôt = même règle que le serveur ; cibles complémentaires détectées', () => {
    const v = { assetIds: [], roomIds: [11], equipmentIds: [101, 102] };
    const p = principalOf(groups, v);
    expect(p).toEqual({ assetId: 1, roomId: 11, equipmentId: 101 });
    expect(hasExtraTargets(v, p)).toBe(true);
    expect(hasExtraTargets({ assetIds: [1], roomIds: [11], equipmentIds: [101] }, p)).toBe(false);
  });
  it('lecture de la vue serveur (cibles impliquées exclues) ; filtre sans accents', () => {
    expect(valueFromTargetsView({ assets: [{ id: 1, implied: true }, { id: 2, implied: false }], rooms: [{ id: 11, implied: true }], equipments: [{ id: 101 }] }))
      .toEqual({ assetIds: [2], roomIds: [], equipmentIds: [101] });
    expect(matchesFilter('Micro-onde', 'micro')).toBe(true);
    expect(matchesFilter('Équipement', 'equip')).toBe(true);
    expect(matchesFilter('Four', 'tv')).toBe(false);
  });
});
