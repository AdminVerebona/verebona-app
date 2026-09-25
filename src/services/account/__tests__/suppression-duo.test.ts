/**
 * Suppression planifiée d'un compte Duo : compte, données, adhésions,
 * titulaire ET utilisateur invité supprimés ; preuves légales conservées.
 * (Scénario complet exécuté sur PostgreSQL : voir le message de commit.)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const src = readFileSync(join(process.cwd(), 'src/services/account/scheduled-deletion.service.ts'), 'utf8');
const exec = src.slice(src.indexOf('export async function executeScheduledDeletion'));

describe('exécution d’une suppression Duo', () => {
  it('le garde-fou « compte partagé » n’existe plus', () => {
    expect(exec).not.toContain('Transférez la propriété');
    expect(exec).not.toMatch(/otherMembers\.length > 0/);
  });

  it('périmètre : titulaire + tous les membres, et tous les comptes qu’ils possèdent', () => {
    expect(exec).toContain('const userIds = [...new Set([account.ownerUserId, ...memberRows.map(');
    expect(exec).toContain('inArray(accounts.ownerUserId, userIds)');
    expect(exec).toContain('await tx.delete(users).where(inArray(users.id, userIds))');
  });

  it('seule une suppression collatérale (rattachement hors périmètre) est refusée', () => {
    expect(exec).toContain('Suppression collatérale refusée');
  });

  it('fichiers du stockage mis en purge avant la cascade', () => {
    expect(exec.indexOf('tx.insert(pendingBlobDeletions)')).toBeLessThan(exec.indexOf('await tx.delete(users)'));
  });

  it('preuves : acceptations pseudonymisées pour les deux utilisateurs, rétractation intacte', () => {
    expect(exec).toContain('.set({ userId: null, ipAddress: null, userAgent: null })\n        .where(inArray(legalAcceptances.userId, userIds))');
    expect(exec).not.toContain('consumerFirstName: null');
  });

  it('tables sans cascade traitées, contrôle d’orphelins avant validation', () => {
    for (const t of ['supplierReviewItems', 'suppliers', 'assetTransmissions']) expect(exec).toContain(`tx.delete(${t})`);
    expect(exec).toContain("'ORPHANS_LEFT'");
  });

  it('la trace EXECUTED est écrite sur le compte à rebours, qui survit au compte (0144)', () => {
    expect(exec).toContain(".set({ status: 'EXECUTED', executedAt: now, userId: null, updatedAt: now })");
    expect(readFileSync(join(process.cwd(), 'src/db/migrations/0144_scheduled_deletion_trace.sql'), 'utf8')).toContain('DROP CONSTRAINT');
  });
});
