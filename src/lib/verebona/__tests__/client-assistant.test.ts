/**
 * Côté client de l'assistant — CDC §6.6, §7.7, §7.8, CA-22 (logique pure,
 * le harnais ne rend pas de TSX).
 */
import { describe, it, expect } from 'vitest';
import { isCancelledResponse, processingStatus, currentPlatform } from '../assistant-ui';
import { SlidingWindowLimiter, checkAssistantRateLimit } from '../rate-limit';

describe('annulation : la réponse tardive n’est jamais affichée (§7.8, CA-22)', () => {
  it('reconnaît la réponse d’une demande annulée', () => {
    expect(isCancelledResponse({ status: 'cancelled' })).toBe(true);
    expect(isCancelledResponse({ error: { code: 'REQUEST_CANCELLED' } })).toBe(true);
    expect(isCancelledResponse({ status: 'ready', answer: 'x' })).toBe(false);
    expect(isCancelledResponse(null)).toBe(false);
  });
});

describe('statuts de traitement contextualisés (§7.7)', () => {
  it('le libellé suit le temps écoulé', () => {
    expect(processingStatus(0)).toMatch(/recherche/);
    expect(processingStatus(3000)).toMatch(/vérifie/);
    expect(processingStatus(9000)).toMatch(/prépare/);
  });
  it('plateforme : « web » hors navigateur', () => {
    expect(currentPlatform()).toBe('web');
  });
});

describe('limitation de débit dédiée (§6.6)', () => {
  it('fenêtre glissante : la 11e question de la minute est refusée, puis permise après la fenêtre', () => {
    const l = new SlidingWindowLimiter(60_000);
    for (let i = 0; i < 10; i++) expect(l.take('u', 10, 1_000 + i).allowed).toBe(true);
    const refus = l.take('u', 10, 2_000);
    expect(refus.allowed).toBe(false);
    expect(refus.retryAfterMs).toBeGreaterThan(0);
    expect(l.take('u', 10, 62_000).allowed).toBe(true);
  });
  it('par utilisateur, puis par compte (3×)', () => {
    const t = 5_000_000;
    for (let i = 0; i < 10; i++) expect(checkAssistantRateLimit(101, 900, 10, t).allowed).toBe(true);
    expect(checkAssistantRateLimit(101, 900, 10, t)).toMatchObject({ allowed: false, scope: 'user' });
    for (let u = 102; u < 104; u++) for (let i = 0; i < 10; i++) checkAssistantRateLimit(u, 900, 10, t);
    expect(checkAssistantRateLimit(104, 900, 10, t)).toMatchObject({ allowed: false, scope: 'account' });
  });
});
