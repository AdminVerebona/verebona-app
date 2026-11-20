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
 *   L84C-U06  page regroupée : groupe = événement de référence + éléments réels + compteurs ; curseur typé
 *             (règle remplacée, carte #744 lot C : plus de « principal »)
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
import {
  TIMELINE_COUNTERS_SQL, TIMELINE_ITEM_OPERATIONS_SQL, TIMELINE_MEMBERS_SQL, TIMELINE_OPERATION_LABELS_SQL, TIMELINE_PAGE_SQL,
  readAssetTimelineAll, readAssetTimelinePage, type TimelineQuery,
} from '../read';
import { TIMELINE_MODE_LABELS, counterLabel, visibleCounters } from '../labels';

const row = (id: number, start: string | null, extra: Record<string, unknown> = {}) => ({
  id, title: `Élément ${id}`, start_date: start, origin_field_key: null, event_nature: null, business_type: null, ...extra,
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
    // #744 lot C : curseur d'une entrée « événement de référence » (mode regroupé seulement) ; curseur d'élément inchangé.
    const groupe = { mode: 'grouped' as const, sortDate: '2026-03-12', id: 900, kind: 'group' as const };
    expect(decodeTimelineCursor(encodeTimelineCursor(groupe), 'grouped')).toEqual(groupe);
    expect(encodeTimelineCursor(c)).toBe(forge(['g', '2026-03-12', 42]));
    expect(decodeTimelineCursor(forge(['d', '2026-01-01', 1, 'o']), 'detailed')).toBe('INVALID');
    expect(decodeTimelineCursor(forge(['g', '2026-01-01', 1, 'x']), 'grouped')).toBe('INVALID');
  });

  it('L84C-U03 — limite bornée', () => {
    expect(clampTimelineLimit(null)).toBe(TIMELINE_PAGE_DEFAULT);
    expect(clampTimelineLimit('0')).toBe(TIMELINE_PAGE_DEFAULT);
    expect(clampTimelineLimit('5')).toBe(5);
    expect(clampTimelineLimit('100000')).toBe(TIMELINE_PAGE_MAX);
  });

  // #715 (lot 113P) : plus d'états (« en retard », « à confirmer », « réalisé ») — la vue ne porte que la date.
  it('L84C-U04 — #715 : aucun état d’exécution, seulement la date', () => {
    const today = '2026-06-01';
    expect(timelineItemView(row(1, '2026-05-01'), today)).toEqual({ itemType: 'agenda', id: '1', title: expect.any(String), effectiveDate: '2026-05-01' });
    expect(timelineItemView(row(2, '2026-05-01', { event_nature: 'HISTORICAL' }), today)).not.toHaveProperty('toConfirm');
    expect(timelineItemView(row(4, null), today)).toMatchObject({ effectiveDate: null });
    for (const k of ['isDone', 'isOverdue', 'toConfirm', 'effectiveStatus']) expect(timelineItemView(row(1, '2026-05-01'), today)).not.toHaveProperty(k);
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
    // Règle remplacée (carte #806, décision du PO du 17/11/2026) : la garde interdisait « Opération » ; à l’écran on dit désormais « opération », et c’est « événement de référence » qui est interdit.
    expect(tout).not.toMatch(/[ée]v[éeè]nements?\s+de\s+r[ée]f[ée]rence/i);
  });
});

