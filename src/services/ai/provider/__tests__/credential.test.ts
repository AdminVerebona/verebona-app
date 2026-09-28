/**
 * CDC BO IA SCR-10 — credentials fournisseur.
 *
 * Le SCR-10 autorise l'affichage d'une clé en clair. Il n'autorise pas de la
 * laisser fuir ailleurs — dans un message d'erreur conservé en base, dans un
 * journal, dans une réponse renvoyée sans qu'on l'ait demandée.
 */
import { describe, it, expect } from 'vitest';
import { maskSecret } from '../credential.repository';

describe('aperçu masqué', () => {
  it('laisse reconnaître une clé sans la donner', () => {
    const masque = maskSecret('AIzaSyA1234567890abcdefXYZ');
    expect(masque).toBe('AIza…fXYZ');
    expect(masque).not.toContain('1234567890');
  });

  it('ne révèle presque rien d’une clé courte', () => {
    // Une clé de douze caractères ou moins n'a pas assez de matière pour un
    // aperçu : en montrer les extrémités reviendrait à la montrer entière.
    expect(maskSecret('court')).toBe('co…');
    expect(maskSecret('123456789012')).toBe('12…');
  });

  it('ne rend jamais la clé complète', () => {
    for (const secret of ['a'.repeat(13), 'AIzaSy' + 'b'.repeat(33), 'x'.repeat(200)]) {
      expect(maskSecret(secret).length, secret.length.toString()).toBeLessThan(secret.length);
    }
  });
});
