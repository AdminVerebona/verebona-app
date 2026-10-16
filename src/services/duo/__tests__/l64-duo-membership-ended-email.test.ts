/**
 * Lot 64A — e-mail au membre quand son accès Premium Duo prend fin (unitaires).
 *
 * L64-MAIL-01  Gabarit : vouvoiement, prénom du titulaire, ce qui change, données
 *              conservées, liens compte / offre ; aucun motif (rétractation,
 *              impayé…), aucune adresse du titulaire. Migration 0459 = défaut du
 *              code = amorçage ; type accepté par la file (0459 + Drizzle).
 * L64-MAIL-02  Enregistrement : seulement pour une sortie REMOVED d'un membre
 *              ACTIF non titulaire ; LEFT, sortie rejouée, titulaire → rien.
 * L64-MAIL-03  Demande : destinataire = le membre, émetteur = le titulaire,
 *              clé d'idempotence membership × date d'entrée, contexte sans
 *              e-mail du titulaire ni motif ; doublon → pas de 2e demande.
 * L64-MAIL-04  Jamais bloquant : une erreur d'enregistrement est absorbée.
 * L64-MAIL-05  Branchement : `endMembership` enregistre la demande AVANT la
 *              mise à jour du membership, dans sa transaction ; BO et file.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { DEFAULT_EMAIL_TEMPLATES } from '@/lib/email-defaults';
import { duoMembershipEndedKey, enqueueDuoMembershipEndedEmail } from '../duo-membership-ended-email';

const ROOT = join(__dirname, '../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const dialect = new PgDialect();

/** Transaction simulée : rejoue des réponses par requête et garde le SQL rendu. */
function fakeTx(answers: Array<unknown[] | Error>) {
  const seen: { sql: string; params: unknown[] }[] = [];
  interface FakeTx { transaction<T>(cb: (sp: FakeTx) => Promise<T>): Promise<T>; execute(q: SQL): Promise<unknown> }
  const tx: FakeTx = {
    transaction: async <T>(cb: (sp: FakeTx) => Promise<T>) => cb(tx),
    execute: async (q: SQL) => {
      const r = dialect.sqlToQuery(q);
      seen.push({ sql: r.sql, params: r.params });
      const a = answers.shift() ?? [];
      if (a instanceof Error) throw a;
      return a;
    },
  };
  return { tx, seen };
}

const MEMBER = { status: 'ACTIVE', user_id: 22, since: '1760600000.123456', owner_id: 11, owner_first_name: ' Claire ', member_email: 'membre@test.invalid' };
const P = { duoId: 3, membershipId: 40, memberUserId: 22, status: 'REMOVED' as const };

describe('L64-MAIL-01 — gabarit DUO_MEMBERSHIP_ENDED', () => {
  const t = DEFAULT_EMAIL_TEMPLATES.DUO_MEMBERSHIP_ENDED;
  it('contenu sobre en vouvoiement, sans motif ni adresse du titulaire', () => {
    expect(t.subject).toMatch(/Votre accès à l'espace Premium Duo a pris fin/);
    expect(t.body).toContain('{{ownerFirstName}}');
    expect(t.body).toMatch(/vous n'avez plus accès à l'espace partagé/);
    expect(t.body).toMatch(/revient à votre propre offre/);
    expect(t.body).toMatch(/vos données personnelles sont conservés/);
    expect(t.body).toMatch(/^Accéder à mon compte : \{\{accountUrl\}\}$/m);
    expect(t.body).toMatch(/^Voir mon offre : \{\{subscriptionUrl\}\}$/m);
    expect(t.body).not.toMatch(/\btu\b|\bton\b|\bta\b|\btes\b/i);
    expect(`${t.subject}\n${t.body}`).not.toMatch(/rétract|impay|paiement|supprim[ée] son compte|ownerEmail|ownerLastName|ownerFullName/i);
    expect(JSON.parse(t.placeholders)).toEqual(['firstName', 'ownerFirstName', 'accountUrl', 'subscriptionUrl']);
  });

  it('migration 0459 = texte du code ; amorçage aligné ; type accepté par la file (SQL + Drizzle)', () => {
    const mig = read('src/db/migrations/0459_duo_membership_ended_email.sql');
    const sqlText = (s: string) => s.replace(/'/g, "''").replace(/\n/g, '\\n');
    expect(mig).toContain(sqlText(t.body));
    expect(mig).toContain(sqlText(t.subject));
    expect(mig).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM email_templates WHERE upper\(type\) = 'DUO_MEMBERSHIP_ENDED'\)/);
    expect(mig).toMatch(/CHECK \(kind IN \('EMAIL_VERIFICATION', 'DUO_INVITATION', 'DUO_MEMBERSHIP_ENDED'\)\)/);
    expect(mig).toMatch(/ADD COLUMN IF NOT EXISTS dedupe_key text/);
    expect(read('src/db/migrations/0459_duo_membership_ended_email_idx_1.sql')).toMatch(/CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS transactional_email_jobs_dedupe_key_idx/);
    expect(read('src/db/schema.ts')).toMatch(/'EMAIL_VERIFICATION', 'DUO_INVITATION', 'DUO_MEMBERSHIP_ENDED'/);
    expect(read('src/db/seeds/email_templates_system.ts')).toMatch(/DEFAULT_EMAIL_TEMPLATES\.DUO_MEMBERSHIP_ENDED\.body/);
  });
});

