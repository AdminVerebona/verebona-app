/**
 * Lot 111R — statut effectif COMMUN de l'Agenda et de la Timeline (ticket
 * « Timeline/Agenda statut effectif », cas Draisienne « Achat — Draisienne »
 * du 04/04/2026 : « Réalisé » dans le tiroir Agenda, « statut à confirmer »
 * sur la Timeline).
 *
 *   L111R-U01  matrice de recette 1–4 sur le calcul pur, et PARITÉ Agenda ↔ Timeline
 *              (même entrée → même statut ; indicateurs dérivés du statut)
 *   L111R-U02  recette 5 : preuve invalide (supprimée / déliée) → recalcul (lecture SQL)
 *   L111R-U03  page REGROUPÉE : tête de groupe et membres prouvés → « Réalisé » (recette 6)
 *   L111R-U04  page DÉTAILLÉE : mêmes statuts, élément par élément (recette 6)
 *   L111R-U05  requêtes : preuve lue dans la page et les membres (pas de N+1), annulés exclus (recette 4)
 *   L111R-U06  autres lecteurs : Agenda (loadEventNatures), « Prochaines échéances », T2, export V12
 *   L111R-U07  heure / fin d'élément : même règle de date que l'Agenda
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeEffectiveStatus, effectiveStatusFlags, normalizeManualStatus } from '../AgendaDomainService';
import { validCompletionProofSql } from '../completion-proof';
import { isUpcomingDeadlineCandidate } from '../AgendaQueryService';
import { timelineItemView, type TimelineItemRow } from '../timeline/model';
import { TIMELINE_COUNTERS_SQL, TIMELINE_MEMBERS_SQL, TIMELINE_PAGE_SQL, readAssetTimelinePage, type TimelineQuery } from '../timeline/read';
import { agendaStatus4 } from '@/services/verebona-assistant/canonical/agenda';

const lire = (p: string) => readFileSync(resolve(__dirname, '..', '..', '..', '..', p), 'utf8');
const NOW = new Date('2026-11-05T12:00:00');
const TODAY = '2026-11-05';

const row = (id: number, start: string | null, extra: Partial<TimelineItemRow> = {}): TimelineItemRow => ({
  id, title: `Événement ${id}`, start_date: start, manual_status: null, origin_field_key: null, event_nature: null, business_type: null, ...extra,
});

/** Même élément vu par l'Agenda (`computeEffectiveStatus`) : entrée construite comme `AgendaQueryService`. */
const agendaStatus = (r: TimelineItemRow, now: Date = NOW) => computeEffectiveStatus({
  startDate: r.start_date, startTime: r.start_time ?? null, endDate: r.end_date ?? null, endTime: r.end_time ?? null,
  manualStatus: normalizeManualStatus(r.manual_status), eventNature: r.event_nature, businessType: r.business_type,
  originFieldKey: r.origin_field_key, completionProven: r.completion_proven === true,
}, now);

const CAS: Array<{ nom: string; r: TimelineItemRow; attendu: string }> = [
  // Recette 1 — cas Draisienne : achat passé, ticket de caisse = preuve valide, aucun statut manuel.
  { nom: 'achat prouvé sans statut manuel', r: row(1, '2026-04-04', { business_type: 'purchase', event_nature: 'HISTORICAL', completion_proven: true }), attendu: 'realise' },
  { nom: 'achat prouvé (nature déduite du type métier)', r: row(2, '2026-04-04', { business_type: 'purchase', completion_proven: true }), attendu: 'realise' },
  // Recette 2 — fait historique passé sans preuve.
  { nom: 'fait passé sans preuve', r: row(3, '2026-04-04', { business_type: 'purchase', event_nature: 'HISTORICAL' }), attendu: 'a_confirmer' },
  // Recette 3 — échéance passée non faite / future.
  { nom: 'échéance passée non faite', r: row(4, '2026-10-01', { business_type: 'inspection', event_nature: 'DEADLINE' }), attendu: 'en_retard' },
  { nom: 'échéance future', r: row(5, '2027-01-10', { business_type: 'inspection', event_nature: 'DEADLINE' }), attendu: 'a_venir' },
  { nom: 'échéance future « prouvée » : la preuve ne devance pas la date', r: row(6, '2027-01-10', { event_nature: 'DEADLINE', completion_proven: true }), attendu: 'a_venir' },
  { nom: 'échéance passée prouvée', r: row(7, '2026-10-01', { event_nature: 'DEADLINE', completion_proven: true }), attendu: 'realise' },
  // Recette 4 — statut manuel prioritaire.
  { nom: 'statut manuel « réalisé » sans preuve', r: row(8, '2026-04-04', { event_nature: 'HISTORICAL', manual_status: 'realise' }), attendu: 'realise' },
  { nom: 'statut manuel « annulé » malgré la preuve', r: row(9, '2026-04-04', { event_nature: 'HISTORICAL', manual_status: 'annule', completion_proven: true }), attendu: 'annule' },
  { nom: 'statut manuel avec espaces', r: row(10, '2026-10-01', { event_nature: 'DEADLINE', manual_status: ' realise ' }), attendu: 'realise' },
  { nom: 'statut manuel vide = aucun statut', r: row(11, '2026-10-01', { event_nature: 'DEADLINE', manual_status: '' }), attendu: 'en_retard' },
  { nom: 'sans date', r: row(12, null, { event_nature: 'HISTORICAL', completion_proven: true }), attendu: 'a_venir' },
];

