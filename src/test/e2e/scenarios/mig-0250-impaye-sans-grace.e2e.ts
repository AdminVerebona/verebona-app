/**
 * Migration 0250 (APP-FUNC-31) sur des comptes HISTORIQUES — CA-14, CA-15,
 * recette « migration d'un compte historique PAST_DUE_GRACE ».
 *
 * Le harnais construit sa base depuis le schéma Drizzle ACTUEL (0250 déjà
 * appliquée). Ce scénario crée donc SA base, la ramène à l'état d'avant 0250
 * (colonnes `past_due_grace_*` seules, statut PAST_DUE_GRACE autorisé, sans
 * déclencheur), y place des comptes historiques, puis vérifie :
 *   1. la correspondance avec le nouveau modèle, sans perte de date ;
 *   2. la sauvegarde des valeurs d'avant ;
 *   3. l'idempotence (seconde exécution sans effet) ;
 *   4. le retour arrière documenté dans l'en-tête de la migration.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import { expect, it } from 'vitest';
import { scenario } from '../scenario';
import { adminUrlFromEnv, bootstrapE2eDatabase, dropE2eDatabase } from '../db-bootstrap';

const MIG = join(process.cwd(), 'src', 'db', 'migrations', '0250_unpaid_cycle_no_grace.sql');

/** Retour arrière, tel que documenté dans l'en-tête de 0250 (lignes « -- »). */
function retourArriereDocumente(sqlText: string): string {
  const debut = sqlText.indexOf('Retour arrière documenté');
  const fin = sqlText.indexOf('Les colonnes `past_due_grace_*` étant tenues');
  return sqlText.slice(debut, fin).split('\n')
    .filter((l) => /^--\s{5}/.test(l))
    .map((l) => l.replace(/^--\s{5}/, ''))
    .join('\n');
}

