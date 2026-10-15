/**
 * Lot 37 — C3 : renvoi de vérification, traitement exécuté après la réponse
 * neutre. Seul un compte existant ET non vérifié reçoit un e-mail ; un échec
 * d'envoi est journalisé (cause + remède), jamais renvoyé au client.
 * Lot 57A : l'envoi passe par la demande DURABLE (file en base + reprise).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let row: Record<string, unknown> | null = null;
vi.mock('@/db', () => {
  const chain = { select: () => chain, from: () => chain, where: () => chain, limit: async () => (row ? [row] : []) };
  return { db: chain };
});
const enqueue = vi.fn();
const process_ = vi.fn();
vi.mock('@/services/email/transactional-email-jobs.service', () => ({
  enqueueVerificationEmail: (a: unknown) => enqueue(a),
  processEmailJob: (id: number) => process_(id),
}));

const { resendVerification } = await import('@/services/auth/resend-verification.service');

beforeEach(() => { row = null; enqueue.mockReset(); process_.mockReset(); enqueue.mockResolvedValue({ jobId: 9, created: true }); });

describe('C3-11 resendVerification', () => {
  it('adresse inconnue ou compte déjà vérifié : rien n’est envoyé', async () => {
    expect(await resendVerification('personne@x.fr')).toBe('skipped');
    row = { id: 1, email: 'a@x.fr', firstName: 'A', isActive: true };
    expect(await resendVerification('a@x.fr')).toBe('skipped');
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('compte non vérifié : demande durable enregistrée puis tentée (MAIL-P0-05)', async () => {
    row = { id: 2, email: 'b@x.fr', firstName: 'B', isActive: false };
    process_.mockResolvedValue({ jobId: 9, status: 'accepted' });
    expect(await resendVerification('b@x.fr')).toBe('sent');
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ userId: 2, email: 'b@x.fr' }));
    expect(process_).toHaveBeenCalledWith(9);
  });
  it('échec d’envoi : journalisé avec le remède, sans lever ; demande laissée à la reprise', async () => {
    row = { id: 3, email: 'c@x.fr', firstName: 'C', isActive: false };
    process_.mockResolvedValue({ jobId: 9, status: 'pending', error: 'Template EMAIL_VERIFICATION not found' });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await resendVerification('c@x.fr')).toBe('failed');
    expect(err.mock.calls.flat().join(' ')).toMatch(/gabarit/);
    expect(err.mock.calls.flat().join(' ')).toMatch(/reprise automatique/);
    err.mockRestore();
  });
});
