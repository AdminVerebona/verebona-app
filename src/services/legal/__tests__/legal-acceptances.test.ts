/**
 * Acceptations et page d'erreur — CDC 7 §9, §16.3, §18.
 */
import { describe, it, expect } from 'vitest';
import {
  isAcceptanceContext,
  ACCEPTANCE_CONTEXTS,
} from '@/services/legal/legal-acceptances.service';
import { renderLegalErrorPage } from '@/services/legal/legal-error-page';

describe('contextes d’acceptation (§9)', () => {
  it('couvre exactement les quatre contextes de la spécification', () => {
    expect([...ACCEPTANCE_CONTEXTS]).toEqual([
      'ACCOUNT_CREATION',
      'TRIAL_START',
      'PAID_SUBSCRIPTION',
      'VERSION_UPDATE',
    ]);
  });

  it('accepte les quatre valeurs prévues', () => {
    for (const context of ACCEPTANCE_CONTEXTS) {
      expect(isAcceptanceContext(context)).toBe(true);
    }
  });

  it('rejette toute autre valeur', () => {
    expect(isAcceptanceContext('SIGNUP')).toBe(false);
    expect(isAcceptanceContext('account_creation')).toBe(false);
    expect(isAcceptanceContext('')).toBe(false);
    expect(isAcceptanceContext(null)).toBe(false);
    expect(isAcceptanceContext(42)).toBe(false);
  });
});

describe('page d’erreur (§16.3, §18)', () => {
  it('est un document autonome', () => {
    const html = renderLegalErrorPage({ title: 'Version introuvable', message: 'Test.' });
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).not.toMatch(/<link[^>]+href="https?:/);
  });

  it('n’est pas indexée', () => {
    const html = renderLegalErrorPage({ title: 'Erreur', message: 'Test.' });
    expect(html).toContain('name="robots" content="noindex"');
  });

  it('rappelle la version demandée', () => {
    const html = renderLegalErrorPage({
      title: 'Version introuvable',
      message: 'Test.',
      requestedVersion: '2026-01-01-v1',
    });
    expect(html).toContain('2026-01-01-v1');
  });

  it('ne redirige jamais vers la version courante', () => {
    // §16.3 : « ne jamais rediriger silencieusement vers une version plus
    // récente ». La version courante n'est proposée que comme lien, avec un
    // avertissement — le choix reste à l'utilisateur.
    const html = renderLegalErrorPage({
      title: 'Version introuvable',
      message: 'Test.',
      offerCurrentLink: true,
    });
    expect(html).not.toMatch(/http-equiv="refresh"/i);
    expect(html).not.toMatch(/window\.location/);
    expect(html).toContain('href="/cgvu"');
    expect(html).toContain('Elle ne la remplace pas.');
  });

  it('n’offre aucun lien quand ce n’est pas demandé', () => {
    const html = renderLegalErrorPage({ title: 'Erreur', message: 'Test.' });
    expect(html).not.toContain('href="/cgvu"');
  });

  it('échappe le contenu injecté', () => {
    const html = renderLegalErrorPage({
      title: 'Erreur',
      message: 'Test.',
      requestedVersion: '<script>alert(1)</script>',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
