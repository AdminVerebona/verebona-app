/**
 * Reprise des pièces `rooms` → `substructures` (D-G, lot 20) — règles pures
 * et arguments du script. Le parcours en base est couvert par
 * `src/test/e2e/scenarios/d-g-pieces-sous-structures.e2e.ts`.
 */
import { describe, expect, it } from 'vitest';
import { chooseSubstructure, fillFromRoom, normalizeRoomName, restoreOrder, sameJson } from '../plan';
import { parseRoomsMergeArgs } from '../cli';

describe('rapprochement par nom', () => {
  it('normalise casse, accents, apostrophes et espaces', () => {
    expect(normalizeRoomName('  Salle  d’Eau ')).toBe('salle d eau');
    expect(normalizeRoomName('SÉJOUR')).toBe(normalizeRoomName('sejour'));
    expect(normalizeRoomName(null)).toBe('');
  });

  it('relance : la sous-structure déjà reprise est retrouvée, même renommée', () => {
    expect(chooseSubstructure({ id: 4, name: 'Cuisine' }, [
      { id: 10, name: 'Cuisine', legacyRoomId: null }, { id: 11, name: 'Coin repas', legacyRoomId: 4 },
    ])).toEqual({ kind: 'existing', substructureId: 11 });
  });

  it('une seule sous-structure libre de même nom : rapprochée', () => {
    expect(chooseSubstructure({ id: 4, name: 'séjour' }, [
      { id: 10, name: 'Séjour', legacyRoomId: null }, { id: 12, name: 'Chambre', legacyRoomId: null },
    ])).toEqual({ kind: 'map', substructureId: 10 });
  });

  it('jamais une sous-structure déjà associée à une autre pièce (un pour un)', () => {
    expect(chooseSubstructure({ id: 5, name: 'Chambre' }, [{ id: 12, name: 'Chambre', legacyRoomId: 4 }]))
      .toEqual({ kind: 'create', ambiguous: false, candidates: [] });
  });

  it('plusieurs homonymes : création, signalée ambiguë ; aucun : création', () => {
    expect(chooseSubstructure({ id: 4, name: 'Chambre' }, [
      { id: 10, name: 'chambre', legacyRoomId: null }, { id: 11, name: 'CHAMBRE', legacyRoomId: null },
    ])).toEqual({ kind: 'create', ambiguous: true, candidates: [10, 11] });
    expect(chooseSubstructure({ id: 4, name: 'Grenier' }, [])).toEqual({ kind: 'create', ambiguous: false, candidates: [] });
  });

  it('colonnes recopiées sur une sous-structure rapprochée : seulement les vides', () => {
    expect(fillFromRoom(
      { room_type: null, area: '12', description: '', key_characteristics: {} },
      { room_type: 'BEDROOM', area: '14', description: 'Nord', key_characteristics: { roomArea: 14 } },
    )).toEqual({ room_type: 'BEDROOM', description: 'Nord', key_characteristics: { roomArea: 14 } });
    expect(fillFromRoom(
      { room_type: 'X', area: '1', description: 'd', key_characteristics: { a: 1 } },
      { room_type: 'Y', area: '2', description: 'e', key_characteristics: { b: 2 } },
    )).toEqual({});
  });
});

describe('restauration', () => {
  it('liens N-N d’abord, sous-structures en dernier, sinon du plus récent au plus ancien', () => {
    const c = (id: number, table_name: string) => ({ id, table_name });
    expect(restoreOrder([c(1, 'substructures'), c(2, 'field_evidence'), c(3, 'document_asset_links'), c(4, 'asset_files'),
      c(5, 'document_asset_links')]).map((x) => x.id)).toEqual([5, 3, 4, 2, 1]);
  });

  it('comparaison JSON indépendante de l’ordre des clés', () => {
    expect(sameJson({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameJson(null, undefined)).toBe(true);
  });
});

describe('arguments du script', () => {
  it('simulation par défaut ; --dry-run explicite ; --apply', () => {
    expect(parseRoomsMergeArgs([])).toMatchObject({ kind: 'run', apply: false, dbReport: true, accountId: null, batch: 100 });
    expect(parseRoomsMergeArgs(['--dry-run'])).toMatchObject({ kind: 'run', apply: false });
    expect(parseRoomsMergeArgs(['--apply', '--account=12', '--limit', '5'])).toMatchObject({ kind: 'run', apply: true, accountId: 12, limit: 5 });
    expect(parseRoomsMergeArgs(['--no-db-report', '--json', 'out.json'])).toMatchObject({ dbReport: false, json: 'out.json' });
  });

  it('rapport et restauration : identifiant d’exécution UUID', () => {
    const id = '0d3f6f5e-8f2a-4c41-9d7b-2a1b3c4d5e6f';
    expect(parseRoomsMergeArgs(['--restore', id])).toEqual({ kind: 'restore', runId: id });
    expect(parseRoomsMergeArgs(['--report', id, '--samples', '5'])).toEqual({ kind: 'report', runId: id, samples: 5 });
    expect(parseRoomsMergeArgs(['--restore', 'abc']).kind).toBe('error');
  });

  it('refuse les combinaisons et valeurs invalides', () => {
    expect(parseRoomsMergeArgs(['--apply', '--dry-run']).kind).toBe('error');
    expect(parseRoomsMergeArgs(['--restore', '0d3f6f5e-8f2a-4c41-9d7b-2a1b3c4d5e6f', '--apply']).kind).toBe('error');
    expect(parseRoomsMergeArgs(['--account', '-1']).kind).toBe('error');
    expect(parseRoomsMergeArgs(['--inconnue', '1']).kind).toBe('error');
    expect(parseRoomsMergeArgs(['apply']).kind).toBe('error');
    expect(parseRoomsMergeArgs(['--help']).kind).toBe('help');
  });
});
