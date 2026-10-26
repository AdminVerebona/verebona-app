import { describe, it, expect } from 'vitest';
import { withActionLinkAliases, missingActionLinks, LINK_REQUIRED_TEMPLATES } from '../email-service';

/**
 * Lot 53 — e-mail d'invitation Duo encore reçu avec « Accepter : {{actionUrl}} »
 * (13/10/2026) : le lien d'action est posé quel que soit le nom employé par le
 * gabarit, et une invitation sans lien n'est jamais envoyée.
 */
describe('L53-ACTION-LINK — lien d’action des e-mails d’invitation', () => {
  const URL = 'https://app.verebona.fr/duo/join/abc';

  it('LINK-01 : inviteUrl seul → actionUrl et invitationLink posés', () => {
    const v = withActionLinkAliases({ inviteUrl: URL, ownerFullName: 'C. D.' });
    expect(v.actionUrl).toBe(URL);
    expect(v.invitationLink).toBe(URL);
    expect(v.ownerFullName).toBe('C. D.');
  });

  it('LINK-02 : invitationLink seul (invitation de compte) → actionUrl et inviteUrl posés', () => {
    const v = withActionLinkAliases({ invitationLink: URL });
    expect(v.actionUrl).toBe(URL);
    expect(v.inviteUrl).toBe(URL);
  });

  it('LINK-03 : une valeur fournie par l’appelant n’est jamais écrasée', () => {
    const v = withActionLinkAliases({ actionUrl: URL, inviteUrl: 'https://autre.example/x' });
    expect(v.actionUrl).toBe(URL);
    expect(v.inviteUrl).toBe('https://autre.example/x');
  });

  it('LINK-04 : sans URL http(s) → variables inchangées (pas de lien inventé)', () => {
    const src = { inviteUrl: 'capacitor://localhost/duo/join/abc', name: 'x' };
    expect(withActionLinkAliases(src)).toBe(src);
    expect(withActionLinkAliases({})).toEqual({});
  });

  it('LINK-05 : missingActionLinks ne relève que les liens (pas logoUrl ni les autres variables)', () => {
    expect(missingActionLinks('Accepter : {{actionUrl}} — {{ownerFullName}} {{logoUrl}}')).toEqual(['actionUrl']);
    expect(missingActionLinks('Bonjour {{firstName}}')).toEqual([]);
    expect(missingActionLinks('Voir {{ invitationLink }}')).toEqual(['invitationLink']);
  });

  it('LINK-06 : blocage limité aux invitations (les e-mails critiques ne sont jamais retenus)', () => {
    // Lot 68C : le rappel J−7 avant renouvellement annuel n'a de sens qu'avec son bouton
    // (désactivation du renouvellement) — information commerciale, pas un e-mail critique.
    expect([...LINK_REQUIRED_TEMPLATES].sort()).toEqual(['ACCOUNT_INVITATION', 'DUO_INVITATION', 'SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER']);
    expect(LINK_REQUIRED_TEMPLATES.has('PASSWORD_RESET')).toBe(false);
  });
});