describe('L111R — statut effectif canonique', () => {
  it('L111R-U01 — matrice 1–4 : Agenda et Timeline rendent le MÊME statut, indicateurs dérivés', () => {
    for (const c of CAS) {
      const v = timelineItemView(c.r, NOW);
      expect(agendaStatus(c.r), c.nom).toBe(c.attendu);
      expect(v.effectiveStatus, c.nom).toBe(c.attendu);
      expect({ isDone: v.isDone, isOverdue: v.isOverdue, toConfirm: v.toConfirm }, c.nom).toEqual(effectiveStatusFlags(c.attendu as never));
    }
    // Indicateurs : exclusifs, jamais « réalisé » et « à confirmer » à la fois (cas Draisienne).
    const draisienne = timelineItemView(CAS[0].r, NOW);
    expect(draisienne).toMatchObject({ isDone: true, toConfirm: false, isOverdue: false, effectiveStatus: 'realise' });
    // Date de référence AAAA-MM-JJ (export, tests) : début du jour, même résultat.
    for (const c of CAS) expect(timelineItemView(c.r, TODAY).effectiveStatus, c.nom).toBe(c.attendu);
  });

  it('L111R-U02 — recette 5 : la preuve n’est valide que document du compte, non supprimé, encore lié ; sinon recalcul', () => {
    const sql = validCompletionProofSql('i').replace(/\s+/g, ' ');
    expect(sql).toContain('i.completion_proof_file_id IS NOT NULL');
    expect(sql).toContain('cpf.id = i.completion_proof_file_id');
    expect(sql).toContain('cpf.account_id = i.account_id');
    expect(sql).toContain('cpf.deleted_at IS NULL');
    expect(sql).toContain('JOIN agenda_file_links cpl ON cpl.asset_file_id = cpf.id AND cpl.agenda_item_id = i.id');
    // Preuve tombée (document supprimé ou délié) : `completion_proven` faux → recalcul.
    const avant = row(1, '2026-04-04', { business_type: 'purchase', completion_proven: true });
    const apres = { ...avant, completion_proven: false };
    expect(timelineItemView(avant, NOW).effectiveStatus).toBe('realise');
    expect(timelineItemView(apres, NOW).effectiveStatus).toBe('a_confirmer');
    expect(agendaStatus(apres)).toBe('a_confirmer');
    const ech = row(2, '2026-10-01', { event_nature: 'DEADLINE', completion_proven: false });
    expect(timelineItemView(ech, NOW).effectiveStatus).toBe('en_retard');
  });

  function fakeQ(pageRows: Record<string, unknown>[], members: Record<string, unknown>[] = [], counters: Record<string, unknown>[] = []) {
    const calls: string[] = [];
    const q: TimelineQuery = async (sql) => {
      calls.push(sql);
      if (sql === TIMELINE_PAGE_SQL) return pageRows;
      if (sql === TIMELINE_MEMBERS_SQL) return members;
      if (sql === TIMELINE_COUNTERS_SQL) return counters;
      throw new Error('requête inattendue');
    };
    return { q, calls };
  }

  const tete = { ...row(11, '2026-04-04', { title: 'Achat — Draisienne', business_type: 'purchase', completion_proven: true }), op: 900, is_head: true, sort_key: '2026-04-04', remaining: 3 };
  const membres = [
    { ...row(21, '2026-04-04', { title: 'Garantie', business_type: 'purchase', completion_proven: false }), op: 900 },
    { ...row(22, '2026-04-04', { title: 'Achat accessoire', event_nature: 'HISTORICAL', completion_proven: true }), op: 900 },
    { ...row(23, '2026-10-01', { title: 'Révision', event_nature: 'DEADLINE' }), op: 900 },
  ];

  it('L111R-U03 — mode Regroupée : tête et membres portent le statut canonique (preuve comprise)', async () => {
    const { q, calls } = fakeQ([tete, { ...row(12, '2027-01-10', { event_nature: 'DEADLINE' }), op: null, is_head: false, sort_key: '2027-01-10', remaining: 3 }], membres,
      [{ op: 900, events: 3, documents: 1, assets: 1, rooms: 0, equipments: 0 }]);
    const p = await readAssetTimelinePage({ accountId: 1, assetId: 2, today: TODAY, now: NOW, q });
    // Une requête de page, une de membres, une de compteurs : la preuve est dans les deux premières (pas de N+1).
    expect(calls).toHaveLength(3);
    const g = p.entries.find((e) => e.kind === 'group');
    expect(g).toMatchObject({ id: '11', effectiveStatus: 'realise', isDone: true, toConfirm: false });
    expect(g?.kind === 'group' && Object.fromEntries(g.members.map((m) => [m.title, m.effectiveStatus]))).toEqual({
      'Garantie': 'a_confirmer', 'Achat accessoire': 'realise', 'Révision': 'en_retard',
    });
    expect(p.entries.find((e) => e.id === '12')).toMatchObject({ kind: 'item', effectiveStatus: 'a_venir' });
  });

  it('L111R-U04 — mode Détaillée : chaque élément, même statut que dans le groupe', async () => {
    const detail = [tete, ...membres].map((r, i) => ({ ...r, op: null, is_head: false, sort_key: r.start_date, remaining: 4, id: r.id ?? i }));
    const { q, calls } = fakeQ(detail);
    const p = await readAssetTimelinePage({ accountId: 1, assetId: 2, mode: 'detailed', today: TODAY, now: NOW, q });
    expect(calls).toHaveLength(1);
    expect(p.entries.every((e) => e.kind === 'item')).toBe(true);
    expect(Object.fromEntries(p.entries.map((e) => [e.title, e.effectiveStatus]))).toEqual({
      'Achat — Draisienne': 'realise', 'Garantie': 'a_confirmer', 'Achat accessoire': 'realise', 'Révision': 'en_retard',
    });
    // Parité : statut Timeline = statut Agenda pour chaque ligne.
    for (const r of detail) expect(p.entries.find((e) => e.id === String(r.id))?.effectiveStatus).toBe(agendaStatus(r as TimelineItemRow));
  });

  it('L111R-U05 — requêtes : preuve canonique dans la page ET les membres, heures lues, annulés exclus', () => {
    const page = TIMELINE_PAGE_SQL.replace(/\s+/g, ' ');
    const membres = TIMELINE_MEMBERS_SQL.replace(/\s+/g, ' ');
    expect(page).toContain(validCompletionProofSql('e').replace(/\s+/g, ' '));
    expect(membres).toContain(validCompletionProofSql('ai').replace(/\s+/g, ' '));
    for (const s of [page, membres]) {
      expect(s).toContain('AS completion_proven');
      expect(s).toContain('ai.start_time::text AS start_time');
      expect(s).toContain("to_char(ai.end_date, 'YYYY-MM-DD') AS end_date");
      expect(s).toContain("ai.manual_status <> 'annule'");
    }
    // La Timeline n'a plus de règle propre (statut manuel / nature) : calcul canonique.
    const model = lire('src/services/agenda/timeline/model.ts');
    expect(model).toContain('computeEffectiveStatus(');
    expect(model).not.toMatch(/isHistoricalAgendaEvent|manual_status === 'realise'/);
    // La route passe l'instant de la requête (même référence que l'Agenda).
    expect(lire('src/app/api/assets/[id]/overview/route.ts')).toMatch(/today, now \}/);
  });

  it('L111R-U06 — autres lecteurs : Agenda, « Prochaines échéances », T2, export V12 — même preuve', () => {
    const query = lire('src/services/agenda/AgendaQueryService.ts');
    expect(query).toContain("validCompletionProofSelect('i')");
    expect(query).not.toMatch(/EXISTS \(SELECT 1 FROM asset_files f WHERE f\.id = i\.completion_proof_file_id/);
    // Accueil : un élément réalisé par preuve n'est plus une échéance à venir.
    expect(isUpcomingDeadlineCandidate({ eventNature: 'DEADLINE', manualStatus: null, effectiveStatus: 'realise' })).toBe(false);
    expect(isUpcomingDeadlineCandidate({ eventNature: 'DEADLINE', manualStatus: null, effectiveStatus: 'a_venir' })).toBe(true);
    expect(isUpcomingDeadlineCandidate({ eventNature: 'DEADLINE', manualStatus: null })).toBe(true);
    // T2 / export V12 (statut à 4 états) : prouvé et passé → completed ; futur : inchangé.
    expect(agendaStatus4(null, false, '2026-04-04', TODAY, true, true)).toBe('completed');
    expect(agendaStatus4(null, false, '2026-04-04', TODAY, true, false)).toBe('not_proven');
    expect(agendaStatus4(null, false, '2027-01-10', TODAY, false, true)).toBe('unknown');
    expect(agendaStatus4('annule', false, '2026-04-04', TODAY, true, true)).toBe('not_completed');
    for (const f of ['src/services/verebona-assistant/canonical/agenda.ts', 'src/services/verebona-assistant/core/synthesis-planner.ts', 'src/services/exports/v12/data/canonical-source.ts']) {
      expect(lire(f), f).toContain("validCompletionProofSelect('i')");
    }
  });

  it('L111R-U07 — heure et fin d’élément : même règle de date que l’Agenda', () => {
    const matin = row(1, TODAY, { event_nature: 'DEADLINE', start_time: '08:00:00' });
    expect(timelineItemView(matin, NOW).effectiveStatus).toBe('en_retard');
    expect(agendaStatus(matin)).toBe('en_retard');
    const plusieursJours = row(2, '2026-11-01', { event_nature: 'DEADLINE', end_date: '2026-11-10' });
    expect(timelineItemView(plusieursJours, NOW).effectiveStatus).toBe('a_venir');
    expect(agendaStatus(plusieursJours)).toBe('a_venir');
  });
});
