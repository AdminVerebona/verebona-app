/**
 * Jeton de réinitialisation — parcours « Mot de passe oublié », partagé avec
 * l'action administrateur (CDC Back-Office V1 USR-A07).
 *
 * L'ancien jeton `base64(email:horodatage)` était fabricable par n'importe
 * qui. Le nouveau est signé et à usage unique.
 */
import { describe, it, expect } from 'vitest';
import {
  PASSWORD_RESET_TTL_MS,
  checkPasswordResetToken,
  createPasswordResetToken,
} from '@/services/auth/password-reset.service';

const secret = 'test-secret';
const user = { id: 12, email: 'jean@exemple.fr', passwordHash: '$2b$10$ancien' };
const now = 1_760_000_000_000;

describe('jeton de réinitialisation signé', () => {
  it('un jeton émis est accepté pendant une heure', () => {
    const token = createPasswordResetToken(user, now, secret);
    expect(checkPasswordResetToken(token, user, now + 1000, secret)).toEqual({ ok: true, userId: 12 });
    expect(checkPasswordResetToken(token, user, now + PASSWORD_RESET_TTL_MS + 1, secret))
      .toEqual({ ok: false, code: 'TOKEN_EXPIRED' });
  });

  it('l’ancien format forgé (base64 email:horodatage) est refusé', () => {
    const forged = Buffer.from(`${user.email}:${now}`).toString('base64');
    expect(checkPasswordResetToken(forged, user, now, secret)).toEqual({ ok: false, code: 'INVALID_TOKEN' });
  });

  it('une signature altérée ou un autre secret est refusé', () => {
    const token = createPasswordResetToken(user, now, secret);
    expect(checkPasswordResetToken(token, user, now, 'autre-secret').ok).toBe(false);
    const other = createPasswordResetToken({ ...user, id: 13 }, now, secret);
    expect(checkPasswordResetToken(other, user, now, secret).ok).toBe(false);
  });

  it('usage unique : après changement du mot de passe, le jeton ne vaut plus', () => {
    const token = createPasswordResetToken(user, now, secret);
    expect(checkPasswordResetToken(token, { ...user, passwordHash: '$2b$10$nouveau' }, now, secret).ok).toBe(false);
  });

  it('un jeton daté dans le futur est refusé', () => {
    const token = createPasswordResetToken(user, now + 10 * 60_000, secret);
    expect(checkPasswordResetToken(token, user, now, secret).ok).toBe(false);
  });
});
