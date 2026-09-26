/**
 * Demandes système (CDC BO GDP-007 à GDP-009) : quelles suppressions
 * alimentent le registre, et le branchement dans les workflows existants.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: undefined, db: undefined }));

import { deletionCreatesGdprRequest, onDeletionScheduled, onDeletionFailed } from '../system-requests';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('suppressions alimentant le registre RGPD', () => {
  it('initiées par l’utilisateur : demande volontaire et rétractation', () => {
    expect(deletionCreatesGdprRequest('VOLUNTARY', 'user')).toBe(true);
    expect(deletionCreatesGdprRequest('WITHDRAWAL', 'user')).toBe(true);
  });
  it('pas la purge d’un essai abandonné, ni une suppression engagée depuis le BO', () => {
    expect(deletionCreatesGdprRequest('TRIAL_ABANDONED', 'system')).toBe(false);
    expect(deletionCreatesGdprRequest('ADMIN', 'admin')).toBe(false);
  });
});

describe('best-effort : le registre ne bloque jamais le fait générateur', () => {
  it('une base indisponible ne fait pas lever les hooks', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(onDeletionScheduled({
      id: 1, accountId: 2, userId: 3, reason: 'VOLUNTARY', origin: 'user',
      confirmedAt: new Date(), scheduledAt: new Date(),
    })).resolves.toBeUndefined();
    await expect(onDeletionFailed(1, 'boom')).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('branchements', () => {
  const deletion = read('src/services/account/scheduled-deletion.service.ts');

  it('planification, annulation, exécution et échec d’une suppression', () => {
    for (const hook of ['onDeletionScheduled(created)', 'onDeletionCancelled(row.id, reason)', 'onDeletionExecuted(scheduleId, now)', 'onDeletionFailed(scheduleId, reason)']) {
      expect(deletion).toContain(hook);
    }
  });

  it('le registre survit à la cascade (pas purgé comme orphelin)', () => {
    expect(deletion).toMatch(/SURVIVING_TABLES = new Set\(\[[\s\S]*'gdpr_requests'/);
  });

  it('suppression en libre-service (DELETE /api/users/me)', () => {
    expect(read('src/app/api/users/me/route.ts')).toContain('onSelfServiceDeletion(session.userId');
  });

  it('les écritures système ne touchent jamais une demande manuelle', () => {
    expect(read('src/services/gdpr/system-requests.ts')).toContain("WHERE origin = 'system'");
  });

  it('la réouverture ne réécrit pas l’échéance (GDP-017)', () => {
    const repo = read('src/services/gdpr/gdpr-request.repository.ts');
    const reopen = repo.slice(repo.indexOf('export async function reopenManualRequest'));
    expect(reopen).not.toMatch(/due_date\s*=/);
  });
});
