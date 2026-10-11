/**
 * Lot 37 — C3 : renvoi de vérification, traitement exécuté après la réponse
 * neutre. Seul un compte existant ET non vérifié reçoit un e-mail ; un échec
 * d'envoi est journalisé (cause + remède), jamais renvoyé au client.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let row: Record<string, unknown> | null = null;
vi.mock('@/db', () => {
  const chain = { select: () => chain, from: () => chain, where: () => chain, limit: async () => (row ? [row] : []) };
  return { db: chain };
});
const send = vi.fn();
vi.mock('@/lib/email/email-service', () => ({ emailService: { send: (a: unknown) => send(a) } }));

const { resendVerification } = await import('@/services/auth/resend-verification.service');

beforeEach(() => { row = null; send.mockReset(); });

describe('C3-11 resendVerification', () => {
  it('adresse inconnue ou compte déjà vérifié : rien n’est envoyé', async () => {
    expect(await resendVerification('personne@x.fr')).toBe('skipped');
    row = { id: 1, email: 'a@x.fr', firstName: 'A', isActive: true };
    expect(await resendVerification('a@x.fr')).toBe('skipped');
    expect(send).not.toHaveBeenCalled();
  });
  it('compte non vérifié : lien signé envoyé', async () => {
    row = { id: 2, email: 'b@x.fr', firstName: 'B', isActive: false };
    send.mockResolvedValue({ success: true });
    expect(await resendVerification('b@x.fr')).toBe('sent');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ templateCode: 'EMAIL_VERIFICATION', to: 'b@x.fr' }));
  });
  it('échec d’envoi : journalisé avec le remède, sans lever', async () => {
    row = { id: 3, email: 'c@x.fr', firstName: 'C', isActive: false };
    send.mockResolvedValue({ success: false, error: 'Template EMAIL_VERIFICATION not found' });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await resendVerification('c@x.fr')).toBe('failed');
    expect(err.mock.calls.flat().join(' ')).toMatch(/gabarit/);
    err.mockRestore();
  });
});