describe('L64-MAIL-02 — quand une demande est enregistrée', () => {
  it('membre qui part lui-même (LEFT) : aucune requête, aucun e-mail', async () => {
    const { tx, seen } = fakeTx([]);
    expect(await enqueueDuoMembershipEndedEmail(tx, { ...P, status: 'LEFT' })).toEqual({ jobId: null, skipped: 'NOT_REMOVED' });
    expect(seen).toHaveLength(0);
  });
  it('sortie rejouée (membership déjà REMOVED) : rien', async () => {
    const { tx, seen } = fakeTx([[{ ...MEMBER, status: 'REMOVED' }]]);
    expect(await enqueueDuoMembershipEndedEmail(tx, P)).toEqual({ jobId: null, skipped: 'NOT_ACTIVE' });
    expect(seen).toHaveLength(1);
    expect(seen[0].sql).toMatch(/FOR UPDATE OF m/);
  });
  it('titulaire, membership inconnu ou d’un autre utilisateur : rien', async () => {
    expect((await enqueueDuoMembershipEndedEmail(fakeTx([[{ ...MEMBER, owner_id: 22 }]]).tx, P)).skipped).toBe('OWNER');
    expect((await enqueueDuoMembershipEndedEmail(fakeTx([[]]).tx, P)).skipped).toBe('NOT_FOUND');
    expect((await enqueueDuoMembershipEndedEmail(fakeTx([[{ ...MEMBER, user_id: 99 }]]).tx, P)).skipped).toBe('NOT_FOUND');
  });
});

describe('L64-MAIL-03 — demande enregistrée', () => {
  it('destinataire = membre, émetteur = titulaire, clé par sortie, contexte discret', async () => {
    const { tx, seen } = fakeTx([[MEMBER], [], [{ id: 501 }]]);
    expect(await enqueueDuoMembershipEndedEmail(tx, P)).toEqual({ jobId: 501 });
    const key = duoMembershipEndedKey(40, MEMBER.since);
    expect(key).toBe('duo-membership-ended:40:1760600000.123456');
    expect(seen[1].sql).toMatch(/pg_advisory_xact_lock/);
    expect(seen[1].params).toEqual([`email-job:DUO_MEMBERSHIP_ENDED:${key}`]);
    const insert = seen[2];
    expect(insert.sql).toMatch(/INSERT INTO transactional_email_jobs/);
    expect(insert.sql).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM transactional_email_jobs WHERE dedupe_key = /);
    // kind, user_id (membre), triggered_by (titulaire), destinataire, contexte, clé.
    expect(insert.params.slice(0, 6)).toEqual(['DUO_MEMBERSHIP_ENDED', 22, 11, 'membre@test.invalid', expect.any(String), key]);
    const ctx = JSON.parse(insert.params[4] as string);
    expect(ctx).toEqual({ duoId: 3, membershipId: 40, ownerFirstName: 'Claire' });
    // duo_id NULL : la purge du titulaire (cascade sur le Duo) n'efface pas la demande.
    expect(insert.sql).toMatch(/\$2, NULL, \$3/);
  });
  it('même sortie déjà enregistrée : pas de seconde demande', async () => {
    const { tx } = fakeTx([[MEMBER], [], []]);
    expect(await enqueueDuoMembershipEndedEmail(tx, P)).toEqual({ jobId: null, skipped: 'DUPLICATE' });
  });
});

describe('L64-MAIL-04 — jamais bloquant', () => {
  it('erreur base (type refusé, table absente) : absorbée, la sortie continue', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { tx } = fakeTx([[MEMBER], [], new Error('violates check constraint "transactional_email_jobs_kind_check"')]);
    expect(await enqueueDuoMembershipEndedEmail(tx, P)).toEqual({ jobId: null, skipped: 'ERROR' });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('L64-MAIL-05 — branchement et exploitation', () => {
  it('endMembership : demande dans la transaction, AVANT la mise à jour du membership', () => {
    const src = read('src/services/duo/duo-exit.service.ts');
    const tx = src.indexOf('db.transaction(async (tx)');
    const enq = src.indexOf('await enqueueDuoMembershipEndedEmail(tx as never, p)');
    const upd = src.indexOf('await tx.update(duoMemberships)');
    expect(tx).toBeGreaterThan(0);
    expect(enq).toBeGreaterThan(tx);
    expect(upd).toBeGreaterThan(enq);
  });
  it('file : construction dédiée, adresse actuelle, comptes fermés exclus, désactivation BO sans reprise', () => {
    const src = read('src/services/email/transactional-email-jobs.service.ts');
    expect(src).toMatch(/job\.kind === 'DUO_MEMBERSHIP_ENDED' \? await buildDuoMembershipEnded\(job\)/);
    expect(src).toMatch(/to: built\.to \?\? job\.recipient_email/);
    expect(src).toMatch(/CLOSED_ACCOUNT_STATUSES = new Set\(\['SUSPENDED', 'PENDING_DELETION', 'DELETED'\]\)/);
    expect(src).toMatch(/res\?\.error === 'CHANNEL_DISABLED'/);
  });
  it('BO › Communications : gabarit listé, désactivable, suivi dans les envois durables', async () => {
    const { TRANSACTIONAL_EMAILS } = await import('@/services/admin/communications.service');
    expect(TRANSACTIONAL_EMAILS.map((e) => e.templateCode)).toContain('DUO_MEMBERSHIP_ENDED');
    const { transactionalLockReason } = await import('@/lib/notifications/channel-activation');
    expect(transactionalLockReason('DUO_MEMBERSHIP_ENDED')).toBeNull();
    expect(read('src/app/admin/communications/_components/TransactionalEmailsOps.tsx')).toContain("'DUO_MEMBERSHIP_ENDED'");
  });
});
