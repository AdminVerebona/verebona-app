/**
 * Journal de rétractation — CDC 6 §16 et §18.
 *
 * Le masquage décide de ce qui finit écrit noir sur blanc dans une table
 * conservée des années et consultée par des administrateurs. Il mérite d'être
 * vérifié champ par champ.
 */
import { describe, it, expect } from 'vitest';
import { maskSensitive } from '@/services/withdrawal/withdrawal-journal.service';

describe('masquage des données sensibles (§16)', () => {
  it('masque une adresse électronique en la laissant reconnaissable', () => {
    const out = maskSensitive({ email: 'jean.dupont@exemple.fr' }) as Record<string, string>;
    expect(out.email).toBe('je*********@exemple.fr');
    expect(out.email).not.toContain('dupont');
  });

  it('masque une adresse IPv4 en conservant le réseau', () => {
    // Le réseau reste utile au diagnostic ; l'hôte ne l'est pas.
    const out = maskSensitive({ ipAddress: '192.168.12.34' }) as Record<string, string>;
    expect(out.ipAddress).toBe('192.168.x.x');
  });

  it('masque une adresse IPv6', () => {
    const out = maskSensitive({ ip: '2001:db8:1234:5678::1' }) as Record<string, string>;
    expect(out.ip).toBe('2001:db8:***');
  });

  it('réduit un jeton à sa longueur', () => {
    const out = maskSensitive({ token: 'abcdef123456' }) as Record<string, string>;
    expect(out.token).toBe('***(12)');
    expect(out.token).not.toContain('abcdef');
  });

  it('masque en profondeur dans les objets imbriqués', () => {
    const out = maskSensitive({
      declaration: { receiptEmail: 'a.b@c.fr', channel: 'public' },
    }) as { declaration: Record<string, string> };
    expect(out.declaration.receiptEmail).not.toContain('a.b@');
    expect(out.declaration.channel).toBe('public');
  });

  it('masque dans les tableaux', () => {
    const out = maskSensitive({
      contacts: [{ email: 'x@y.fr' }, { email: 'z@w.fr' }],
    }) as { contacts: Array<Record<string, string>> };
    expect(out.contacts[0].email).not.toBe('x@y.fr');
    expect(out.contacts[1].email).not.toBe('z@w.fr');
  });

  it('laisse intactes les données non sensibles', () => {
    const payload = {
      amount: 5900,
      status: 'succeeded',
      refundId: 're_123',
      paymentId: 'pi_456',
      excluded: [{ paymentId: 'pi_789', reason: 'déjà remboursé' }],
    };
    expect(maskSensitive(payload)).toEqual(payload);
  });

  it('traverse les valeurs nulles sans échouer', () => {
    expect(maskSensitive({ email: null, ip: undefined })).toEqual({ email: null, ip: undefined });
  });

  it('n’altère pas un identifiant Stripe, qui n’est pas un secret', () => {
    // Ces identifiants sont nécessaires au rapprochement comptable : les
    // masquer rendrait le journal inexploitable pour ce à quoi il sert.
    const out = maskSensitive({ refundId: 're_3Abc', paymentId: 'pi_3Xyz' });
    expect(out).toEqual({ refundId: 're_3Abc', paymentId: 'pi_3Xyz' });
  });
});
