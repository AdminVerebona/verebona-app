/**
 * Affichage des erreurs et actions d'interface — CDC §4.2, §19.8, §27.9,
 * §27.11 (logique pure des composants du drawer).
 */
import { describe, it, expect } from 'vitest';
import { toAssistantUiError, assistantErrorMessage } from '../error-messages';
import {
  errorAssistantMessage, retryTarget, formatExplanation, HELP_HREF,
} from '../assistant-ui';
import type { VerebonaMessage } from '../useVerebona';

describe('libellés d’erreur (§27.11)', () => {
  it('distingue REQUEST_TIMEOUT d’une indisponibilité', () => {
    expect(assistantErrorMessage('REQUEST_TIMEOUT')).toMatch(/trop de temps/);
    expect(assistantErrorMessage('ASSISTANT_UNAVAILABLE')).toMatch(/souci technique/);
    expect(assistantErrorMessage('REQUEST_TIMEOUT')).not.toBe(assistantErrorMessage('ASSISTANT_UNAVAILABLE'));
  });

  it('ne reprend jamais un message serveur brut', () => {
    const e = toAssistantUiError({ error: { code: 'ASSISTANT_UNAVAILABLE', message: 'TypeError: cannot read x of undefined', recoverable: true } }, 500);
    expect(e.message).not.toMatch(/TypeError/);
    expect(e).toMatchObject({ code: 'ASSISTANT_UNAVAILABLE', recoverable: true });
  });

  it('déduit le code du statut HTTP quand le corps n’en porte pas', () => {
    expect(toAssistantUiError({}, 429).code).toBe('RATE_LIMITED');
    expect(toAssistantUiError(null, 504).code).toBe('REQUEST_TIMEOUT');
    expect(toAssistantUiError('pas du json', 500).code).toBe('ASSISTANT_UNAVAILABLE');
    expect(toAssistantUiError({ error: 'CONVERSATION_EXPIRED' }, 404).code).toBe('CONVERSATION_EXPIRED');
  });
});

describe('message d’erreur dans le fil (§4.2)', () => {
  it('libellé Verebona + « Réessayer » + « Ouvrir l’aide »', () => {
    const m = errorAssistantMessage(toAssistantUiError({}, 500), 'e1');
    expect(m.role).toBe('assistant');
    expect(m.error?.code).toBe('ASSISTANT_UNAVAILABLE');
    expect(m.actions?.map((a) => [a.type, a.label, a.href])).toEqual([
      ['RETRY_REQUEST', 'Réessayer', null],
      ['OPEN_HELP', 'Ouvrir l’aide', HELP_HREF],
    ]);
  });

  it('pas de « Réessayer » pour une erreur non récupérable', () => {
    const m = errorAssistantMessage({ code: 'PLAN_NOT_ELIGIBLE', message: 'x', recoverable: false }, 'e2');
    expect(m.actions?.map((a) => a.type)).toEqual(['OPEN_HELP']);
  });
});

describe('RETRY_REQUEST — la dernière question', () => {
  const fil: VerebonaMessage[] = [
    { id: 'u1', role: 'user', content: 'Première question' },
    { id: 'a1', role: 'assistant', content: 'Réponse' },
    { id: 'u2', role: 'user', content: 'Quand ai-je acheté ma Peugeot ?' },
    { id: 'e1', role: 'assistant', content: 'Je rencontre un souci technique.' },
  ];

  it('depuis un message d’erreur : la question qui le précède', () => {
    expect(retryTarget(fil, 'e1')).toEqual({ text: 'Quand ai-je acheté ma Peugeot ?', userMessageId: 'u2' });
  });
  it('depuis une réponse plus ancienne : sa propre question', () => {
    expect(retryTarget(fil, 'a1')).toEqual({ text: 'Première question', userMessageId: 'u1' });
  });
  it('sans question : rien à renvoyer', () => {
    expect(retryTarget([{ id: 'a', role: 'assistant', content: 'x' }], 'a')).toBeNull();
  });
});

describe('SHOW_EXPLANATION — justification synthétique (§19.8)', () => {
  it('faits, nature et sources, dédoublonnées', () => {
    const items = formatExplanation([
      { claim_text: ' La garantie court 2 ans. ', derivation: 'direct', sources: ['Garantie vélo', 'Garantie vélo', null] },
      { claim_text: 'Elle expire le 12/03/2026.', derivation: 'calculated', sources: [] },
      { claim_text: '   ', derivation: 'direct', sources: [] },
    ]);
    expect(items).toEqual([
      { text: 'La garantie court 2 ans.', derivation: 'lu dans la source', sources: ['Garantie vélo'] },
      { text: 'Elle expire le 12/03/2026.', derivation: 'calculé à partir des sources', sources: [] },
    ]);
  });
  it('réponse vide ou absente : liste vide', () => {
    expect(formatExplanation(null)).toEqual([]);
  });
});
