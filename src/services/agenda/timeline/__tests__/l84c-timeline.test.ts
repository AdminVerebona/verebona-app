/**
 * Lot 84C — Timeline d'un bien (CDC v5 §13, AC22–AC26, E10) : règles pures,
 * assemblage d'une page, forme de la requête. La base réelle : e2e
 * `l84c-timeline-v5.e2e.ts`.
 *
 *   L84C-U01  mode : défaut « regroupée », valeurs inconnues refusées (AC22)
 *   L84C-U02  curseur : aller-retour, mode croisé et contenu illisible refusés
 *   L84C-U03  limite de page bornée
 *   L84C-U04  états d'affichage inchangés (47B / 53 D17), date de référence injectée
 *   L84C-U05  ordre : date décroissante, sans date en dernier, puis identifiant
 *   L84C-U06  page regroupée : groupe = principal + éléments liés + compteurs ; curseur suivant
 *   L84C-U07  page détaillée : aucune requête de groupe, aucun groupe (AC23)
 *   L84C-U08  requête : regroupement (fenêtre par Opération) AVANT la pagination (E10),
 *             annulés exclus, compte filtré, principal daté seulement (AC25)
 *   L84C-U09  compteurs : cinq compteurs distincts, objets du compte seulement (AC26)
 *   L84C-U10  libellés : pluriels, aucun « Opération » (P1)
 *   L84C-U11  lecture complète (export) : toutes les pages, même fonction
 *   L84C-U12  cohérence globale : domaine « timeline » couvert par les invariants O-1 (C-Q11)
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIMELINE_MODE, TIMELINE_PAGE_DEFAULT, TIMELINE_PAGE_MAX, clampTimelineLimit, compareTimelineItems, decodeTimelineCursor,
  encodeTimelineCursor, parseTimelineMode, timelineItemView,
} from '../model';
import { TIMELINE_COUNTERS_SQL, TIMELINE_MEMBERS_SQL, TIMELINE_PAGE_SQL, readAssetTimelineAll, readAssetTimelinePage, type TimelineQuery } from '../read';
import { TIMELINE_MODE_LABELS, counterLabel, visibleCounters } from '../labels';

const row = (id: number, start: string | null, extra: Record<string, unknown> = {}) => ({
  id, title: `Élément ${id}`, start_date: start, manual_status: null, origin_field_key: null, event_nature: null, business_type: null, ...extra,
});

describe('L84C — Timeline : règles pures', () => {
  it('L84C-U01 — mode par défaut « regroupée » ; inconnu refusé', () => {
    expect(DEFAULT_TIMELINE_MODE).toBe('grouped');
    expect(parseTimelineMode(null)).toBe('grouped');
    expect(parseTimelineMode('')).toBe('grouped');
    expect(parseTimelineMode('detailed')).toBe('detailed');
    expect(parseTimelineMode('operations')).toBeNull();
  });

  it('L84C-U02 — curseur : aller-retour ; autre mode, date ou id invalides refusés', () => {
    const c = { mode: 'grouped' as const, sortDate: '2026-03-12', id: 42 };
    expect(decodeTimelineCursor(encodeTimelineCursor(c), 'grouped')).toEqual(c);
    const sansDate = { mode: 'detailed' as const, sortDate: '-infinity', id: 7 };
    expect(decodeTimelineCursor(encodeTimelineCursor(sansDate), 'detailed')).toEqual(sansDate);
    expect(decodeTimelineCursor(encodeTimelineCursor(c), 'detailed')).toBe('INVALID');
    expect(decodeTimelineCursor(null, 'grouped')).toBeNull();
    expect(decodeTimelineCursor('nimporte', 'grouped')).toBe('INVALID');
    const forge = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    expect(decodeTimelineCursor(forge(['g', "2026-01-01'; DROP", 1]), 'grouped')).toBe('INVALID');
    expect(decodeTimelineCursor(forge(['g', '2026-01-01', -1]), 'grouped')).toBe('INVALID');
    expect(decodeTimelineCursor(forge(['g', '2026-01-01', 1.5]), 'grouped')).toBe('INVALID');
  });

  it('L84C-U03 — limite bornée', () => {
    expect(clampTimelineLimit(null)).toBe(TIMELINE_PAGE_DEFAULT);
    expect(clampTimelineLimit('0')).toBe(TIMELINE_PAGE_DEFAULT);
    expect(clampTimelineLimit('5')).toBe(5);
    expect(clampTimelineLimit('100000')).toBe(TIMELINE_PAGE_MAX);
  });

  it('L84C-U04 — états : échéance passée en retard, fait passé à confirmer, réalisé établi', () => {
    const today = '2026-06-01';
    expect(timelineItemView(row(1, '2026-05-01'), today)).toMatchObject({ itemType: 'agenda', id: '1', isOverdue: true, toConfirm: false, isDone: false });
    expect(timelineItemView(row(2, '2026-05-01', { event_nature: 'HISTORICAL' }), today)).toMatchObject({ isOverdue: false, toConfirm: true });
    expect(timelineItemView(row(3, '2026-05-01', { manual_status: 'realise' }), today)).toMatchObject({ isDone: true, isOverdue: false, toConfirm: false });
    expect(timelineItemView(row(4, null), today)).toMatchObject({ effectiveDate: null, isOverdue: false, toConfirm: false });
    // Date de référence injectée : rien ne dépend du jour réel.
    expect(timelineItemView(row(1, '2026-05-01'), '2026-04-01').isOverdue).toBe(false);
  });

  it('L84C-U05 — ordre de la Timeline', () => {
    const l = [
      { id: '1', effectiveDate: '2026-01-01' }, { id: '2', effectiveDate: null }, { id: '3', effectiveDate: '2026-05-01' },
      { id: '4', effectiveDate: '2026-05-01' }, { id: '5', effectiveDate: null },
    ].sort(compareTimelineItems);
    expect(l.map((x) => x.id)).toEqual(['4', '3', '1', '5', '2']);
  });

  it('L84C-U10 — libellés : pluriels, aucun mot « Opération »', () => {
    expect(counterLabel('events', 1)).toBe('1 événement lié');
    expect(counterLabel('events', 3)).toBe('3 événements liés');
    expect(counterLabel('rooms', 2)).toBe('2 pièces');
    expect(visibleCounters({ events: 2, documents: 0, assets: 1, rooms: 0, equipments: 3 }).map((c) => c.label))
      .toEqual(['2 événements liés', '1 bien', '3 équipements']);
    expect(Object.values(TIMELINE_MODE_LABELS)).toEqual(['Regroupée', 'Détaillée']);
    const tout = JSON.stringify([TIMELINE_MODE_LABELS, ...(['events', 'documents', 'assets', 'rooms', 'equipments'] as const).map((k) => counterLabel(k, 2))]);
    expect(tout).not.toMatch(/op[ée]ration/i);
  });
});

describe('L84C — Timeline : requête et assemblage', () => {
  it('L84C-U08 — regroupement par fenêtre AVANT LIMIT ; annulés exclus ; compte filtré ; principal DATÉ ; Opération active', () => {
    const sql = TIMELINE_PAGE_SQL.replace(/\s+/g, ' ');
    const fenetre = sql.indexOf('OVER (PARTITION BY i.op)');
    const limite = sql.lastIndexOf('LIMIT $6');
    expect(fenetre).toBeGreaterThan(0);
    expect(limite).toBeGreaterThan(fenetre);
    expect(sql.match(/LIMIT/g)).toHaveLength(1);
    expect(sql).toContain("FILTER (WHERE i.role = 'PRINCIPAL' AND i.d IS NOT NULL)");
    expect(sql).toContain("(ai.manual_status IS NULL OR ai.manual_status <> 'annule')");
    expect(sql).toContain('aal.asset_id = $2 AND ai.account_id = $1');
    expect(sql).toContain('bo.id = ai.business_operation_id AND bo.account_id = ai.account_id AND bo.invalidated_at IS NULL');
    expect(sql).toContain("WHERE $3 = 'detailed' OR h.head IS NULL OR h.head = h.id");
    expect(sql).toContain('(e.sort_date, e.id) < ($4::date, $5::int)');
    expect(sql).toContain('ORDER BY e.sort_date DESC, e.id DESC');
    expect(TIMELINE_MEMBERS_SQL).toContain('aal.asset_id = $2');
    expect(TIMELINE_MEMBERS_SQL).toContain("ai.manual_status <> 'annule'");
  });

  it('L84C-U09 — compteurs : cinq compteurs, hors principal, objets du compte seulement', () => {
    const sql = TIMELINE_COUNTERS_SQL.replace(/\s+/g, ' ');
    for (const c of ['events', 'documents', 'assets', 'rooms', 'equipments']) expect(sql).toContain(`AS ${c}`);
    expect(sql).toContain('x.id <> g.head');
    expect(sql).toContain('f.account_id = $1 AND f.deleted_at IS NULL');
    expect(sql.match(/a\.account_id = \$1 AND a\.deleted_at IS NULL/g)).toHaveLength(3);
    expect(sql).toContain('d.active');
  });

  function fakeQ(pageRows: Record<string, unknown>[], members: Record<string, unknown>[] = [], counters: Record<string, unknown>[] = []) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const q: TimelineQuery = async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql === TIMELINE_PAGE_SQL) return pageRows;
      if (sql === TIMELINE_MEMBERS_SQL) return members;
      if (sql === TIMELINE_COUNTERS_SQL) return counters;
      throw new Error('requête inattendue');
    };
    return { q, calls };
  }

  it('L84C-U06 — page regroupée : groupe complet, compteurs, curseur suivant sur la dernière entrée servie', async () => {
    const page = [
      { ...row(10, '2026-04-18'), op: null, is_head: false, sort_key: '2026-04-18', remaining: 4 },
      { ...row(11, '2026-03-12', { title: 'Dégât des eaux' }), op: 900, is_head: true, sort_key: '2026-03-12', remaining: 4 },
      { ...row(12, null), op: null, is_head: false, sort_key: '-infinity', remaining: 4 },
    ];
    const { q, calls } = fakeQ(page,
      [{ ...row(21, '2026-03-21', { title: 'Visite expert' }), op: 900 }, { ...row(22, '2026-04-02', { title: 'Réparation plafond' }), op: 900 }, { ...row(23, null), op: 900 }],
      [{ op: 900, events: 4, documents: 5, assets: 1, rooms: 1, equipments: 0 }]);
    const p = await readAssetTimelinePage({ accountId: 1, assetId: 2, limit: 2, today: '2026-06-01', q });
    expect(calls[0].params).toEqual([1, 2, 'grouped', null, null, 3]);
    expect(p.mode).toBe('grouped');
    expect(p.entries).toHaveLength(2);
    expect(p.remaining).toBe(4);
    expect(p.entries[0]).toMatchObject({ kind: 'item', id: '10' });
    const g = p.entries[1];
    expect(g).toMatchObject({ kind: 'group', id: '11', title: 'Dégât des eaux', counters: { events: 4, documents: 5, assets: 1, rooms: 1, equipments: 0 } });
    // Éléments liés triés comme la Timeline (date décroissante, sans date en dernier).
    expect(g.kind === 'group' && g.members.map((m) => m.id)).toEqual(['22', '21', '23']);
    expect(calls.find((c) => c.sql === TIMELINE_MEMBERS_SQL)!.params).toEqual([1, 2, [900], [11]]);
    expect(decodeTimelineCursor(p.nextCursor, 'grouped')).toEqual({ mode: 'grouped', sortDate: '2026-03-12', id: 11 });

    // Page suivante : le curseur est transmis tel quel à la requête.
    const suite = fakeQ([{ ...row(12, null), op: null, is_head: false, sort_key: '-infinity', remaining: 1 }]);
    const p2 = await readAssetTimelinePage({ accountId: 1, assetId: 2, limit: 2, today: '2026-06-01', q: suite.q, cursor: decodeTimelineCursor(p.nextCursor, 'grouped') as never });
    expect(suite.calls[0].params).toEqual([1, 2, 'grouped', '2026-03-12', 11, 3]);
    expect(p2.nextCursor).toBeNull();
    expect(suite.calls).toHaveLength(1);
  });

  it('L84C-U07 — page détaillée : aucun groupe, aucune requête de membres ni de compteurs', async () => {
    const { q, calls } = fakeQ([
      { ...row(11, '2026-03-12'), op: 900, is_head: false, sort_key: '2026-03-12', remaining: 2 },
      { ...row(21, '2026-03-21'), op: 900, is_head: false, sort_key: '2026-03-21', remaining: 2 },
    ]);
    const p = await readAssetTimelinePage({ accountId: 1, assetId: 2, mode: 'detailed', today: '2026-06-01', q });
    expect(p.entries.every((e) => e.kind === 'item')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].params[2]).toBe('detailed');
  });

  it('L84C-U11 — lecture complète : enchaîne les pages par curseur', async () => {
    let n = 0;
    const q: TimelineQuery = async (sql, params = []) => {
      if (sql !== TIMELINE_PAGE_SQL) return [];
      n++;
      const all = [5, 4, 3, 2, 1].map((id) => ({ ...row(id, `2026-01-0${id}`), op: null, is_head: false, sort_key: `2026-01-0${id}`, remaining: 0 }));
      const after = params[4] === null ? all : all.filter((r) => r.id < Number(params[4]));
      return after.slice(0, Number(params[5]));
    };
    const all = await readAssetTimelineAll({ accountId: 1, assetId: 2, mode: 'detailed', today: '2026-06-01', q, pageSize: 2 });
    expect(all.map((e) => e.id)).toEqual(['5', '4', '3', '2', '1']);
    expect(n).toBe(3);
  });
});

describe('L84C — cohérence globale (C-Q11)', () => {
  it('L84C-U12 — domaine « timeline » : calcul sans état ; entrées couvertes par les invariants O-1 actifs', async () => {
    const { COVERAGE_INVENTORY } = await import('@/services/coherence/registry/coverage');
    const t = COVERAGE_INVENTORY.find((e) => e.domain === 'timeline')!;
    expect([...t.checks].sort()).toEqual(['COH-O1-AGENDA-ONE-OPERATION', 'COH-O1-PRINCIPAL-UNIQUE']);
    expect(t.gap?.existingMechanism).toContain('services/agenda/timeline');
  });
});
