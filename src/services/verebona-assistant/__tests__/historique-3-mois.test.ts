/**
 * Historique de l'assistant : 3 mois par défaut — CDC Centre d'aide GAP-16,
 * T2-09 (décision produit), au lieu des 7 jours de la configuration initiale.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { loadAssistantConfig } from '../config/assistant-config';

const ENV = 'VEREBONA_ASSISTANT_HISTORY_DAYS';
const initial = process.env[ENV];

afterEach(() => {
  if (initial === undefined) delete process.env[ENV];
  else process.env[ENV] = initial;
});

describe('durée d’historique (GAP-16)', () => {
  it('vaut 90 jours sans configuration explicite', () => {
    delete process.env[ENV];
    expect(loadAssistantConfig().historyDays).toBe(90);
  });

  it('reste surchargeable par environnement', () => {
    process.env[ENV] = '30';
    expect(loadAssistantConfig().historyDays).toBe(30);
  });

  it('une valeur invalide retombe sur 90 jours, jamais sur 7', () => {
    process.env[ENV] = 'trois mois';
    expect(loadAssistantConfig().historyDays).toBe(90);
  });
});