scenario('MIG-0250', 'Migration 0250 : comptes historiques en période de grâce', () => {
  it('correspondance, sauvegarde, idempotence et retour arrière', async () => {
    const { runMigrationSql } = await import('@/db/migration-index');
    const admin = adminUrlFromEnv()!;
    const base = `verebona_e2e_mig0250_${Date.now()}`;
    const boot = await bootstrapE2eDatabase({ adminUrl: admin, database: base });
    const sql = postgres(boot.url, { max: 2, onnotice: () => undefined });
    try {
      const texte = await readFile(MIG, 'utf8');

      // ── État « avant 0250 » ───────────────────────────────────────────────
      await sql.unsafe(`
        DROP TRIGGER IF EXISTS accounts_unpaid_compat_trg ON accounts;
        DROP TRIGGER IF EXISTS duo_accounts_unpaid_compat_trg ON duo_accounts;
        DROP FUNCTION IF EXISTS accounts_unpaid_compat();
        DROP FUNCTION IF EXISTS duo_accounts_unpaid_compat();
        DROP TABLE IF EXISTS migration_0250_unpaid_backup;
        DROP INDEX IF EXISTS accounts_unpaid_started_at_idx;
        ALTER TABLE accounts DROP COLUMN IF EXISTS unpaid_started_at, DROP COLUMN IF EXISTS unpaid_recovery_ends_at;
        ALTER TABLE duo_accounts DROP COLUMN IF EXISTS unpaid_recovery_ends_at;
        -- Colonne des bases historiques (créée hors migration SQL).
        ALTER TABLE duo_accounts ADD COLUMN IF NOT EXISTS grace_deadline_at TIMESTAMPTZ;
        ALTER TABLE accounts DROP CONSTRAINT accounts_subscription_status_check;
        ALTER TABLE accounts ADD CONSTRAINT accounts_subscription_status_check CHECK (subscription_status IN
          ('NONE','ACTIVE','CANCELED','EXPIRED','PAST_DUE','PAST_DUE_GRACE','UNPAID_RECOVERY','TRIALING','WITHDRAWN'));
        CREATE INDEX IF NOT EXISTS accounts_past_due_grace_started_at_idx ON accounts (past_due_grace_started_at)
          WHERE past_due_grace_started_at IS NOT NULL;
        DELETE FROM _migrations WHERE filename = '0250_unpaid_cycle_no_grace.sql';`);

      const user = async (k: string) => (await sql<{ id: number }[]>`
        INSERT INTO users (email, password_hash, status) VALUES (${`m0250-${k}-${Date.now()}@test.invalid`}, 'x', 'ACTIVE') RETURNING id`)[0].id;
      const compte = async (k: string, status: string, extra: { started?: string; ends?: string; updated?: string; sub?: string } = {}) => {
        const u = await user(k);
        const [a] = await sql<{ id: number }[]>`
          INSERT INTO accounts (name, owner_user_id, subscription_status, past_due_grace_started_at, past_due_grace_ends_at, updated_at)
          VALUES (${k}, ${u}, ${status}, ${extra.started ?? null}, ${extra.ends ?? null}, ${extra.updated ?? new Date().toISOString()})
          RETURNING id`;
        if (extra.sub) await sql`INSERT INTO account_subscriptions (account_id, plan_code, status) VALUES (${a.id}, 'premium', ${extra.sub})`;
        return { id: a.id, user: u };
      };
      const t = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString();

      // A : grâce historique, droits encore ouverts (vestige), cycle daté.
      const A = await compte('A', 'PAST_DUE_GRACE', { started: t(-10), ends: t(80), sub: 'active' });
      // B : grâce sans J0 (cycle incomplet).
      const B = await compte('B', 'PAST_DUE_GRACE', { updated: t(-5), sub: 'past_due' });
      // C : payeur Duo en recouvrement, avec son Duo encore en « grâce ».
      const C = await compte('C', 'UNPAID_RECOVERY', { started: t(-10), ends: t(80), sub: 'past_due' });
      const [D] = await sql<{ id: number }[]>`
        INSERT INTO duo_accounts (billing_owner_user_id, subscription_status, first_payment_failed_at, grace_deadline_at)
        VALUES (${C.user}, 'PAST_DUE_GRACE', ${t(-10)}, ${t(5)}) RETURNING id`;
      await sql`UPDATE accounts SET duo_account_id = ${D.id} WHERE id = ${C.id}`;
      // E : actif, sans cycle — intact. F : rétracté — intact.
      const E = await compte('E', 'ACTIVE', { sub: 'active' });
      const F = await compte('F', 'WITHDRAWN', { sub: 'readonly' });

      const lire = async () => ({
        comptes: await sql`SELECT a.id, a.subscription_status, a.unpaid_started_at, a.unpaid_recovery_ends_at,
                                  a.past_due_grace_started_at, a.past_due_grace_ends_at, s.status AS sub
                             FROM accounts a LEFT JOIN account_subscriptions s ON s.account_id = a.id
                            WHERE a.id IN ${sql([A.id, B.id, C.id, E.id, F.id])} ORDER BY a.id`,
        duo: (await sql`SELECT subscription_status, unpaid_recovery_ends_at, grace_deadline_at FROM duo_accounts WHERE id = ${D.id}`)[0],
        sauvegarde: await sql`SELECT entity, entity_id, old_status FROM migration_0250_unpaid_backup ORDER BY entity, entity_id`,
      });
      const par = (rows: postgres.RowList<postgres.Row[]>, id: number) => rows.find((r) => r.id === id)!;

      // ── 1. Migration ──────────────────────────────────────────────────────
      await runMigrationSql(sql as never, texte);
      const apres = await lire();

      const a = par(apres.comptes, A.id);
      expect(a.subscription_status).toBe('PAST_DUE');
      expect(a.sub).toBe('past_due'); // CA-02 : plus de droits « de grâce »
      // Aucune date perdue : J0 et échéance (≥ J+90) repris des anciennes colonnes.
      expect(a.unpaid_started_at.getTime()).toBe(a.past_due_grace_started_at.getTime());
      expect(a.unpaid_recovery_ends_at.getTime()).toBeGreaterThanOrEqual(a.unpaid_started_at.getTime() + 90 * 86_400_000 - 1000);

      const b = par(apres.comptes, B.id);
      expect(b.subscription_status).toBe('PAST_DUE');
      expect(b.unpaid_started_at).not.toBeNull();
      // Préavis : jamais d'échéance à moins de 30 jours du déploiement.
      expect(b.unpaid_recovery_ends_at.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);

      const c = par(apres.comptes, C.id);
      expect(c.subscription_status).toBe('PAST_DUE');
      expect(apres.duo.subscription_status).toBe('UNPAID_RECOVERY');
      expect(apres.duo.unpaid_recovery_ends_at.getTime()).toBe(c.unpaid_recovery_ends_at.getTime());

      expect(par(apres.comptes, E.id)).toMatchObject({ subscription_status: 'ACTIVE', sub: 'active', unpaid_started_at: null });
      expect(par(apres.comptes, F.id)).toMatchObject({ subscription_status: 'WITHDRAWN', sub: 'readonly', unpaid_started_at: null });

      expect(apres.sauvegarde.map((r) => [r.entity, r.entity_id, r.old_status])).toEqual(expect.arrayContaining([
        ['account', A.id, 'PAST_DUE_GRACE'],
        ['account', B.id, 'PAST_DUE_GRACE'],
        ['account', C.id, 'UNPAID_RECOVERY'],
        ['account_subscription', A.id, 'active'],
        ['duo_account', D.id, 'PAST_DUE_GRACE'],
      ]));
      // L'échéance de grâce Duo d'origine est conservée dans la sauvegarde.
      expect((await sql`SELECT old_ends_at FROM migration_0250_unpaid_backup WHERE entity = 'duo_account' AND entity_id = ${D.id}`)[0].old_ends_at).not.toBeNull();

      // CA-15 : la contrainte refuse désormais l'ancien statut… sauf via
      // l'ancien code, normalisé par le déclencheur de compatibilité.
      await sql`UPDATE accounts SET subscription_status = 'PAST_DUE_GRACE' WHERE id = ${E.id}`;
      expect((await sql`SELECT subscription_status FROM accounts WHERE id = ${E.id}`)[0].subscription_status).toBe('PAST_DUE');
      await sql`UPDATE accounts SET subscription_status = 'ACTIVE' WHERE id = ${E.id}`;
      await sql`ALTER TABLE accounts DISABLE TRIGGER accounts_unpaid_compat_trg`;
      await expect(sql`UPDATE accounts SET subscription_status = 'PAST_DUE_GRACE' WHERE id = ${E.id}`).rejects.toThrow(/accounts_subscription_status_check/);
      await sql`ALTER TABLE accounts ENABLE TRIGGER accounts_unpaid_compat_trg`;

      // ── 2. Idempotence ────────────────────────────────────────────────────
      const avantRejeu = await lire();
      await runMigrationSql(sql as never, texte);
      const apresRejeu = await lire();
      expect(apresRejeu).toEqual(avantRejeu);

      // ── 3. Retour arrière documenté ───────────────────────────────────────
      const rollback = retourArriereDocumente(texte);
      expect(rollback).toContain('DROP TRIGGER IF EXISTS accounts_unpaid_compat_trg ON accounts;');
      await sql.unsafe(rollback);
      const retour = await lire();
      expect(par(retour.comptes, A.id)).toMatchObject({ subscription_status: 'PAST_DUE_GRACE', sub: 'active' });
      expect(par(retour.comptes, C.id).subscription_status).toBe('UNPAID_RECOVERY');
      expect(retour.duo.subscription_status).toBe('PAST_DUE_GRACE');
      // Les dates du cycle sont restées dans les anciennes colonnes.
      expect(par(retour.comptes, A.id).past_due_grace_started_at.getTime()).toBe(a.unpaid_started_at.getTime());
    } finally {
      await sql.end({ timeout: 5 });
      await dropE2eDatabase(admin, base, { force: true });
    }
  });
});
