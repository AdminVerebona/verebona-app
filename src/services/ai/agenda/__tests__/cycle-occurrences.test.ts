/**
 * T4 — cycle de vie des occurrences : une prévision devient une occurrence
 * confirmée (même ligne), jamais un doublon ; l'historique est conservé.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

vi.mock('../../gateway/ai-gateway', () => ({ AiGateway: { execute: vi.fn(async () => { throw new Error('pas de modèle'); }) } }));
import { processAgendaCandidates } from '../agenda-intelligence.service';
import { findDuplicate } from '../dedupe.service';
import type { ExistingAgendaItem } from '../types';

const TODAY = '2026-09-25';
const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

const item = (o: Partial<ExistingAgendaItem> & { id: number; date: string }): ExistingAgendaItem => ({
  title: 'Contrôle technique', category: 'action', status: null, manual: false,
  originFieldKey: 'nextInspection', nature: 'CONFIRMED', ...o,
});

const run = (date: string, existing: ExistingAgendaItem[], title = 'Contrôle technique') => processAgendaCandidates({
  accountId: 1, assetId: 2, sourceFileId: 9, today: TODAY, existing,
  candidates: [{ title, date, confidence: 'certain', excerpt: `Prochain contrôle : ${date}`, originFieldKey: 'nextInspection' }],
});

describe('confirmation d’une occurrence prévisionnelle', () => {
  const passe = item({ id: 1, date: '2025-11-15' });
  const prevue = item({ id: 2, date: '2026-11-15', nature: 'FORECAST' });

  it('occurrence passée confirmée et prévision future coexistent', () => {
    expect(findDuplicate({ title: 'Contrôle technique', date: '2027-11-15', originFieldKey: 'nextInspection' }, [passe]).kind).toBe('none');
  });

  it('même date : la prévision est confirmée, aucune seconde ligne', async () => {
    const [d] = await run('2026-11-15', [passe, prevue]);
    expect(d).toMatchObject({ action: 'confirm_forecast', existingItemId: 2, reasonCode: 'FORECAST_CONFIRMED_SAME_DATE' });
  });

  it('date réelle proche (17/11 au lieu du 15/11) : même ligne, date ajustée', async () => {
    const [d] = await run('2026-11-17', [passe, prevue]);
    expect(d).toMatchObject({ action: 'confirm_forecast', existingItemId: 2, reasonCode: 'FORECAST_CONFIRMED_DATE_ADJUSTED' });
  });

  it('prévision déplacée par l’utilisateur : jamais redéplacée en silence', async () => {
    const [d] = await run('2026-11-17', [passe, { ...prevue, manual: true }]);
    expect(d).toMatchObject({ action: 'arbitrate_duplicate', reasonCode: 'FORECAST_USER_MODIFIED_DIVERGENCE', existingItemId: 2 });
  });

  it('correspondance incertaine (autre champ, titre voisin) : arbitrage, pas de confirmation', async () => {
    const [d] = await processAgendaCandidates({
      accountId: 1, assetId: 2, sourceFileId: 9, today: TODAY,
      existing: [{ ...prevue, originFieldKey: null }],
      candidates: [{ title: 'Contrôle technique véhicule', date: '2026-11-17', confidence: 'certain', excerpt: 'CT le 17/11/2026' }],
    });
    expect(d.action).toBe('arbitrate_duplicate');
  });

  it('écart trop grand : pas une confirmation', () => {
    expect(findDuplicate({ title: 'Contrôle technique', date: '2027-03-01', originFieldKey: 'nextInspection' }, [prevue]).kind).not.toBe('exact');
  });

  it('relance : une occurrence déjà confirmée n’est pas recréée', async () => {
    const [d] = await run('2026-11-17', [passe, item({ id: 2, date: '2026-11-17' })]);
    expect(d.action).toBe('skip_duplicate');
  });
});

describe('persistance et historique', () => {
  const persist = src('src/services/agenda/agenda-persistence.ts');
  const mig = src('src/db/migrations/0159_agenda_occurrence_lifecycle.sql');
  it('migration : date initiale, confirmation, journal', () => {
    for (const c of ['forecast_initial_date', 'confirmed_at', 'confirmation_mode', 'confirmation_source', 'agenda_occurrence_events']) expect(mig).toContain(c);
  });
  it('confirmation : même ligne, date initiale conservée, événements tracés', () => {
    expect(persist).toMatch(/confirmForecast/);
    expect(persist).toContain('forecastInitialDate: cur.forecastInitialDate ?? cur.startDate');
    for (const e of ['FORECAST_CREATED', 'CONFIRMED', 'DATE_CHANGED']) expect(persist).toContain(e);
  });
});

describe('affichage', () => {
  it('une date prévisionnelle est présentée comme telle', () => {
    expect(src('src/components/agenda/AgendaItemDrawer.tsx')).toMatch(/Prévisionnelle/);
    expect(src('src/components/agenda/AgendaItemDrawer.tsx')).toMatch(/Confirmer cette date/);
    expect(src('src/services/verebona-assistant/core/data-answer.service.ts')).toMatch(/prévue le/);
  });
});
