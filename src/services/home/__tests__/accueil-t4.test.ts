/**
 * Accueil et mascotte derrière AI_T4_EFFECTS — CDC 15 T4-02, T4-11, T4-12,
 * D-14 (lot 14).
 *   · legacy  : règle historique inchangée (recopie T4-02 / T4-11) ;
 *   · enabled : catégorie de l'élément, nature (HISTORICAL jamais une
 *               échéance), règles partagées de T4 ; échéance passée sans
 *               statut = « à confirmer », pas « en retard ».
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { isAgendaActionItem, isAgendaActionItemT4, isAgendaActionForMode } from '../mascot/collector';
import { tileFor, homePose } from '../mascot/bubble';
import { isUpcomingDeadlineCandidate } from '@/services/agenda/AgendaQueryService';
import type { MascotSubject, MascotPresentation } from '../mascot/types';

const item = (over: Partial<Parameters<typeof isAgendaActionItemT4>[0]> = {}) =>
  ({ homeCategory: null, originType: 'asset_field', title: 'Prochain contrôle technique', ...over });

describe('classification des échéances d’accueil', () => {
  it('legacy : règle historique strictement inchangée (champ de bien = information)', () => {
    expect(isAgendaActionItem(item())).toBe(false);
    expect(isAgendaActionForMode(item({ originFieldKey: 'nextInspection', eventNature: 'DEADLINE' }), 'legacy')).toBe(false);
    expect(isAgendaActionForMode(item(), 'shadow')).toBe(false);
  });

  it('enabled : un champ de bien futur est une ACTION selon sa nature (T4-02)', () => {
    expect(isAgendaActionItemT4(item({ originFieldKey: 'nextInspection', eventNature: 'DEADLINE' }))).toBe(true);
    expect(isAgendaActionItemT4(item({ originFieldKey: 'maintenanceDueDate', eventNature: 'DEADLINE', title: 'Prochain entretien' }))).toBe(true);
  });

  it('enabled : un fait HISTORICAL n’est jamais une action (D-14), même mal catégorisé', () => {
    expect(isAgendaActionItemT4(item({ eventNature: 'HISTORICAL', homeCategory: 'action', title: 'Achat — Draisienne' }))).toBe(false);
  });

  it('enabled : la catégorie posée par T4 / l’utilisateur prime ; plus de règle « assurance = information » (T4-11)', () => {
    expect(isAgendaActionItemT4(item({ homeCategory: 'information', title: 'Contrôle technique' }))).toBe(false);
    expect(isAgendaActionItemT4(item({ originType: 'manual', title: 'Fin de période d’assurance : résilier avant le 31/12' }))).toBe(true);
  });

  it('prochaines échéances : un HISTORICAL en est exclu (helper de B)', () => {
    expect(isUpcomingDeadlineCandidate({ eventNature: 'HISTORICAL' })).toBe(false);
    expect(isUpcomingDeadlineCandidate({ eventNature: 'DEADLINE' })).toBe(true);
  });

  it('la requête d’accueil passe par le filtre de B, en mode T4 seulement', () => {
    const svc = readFileSync(join(process.cwd(), 'src/services/home/HomeSummaryService.ts'), 'utf8');
    expect(svc).toContain("upcomingDeadlinesSqlFilter('agenda_items', t4Mode)");
    expect(svc).toMatch(/t4\s*\?\s*sql\.raw\(filtreT4/);
    expect(svc).toContain("or(eq(agendaItems.isAutomatic, false), eq(agendaItems.occurrenceNature, 'FORECAST'))");
    const col = readFileSync(join(process.cwd(), 'src/services/home/mascot/collector.ts'), 'utf8');
    expect(col).toContain("upcomingDeadlinesSqlFilter('i', mode)");
  });
});

describe('mascotte : non prouvé ≠ non réalisé (T4-12)', () => {
  const echue = {
    subjectId: 'MASC-EXT-ACTION:1', sourceCode: 'MASC-EXT-ACTION', accountId: 1, targetType: 'AGENDA_ITEM', targetId: 1,
    priority: 'DO_NEXT', requiresAttention: true, intent: 'act',
    facts: { title: 'Entretien chaudière', date: '2026-09-10', assetName: 'Maison' },
    actions: [], fallbackText: 'x', occurrenceKey: 'k', dedupeKeys: [], assetId: 1, assetName: 'Maison',
  } as unknown as MascotSubject;
  const pres = (tile: ReturnType<typeof tileFor>): MascotPresentation => ({
    schemaVersion: 'mascot-presentation-v1', status: 'ok', source: 'fallback', contextHash: 'h', secondaries: [],
    degradedNotice: null, computedAt: '', paragraphs: [{ subjectId: 's', sourceCode: 'MASC-EXT-ACTION', occurrenceKey: 'k', text: 't.', highlight: null, actions: [], tile }],
  });

  it('historique : échéance passée = rouge « en retard », pose alert-folder', () => {
    const t = tileFor(echue, '2026-09-20');
    expect(t).toMatchObject({ tone: 'red', kind: 'overdue' });
    expect(homePose(pres(t), false)).toBe('alert-folder');
  });

  it('T4 : échéance passée sans statut = ambre « à confirmer », pose questioning', () => {
    const t = tileFor(echue, '2026-09-20', { unprovenOverdueIsQuestion: true });
    expect(t).toMatchObject({ tone: 'amber', kind: 'verify', status: 'Prévue il y a 10 j — à confirmer' });
    expect(homePose(pres(t), false)).toBe('questioning');
  });

  it('T4 : échéance du jour inchangée (reminder-bell)', () => {
    const t = tileFor(echue, '2026-09-10', { unprovenOverdueIsQuestion: true });
    expect(homePose(pres(t), false)).toBe('reminder-bell');
  });
});
