/**
 * Transmission d'un bien : seule la personne invitée peut l'accepter.
 */
import { describe, expect, it } from 'vitest';
import { isInvitedRecipient } from '@/lib/invited-recipient';

describe('isInvitedRecipient', () => {
  it('même adresse, à la casse et aux espaces près', () => {
    expect(isInvitedRecipient('Jean@Exemple.fr ', 'jean@exemple.fr')).toBe(true);
  });

  it('autre adresse : refus', () => {
    expect(isInvitedRecipient('jean@exemple.fr', 'pirate@exemple.fr')).toBe(false);
  });

  it('adresse absente d’un côté ou de l’autre : refus', () => {
    expect(isInvitedRecipient(null, 'jean@exemple.fr')).toBe(false);
    expect(isInvitedRecipient('jean@exemple.fr', undefined)).toBe(false);
    expect(isInvitedRecipient('', '')).toBe(false);
  });
});
