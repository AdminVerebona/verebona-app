/**
 * T4 — récurrences : jamais inventées, calculées par le code, bornées.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

vi.mock('../../gateway/ai-gateway', () => ({ AiGateway: { execute: vi.fn(async () => { throw new Error('pas de modèle'); }) } }));
import { parseRecurrenceFr, computeOccurrences, inferHistoricalRecurrence, addInterval } from '../rules/recurrence';
import { processAgendaCandidates } from '../agenda-intelligence.service';
import { recurrenceOf } from '../../source-analysis/steps/build-agenda-candidates.step';
import type { ExistingAgendaItem } from '../types';

const TODAY = '2026-09-25';

describe('lecture d’une mention explicite', () => {
  it.each([
    ['Renouvellement annuel', 'yearly', 1],
    ['Entretien tous les 2 ans', 'yearly', 2],
    ['tous les 12 mois', 'yearly', 1],
    ['Échéances trimestrielles', 'monthly', 3],
    ['Prélèvement mensuel', 'monthly', 1],
  ])('« %s »', (t, f, i) => {
    expect(parseRecurrenceFr(t)).toMatchObject({ mode: 'EXPLICIT_SOURCE', frequency: f, interval: i });
  });
  it('aucune mention : aucune récurrence (pas de connaissance générale)', () => {
    expect(parseRecurrenceFr('Contrôle technique le 15 novembre 2026')).toBeNull();
    expect(recurrenceOf({ fieldKey: 'nextInspection', value: '2026-11-15', confidence: 'certain', excerpt: 'Prochain contrôle : 15/11/2026' })).toBeUndefined();
  });
});

describe('calcul déterministe et borné', () => {
  it('récurrence ouverte : la prochaine occurrence seulement', () => {
    expect(computeOccurrences(parseRecurrenceFr('Entretien annuel')!, '2026-11-15', TODAY)).toEqual(['2027-11-15']);
  });
  it('échéancier borné : rien après la borne', () => {
    const s = parseRecurrenceFr('Paiement mensuel du 15 janvier 2027 au 15 juin 2027')!;
    expect(computeOccurrences(s, '2027-01-15', TODAY)).toHaveLength(6);
    expect(computeOccurrences(s, '2027-01-15', TODAY).at(-1)).toBe('2027-06-15');
  });
  it('nombre explicite : exactement ce nombre', () => {
    expect(computeOccurrences(parseRecurrenceFr('6 mensualités à compter du 15 janvier 2027')!, '2027-01-15', TODAY)).toHaveLength(6);
  });
  it('dates listées : conservées exactement', () => {
    expect(computeOccurrences({ mode: 'EXPLICIT_SOURCE', frequency: 'monthly', interval: 1, dates: ['2027-01-15', '2027-02-16', '2027-03-15'] }, '2027-01-15', TODAY))
      .toEqual(['2027-01-15', '2027-02-16', '2027-03-15']);
  });
  it('fin explicite : plus aucune occurrence', () => {
    expect(computeOccurrences(parseRecurrenceFr('Contrat résilié, dernière échéance annuelle')!, '2026-11-15', TODAY)).toEqual([]);
  });
  it('fins de mois', () => {
    expect(addInterval('2027-01-31', 'monthly', 1)).toBe('2027-02-28');
  });
});

describe('historique', () => {
  it('trois occurrences annuelles cohérentes : HISTORICAL_PATTERN', () => {
    expect(inferHistoricalRecurrence(['2024-11-15', '2025-11-14', '2026-11-15'])).toMatchObject({ mode: 'HISTORICAL_PATTERN', frequency: 'yearly', interval: 1 });
  });
  it('deux dates, ou des écarts incohérents : rien', () => {
    expect(inferHistoricalRecurrence(['2025-11-15', '2026-11-15'])).toBeNull();
    expect(inferHistoricalRecurrence(['2024-01-15', '2024-05-15', '2026-11-15'])).toBeNull();
  });
});

describe('moteur T4', () => {
  const run = (excerpt: string, existing: ExistingAgendaItem[] = []) => processAgendaCandidates({
    accountId: 1, assetId: 2, sourceFileId: 9, today: TODAY, existing,
    candidates: [{ title: 'Entretien à prévoir', date: '2026-11-15', confidence: 'certain', excerpt, originFieldKey: 'maintenanceDueDate', recurrence: parseRecurrenceFr(excerpt) ?? undefined }],
  });

  it('prévision marquée, avec sa provenance', async () => {
    const d = await run('Entretien annuel. Dernier entretien : 15/11/2026');
    const f = d.find((x) => x.date === '2027-11-15')!;
    expect(f.action).toBe('create');
    expect(f.occurrence).toMatchObject({ nature: 'FORECAST', dateSource: 'PREDICTED_FROM_RECURRENCE' });
    expect(f.occurrence!.recurrence).toMatchObject({ mode: 'EXPLICIT_SOURCE', referenceDate: '2026-11-15', sourceFileId: 9 });
    expect(d.find((x) => x.date === '2026-11-15')!.occurrence).toMatchObject({ nature: 'CONFIRMED', dateSource: 'EXPLICIT_DATE' });
  });

  it('occurrence déjà présente : pas recréée ; occurrence proche : arbitrage T4-01', async () => {
    const exist = (d: string, manual = false): ExistingAgendaItem => ({ id: 5, title: 'Entretien à prévoir', date: d, category: 'action', status: null, manual, originFieldKey: 'maintenanceDueDate' });
    expect((await run('Entretien annuel', [exist('2027-11-15')])).find((x) => x.date === '2027-11-15')!.action).toBe('skip_duplicate');
    const deplacee = (await run('Entretien annuel', [exist('2027-11-20', true)])).filter((x) => x.date === '2027-11-15');
    expect(deplacee.every((x) => x.action === 'skip_duplicate')).toBe(true);
  });

  it('source réellement modifiée : prompt T1 v3 (récurrence seulement si écrite)', () => {
    const p = readFileSync(join(process.cwd(), 'src/services/ai/prompts/source-analysis/extract_source_v3.txt'), 'utf-8');
    expect(p).toMatch(/R8bis — RÉCURRENCE, SEULEMENT SI ELLE EST ÉCRITE/);
    expect(p).toMatch(/Ne calcule AUCUNE date future toi-même/);
  });
});