describe('L84C — Timeline : requête et assemblage', () => {
  // Règle remplacée (carte #744, lot C) : le regroupement ne se fait plus par fenêtre sur le rôle « principal » daté
  // ni sur la colonne historique ; il lit le graphe canonique N↔N et produit une entrée par événement de référence.
  it('L84C-U08 — règle remplacée (carte #744) : regroupement par le graphe AVANT LIMIT ; compte filtré ; ni rôle, ni colonne historique', () => {
    const sql = TIMELINE_PAGE_SQL.replace(/\s+/g, ' ');
    const groupes = sql.indexOf('FROM ops o');
    const limite = sql.lastIndexOf('LIMIT $6');
    expect(groupes).toBeGreaterThan(0);
    expect(limite).toBeGreaterThan(groupes);
    expect(sql.match(/LIMIT/g)).toHaveLength(1);
    // Plus aucune dépendance au « principal » ni à la colonne historique (AC40).
    for (const lecture of [TIMELINE_PAGE_SQL, TIMELINE_MEMBERS_SQL, TIMELINE_COUNTERS_SQL, TIMELINE_ITEM_OPERATIONS_SQL, TIMELINE_OPERATION_LABELS_SQL]) {
      expect(lecture).not.toMatch(/PRINCIPAL|operation_role|business_operation_id|manual_status/);
    }
    expect(sql).toContain('aal.asset_id = $2 AND ai.account_id = $1');
    // Liens du graphe, actifs, vers un événement de référence actif du même compte.
    expect(sql).toContain("JOIN business_operation_agenda_links l ON l.account_id = $1 AND l.agenda_item_id = i.id AND l.state = 'ACTIVE'");
    expect(sql).toContain('(SELECT bo.id FROM business_operations bo WHERE bo.id = l.operation_id AND bo.account_id = $1 AND bo.invalidated_at IS NULL AND bo.merged_into_operation_id IS NULL) IS NOT NULL');
    // Événement de référence relié au bien, même sans élément d'agenda (AC26) ; jamais un parcours de tous.
    expect(sql).toContain("FROM business_operation_asset_links b WHERE $3 = 'grouped' AND b.asset_id = $2 AND b.account_id = $1 AND b.active");
    // Chaque lecture d'un événement de référence passe par sa clé primaire (sous-requête scalaire), jamais par une jointure.
    expect(sql).not.toMatch(/JOIN business_operations/);
    expect(sql.match(/FROM business_operations bo WHERE bo\.id = /g)).toHaveLength(2);
    // Règle remplacée (carte #744, point F) : le repère est la DATE DE PRÉSENTATION du CDC §11, lue par UNE sous-requête
    // scalaire sur la clé primaire (compte filtré, événement actif) — plus « date propre, sinon plus ancien élément lié ».
    expect(sql.match(/FROM business_operations pdo WHERE pdo\.id = x\.op AND pdo\.account_id = \$1 AND pdo\.invalidated_at IS NULL AND pdo\.merged_into_operation_id IS NULL/g)).toHaveLength(1);
    expect(sql).toContain("split_part(y.pd, '|', 1)::date AS d, split_part(y.pd, '|', 2) AS basis FROM op_pd y");
    expect(sql).not.toMatch(/own_d|event_d|FIRST_EVENT|min\(k\.d\)/);
    // Aucune date système (AC35).
    expect(sql).not.toMatch(/created_at|updated_at|now\(\)|CURRENT_DATE/i);
    // Mode détaillé : tous les éléments, une fois ; mode regroupé : seulement les éléments sans lien actif.
    expect(sql).toContain("WHERE $3 = 'detailed' OR i.id NOT IN (SELECT k.item_id FROM links k)");
    // Pagination d'identités typées, tri stable (AC38).
    expect(sql).toContain('(e.sort_date, e.rank, e.id) < ($4::date, $7::int, $5::bigint)');
    expect(sql).toContain('ORDER BY e.sort_date DESC, e.rank DESC, e.id DESC');
    expect(TIMELINE_MEMBERS_SQL).toContain('aal.asset_id = $2');
    expect(TIMELINE_MEMBERS_SQL).toContain("l.state = 'ACTIVE'");
    expect(TIMELINE_MEMBERS_SQL).not.toMatch(/LIMIT/);
  });

  it('L84C-U09 — règle remplacée (carte #744) : cinq compteurs, appartenance à l’opération, objets du compte seulement', () => {
    const sql = TIMELINE_COUNTERS_SQL.replace(/\s+/g, ' ');
    for (const c of ['events', 'documents', 'assets', 'rooms', 'equipments']) expect(sql).toContain(`AS ${c}`);
    expect(sql).not.toContain('g.head');
    expect(sql).toContain('f.account_id = $1 AND f.deleted_at IS NULL');
    expect(sql.match(/a\.account_id = \$1 AND a\.deleted_at IS NULL/g)).toHaveLength(3);
    expect(sql).toContain('d.active');
    expect(sql).toContain("l.state = 'ACTIVE'");
  });

  function fakeQ(pageRows: Record<string, unknown>[], members: Record<string, unknown>[] = [], counters: Record<string, unknown>[] = [],
    itemOps: Record<string, unknown>[] = [], titles: Record<string, unknown>[] = []) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const q: TimelineQuery = async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql === TIMELINE_PAGE_SQL) return pageRows;
      if (sql === TIMELINE_MEMBERS_SQL) return members;
      if (sql === TIMELINE_COUNTERS_SQL) return counters;
      if (sql === TIMELINE_ITEM_OPERATIONS_SQL) return itemOps;
      if (sql === TIMELINE_OPERATION_LABELS_SQL) return titles;
      throw new Error('requête inattendue');
    };
    return { q, calls };
  }
  const groupRow = (op: number, date: string | null, basis: string | null, extra: Record<string, unknown> = {}) => ({
    rank: 1, id: op, title: null, start_date: date, origin_field_key: null, event_nature: null, business_type: null,
    is_group: true, date_basis: basis, sort_key: date ?? '-infinity', ...extra,
  });
  const itemRow = (id: number, date: string | null, extra: Record<string, unknown> = {}) => ({
    ...row(id, date), rank: 0, is_group: false, date_basis: null, sort_key: date ?? '-infinity', ...extra,
  });

  it('L84C-U06 — règle remplacée (carte #744) : groupe = opération + éléments réels + compteurs ; curseur typé', async () => {
    const page = [
      itemRow(10, '2026-04-18', { remaining: 4 }),
      groupRow(900, '2026-03-12', 'REALIZED', { remaining: 4 }),
      itemRow(12, null, { remaining: 4 }),
    ];
    const { q, calls } = fakeQ(page,
      [{ ...row(21, '2026-03-21', { title: 'Visite expert' }), op: 900 }, { ...row(22, '2026-04-02', { title: 'Réparation plafond' }), op: 900 }, { ...row(23, null), op: 900 }],
      [{ op: 900, events: 4, documents: 5, assets: 1, rooms: 1, equipments: 0 }], [],
      [{ op: 900, type_code: 'CLAIM', technical_label: 'Dégât des eaux', provider: null, first_document: null }]);
    const p = await readAssetTimelinePage({ accountId: 1, assetId: 2, limit: 2, today: '2026-06-01', q });
    expect(calls[0].params).toEqual([1, 2, 'grouped', null, null, 3, 0]);
    expect(p.mode).toBe('grouped');
    expect(p.entries).toHaveLength(2);
    expect(p.remaining).toBe(4);
    expect(p.entries[0]).toMatchObject({ kind: 'item', itemType: 'agenda', id: '10' });
    expect(p.entries[0]).not.toHaveProperty('operations');
    const g = p.entries[1];
    // Identité typée de l'événement de référence : jamais celle d'un élément d'agenda.
    expect(g).toMatchObject({
      kind: 'group', itemType: 'operation', id: 'op-900', operationId: 900, title: 'Sinistre — Dégât des eaux',
      effectiveDate: '2026-03-12', dateBasis: 'REALIZED', counters: { events: 4, documents: 5, assets: 1, rooms: 1, equipments: 0 },
    });
    // Éléments réels triés comme la Timeline (date décroissante, sans date en dernier).
    expect(g.kind === 'group' && g.members.map((m) => m.id)).toEqual(['22', '21', '23']);
    expect(calls.find((c) => c.sql === TIMELINE_MEMBERS_SQL)!.params).toEqual([1, 2, [900]]);
    expect(calls.find((c) => c.sql === TIMELINE_COUNTERS_SQL)!.params).toEqual([1, [900]]);
    expect(decodeTimelineCursor(p.nextCursor, 'grouped')).toEqual({ mode: 'grouped', sortDate: '2026-03-12', id: 900, kind: 'group' });
    // Une requête par nature pour toute la page (aucune lecture par entrée).
    expect(calls).toHaveLength(4);

    // Page suivante : le curseur (date, identifiant, rang) est transmis tel quel à la requête.
    const suite = fakeQ([itemRow(12, null, { remaining: 1 })]);
    const p2 = await readAssetTimelinePage({ accountId: 1, assetId: 2, limit: 2, today: '2026-06-01', q: suite.q, cursor: decodeTimelineCursor(p.nextCursor, 'grouped') as never });
    expect(suite.calls[0].params).toEqual([1, 2, 'grouped', '2026-03-12', 900, 3, 1]);
    expect(p2.nextCursor).toBeNull();
    expect(suite.calls).toHaveLength(1);
  });

  it('L114O-C-U01 — opération sans élément d’agenda et sans date : entrée de groupe, aucun élément fictif, aucune date inventée (AC26, AC35)', async () => {
    const { q } = fakeQ(
      // Règle remplacée (carte #744) : le repère est la date de présentation du CDC §11 (ici le premier devis),
      // jamais la date du plus ancien élément d'agenda (l'ancien fondement « FIRST_EVENT » n'existe plus).
      [groupRow(901, '2024-05-02', 'FIRST_QUOTE'), groupRow(902, null, null), groupRow(903, '2024-01-01', 'FIRST_EVENT')],
      [{ ...row(31, '2024-05-02'), op: 901 }], [], [], [
        { op: 901, type_code: 'INTERVENTION', technical_label: null, provider: null, first_document: { titleRetained: 'Facture toiture' } },
        { op: 902, type_code: null, technical_label: null, provider: 'Plombier Martin', first_document: null },
      ]);
    const p = await readAssetTimelinePage({ accountId: 1, assetId: 2, today: '2026-06-01', q });
    const [a, b, c] = p.entries;
    expect(a).toMatchObject({ kind: 'group', id: 'op-901', title: 'Intervention — Facture toiture', effectiveDate: '2024-05-02', dateBasis: 'FIRST_QUOTE' });
    // Un fondement inconnu (ancienne valeur) ne date jamais un groupe : sans date.
    expect(c).toMatchObject({ kind: 'group', id: 'op-903', effectiveDate: null, dateBasis: null });
    expect(b).toMatchObject({ kind: 'group', id: 'op-902', effectiveDate: null, dateBasis: null, members: [], counters: { events: 0, documents: 0, assets: 0, rooms: 0, equipments: 0 } });
    // Type nul : libellé utilisateur existant (`referenceEventLabel`) ; les textes AFFICHÉS ne disent jamais « Opération ».
    expect(b.title).toBe('Dépense — Plombier Martin');
    // Règle remplacée (carte #806, décision du PO du 17/11/2026) : la garde interdisait « Opération » ; à l’écran on dit désormais « opération », et c’est « événement de référence » qui est interdit.
    expect(p.entries.map((e) => e.title).join(' ')).not.toMatch(/[ée]v[éeè]nements?\s+de\s+r[ée]f[ée]rence/i);
  });

  it('L84C-U07 — page détaillée : aucun groupe, aucune requête de membres ni de compteurs ; opérations de chaque élément (AC31)', async () => {
    const { q, calls } = fakeQ(
      [itemRow(21, '2026-03-21', { remaining: 2 }), itemRow(11, '2026-03-12', { remaining: 2 })], [], [],
      [{ item_id: 21, op: 900 }, { item_id: 21, op: 950 }],
      [
        { op: 900, type_code: 'CLAIM', technical_label: 'Dégât des eaux', provider: null, first_document: null },
        { op: 950, type_code: 'INTERVENTION', technical_label: 'Réparation plafond', provider: null, first_document: null },
      ]);
    const p = await readAssetTimelinePage({ accountId: 1, assetId: 2, mode: 'detailed', today: '2026-06-01', q });
    expect(p.entries.every((e) => e.kind === 'item')).toBe(true);
    // Élément partagé par deux événements de référence : UNE ligne, deux liens visibles.
    expect(p.entries.map((e) => e.id)).toEqual(['21', '11']);
    expect(p.entries[0]).toMatchObject({ operations: [{ operationId: 900, label: 'Sinistre — Dégât des eaux' }, { operationId: 950, label: 'Intervention — Réparation plafond' }] });
    expect(p.entries[1]).toMatchObject({ operations: [] });
    expect(calls.map((c) => c.sql)).toEqual([TIMELINE_PAGE_SQL, TIMELINE_ITEM_OPERATIONS_SQL, TIMELINE_OPERATION_LABELS_SQL]);
    expect(calls[0].params[2]).toBe('detailed');
    expect(calls[1].params).toEqual([1, [21, 11]]);
  });

  it('L84C-U11 — lecture complète : enchaîne les pages par curseur', async () => {
    let n = 0;
    const q: TimelineQuery = async (sql, params = []) => {
      if (sql !== TIMELINE_PAGE_SQL) return [];
      n++;
      const all = [5, 4, 3, 2, 1].map((id) => itemRow(id, `2026-01-0${id}`, { remaining: 0 }));
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
