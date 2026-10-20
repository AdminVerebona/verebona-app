/**
 * Lot 65A — e-mail au membre qui QUITTE lui-même un Premium Duo, et
 * verrouillage des e-mails de fin d'accès dans le BO (décisions PO du 16/10).
 *
 * L65-MAIL-01  Gabarit dédié DUO_MEMBERSHIP_LEFT : vouvoiement, confirmation du
 *              départ, conséquences, retour à son offre, données conservées,
 *              liens compte / offre ; ni motif ni adresse du titulaire.
 *              Migration 0462 = défaut du code = amorçage ; type accepté par
 *              la file (0462 + Drizzle).
 * L65-MAIL-02  Enregistrement d'un départ (LEFT) : kind LEFT, destinataire =
 *              membre, émetteur = le membre lui-même, clé d'idempotence
 *              propre, contexte discret ; doublon → pas de 2e demande.
 * L65-MAIL-03  Pas de doublon avec la suppression de compte : `notify: false`
 *              (suppression volontaire, balayage) → aucune requête.
 * L65-MAIL-04  Branchements : `leaveDuo` notifie, la suppression de compte
 *              non ; ancienne route `DuoService.leaveDuo` notifie aussi, dans
 *              sa transaction, avant la mise à jour ; file et BO.
 * L65-LOCK-01  DUO_MEMBERSHIP_ENDED et DUO_MEMBERSHIP_LEFT verrouillés comme
 *              DUO_INVITATION : motif affiché, toujours actifs, désactivation
 *              refusée (CHANNEL_LOCKED) même si une ligne « désactivé »
 *              subsiste en base.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { DEFAULT_EMAIL_TEMPLATES } from '@/lib/email-defaults';
import {
  DUO_MEMBERSHIP_LEFT, duoMembershipEndedKey, duoMembershipLeftKey, enqueueDuoMembershipEndedEmail,
} from '../duo-membership-ended-email';

const ROOT = join(__dirname, '../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const dialect = new PgDialect();

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
const P = { duoId: 3, membershipId: 40, memberUserId: 22, status: 'LEFT' as const };

describe('L65-MAIL-01 — gabarit DUO_MEMBERSHIP_LEFT', () => {
  const t = DEFAULT_EMAIL_TEMPLATES.DUO_MEMBERSHIP_LEFT;
  it('confirmation sobre en vouvoiement, sans motif ni adresse du titulaire', () => {
    expect(t.subject).toBe("Vous avez quitté l'espace Premium Duo");
    expect(t.body).toMatch(/Vous avez quitté l'espace Premium Duo que vous partagiez avec \{\{ownerFirstName\}\}/);
    expect(t.body).toMatch(/vous n'avez plus accès à l'espace partagé/);
    expect(t.body).toMatch(/revient à votre propre offre/);
    expect(t.body).toMatch(/vos données personnelles sont conservés/);
    expect(t.body).toMatch(/nouvelle invitation du titulaire/);
    expect(t.body).toMatch(/Si vous n'êtes pas à l'origine de ce départ/);
    expect(t.body).toMatch(/^Accéder à mon compte : \{\{accountUrl\}\}$/m);
    expect(t.body).toMatch(/^Voir mon offre : \{\{subscriptionUrl\}\}$/m);
    // Pas de tutoiement (frontières Unicode : « êtes » n'est pas « tes »).
    expect(t.body).not.toMatch(/(?<!\p{L})(?:tu|ton|ta|tes)(?!\p{L})/iu);
    expect(`${t.subject}\n${t.body}`).not.toMatch(/rétract|impay|paiement|ownerEmail|ownerLastName|ownerFullName/i);
    // Lot 73A : + {{dataExportUrl}} (rappel d'export, migration 0527).
    expect(JSON.parse(t.placeholders)).toEqual(['firstName', 'ownerFirstName', 'accountUrl', 'subscriptionUrl', 'dataExportUrl']);
    // Distinct du gabarit de fin subie.
    expect(t.subject).not.toBe(DEFAULT_EMAIL_TEMPLATES.DUO_MEMBERSHIP_ENDED.subject);
  });

  it('migration 0462 = texte du code ; amorçage aligné ; type accepté par la file (SQL + Drizzle)', () => {
    const mig = read('src/db/migrations/0462_duo_membership_left_email.sql');
    const sqlText = (s: string) => s.replace(/'/g, "''").replace(/\n/g, '\\n');
    // Lot 73A : le texte livré ACTUEL est posé par la 0527 (rappel d'export) ;
    // la 0462 crée toujours le gabarit (texte du lot 64/65).
    expect(mig).toMatch(/INSERT INTO email_templates/);
    expect(mig).toContain(sqlText(t.subject));
    const l73 = read('src/db/migrations/0527_l73a_duo_rappel_export.sql');
    expect(l73).toContain(t.body);
    expect(l73).toContain(t.subject);
    expect(mig).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM email_templates WHERE upper\(type\) = 'DUO_MEMBERSHIP_LEFT'\)/);
    expect(mig).toMatch(/CHECK \(kind IN \('EMAIL_VERIFICATION', 'DUO_INVITATION', 'DUO_MEMBERSHIP_ENDED', 'DUO_MEMBERSHIP_LEFT'\)\)/);
    expect(mig).toMatch(/SET LOCAL lock_timeout/);
    // Lot 68C : d'autres types peuvent suivre (SUBSCRIPTION_ANNUAL_RENEWAL_REMINDER, 0477).
    expect(read('src/db/schema.ts')).toMatch(/'DUO_MEMBERSHIP_ENDED', 'DUO_MEMBERSHIP_LEFT'(, '[A-Z_]+')*\)/);
    expect(read('src/db/seeds/email_templates_system.ts')).toMatch(/DEFAULT_EMAIL_TEMPLATES\.DUO_MEMBERSHIP_LEFT\.body/);
  });
});

describe('L65-MAIL-02 — départ volontaire enregistré', () => {
  it('kind LEFT, destinataire et émetteur = le membre, clé propre, contexte discret', async () => {
    const { tx, seen } = fakeTx([[MEMBER], [], [{ id: 777 }]]);
    expect(await enqueueDuoMembershipEndedEmail(tx, P)).toEqual({ jobId: 777 });
    const key = duoMembershipLeftKey(40, MEMBER.since);
    expect(key).toBe('duo-membership-left:40:1760600000.123456');
    expect(key).not.toBe(duoMembershipEndedKey(40, MEMBER.since));
    expect(seen[0].sql).toMatch(/FOR UPDATE OF m/);
    expect(seen[1].params).toEqual([`email-job:DUO_MEMBERSHIP_LEFT:${key}`]);
    const insert = seen[2];
    expect(insert.sql).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM transactional_email_jobs WHERE dedupe_key = /);
    expect(insert.params.slice(0, 6)).toEqual([DUO_MEMBERSHIP_LEFT, 22, 22, 'membre@test.invalid', expect.any(String), key]);
    expect(JSON.parse(insert.params[4] as string)).toEqual({ duoId: 3, membershipId: 40, ownerFirstName: 'Claire' });
    expect(insert.sql).toMatch(/\$2, NULL, \$3/);
  });

  it('départ rejoué, membership déjà sorti, titulaire : rien ; doublon : pas de 2e demande', async () => {
    expect((await enqueueDuoMembershipEndedEmail(fakeTx([[{ ...MEMBER, status: 'LEFT' }]]).tx, P)).skipped).toBe('NOT_ACTIVE');
    expect((await enqueueDuoMembershipEndedEmail(fakeTx([[{ ...MEMBER, owner_id: 22 }]]).tx, P)).skipped).toBe('OWNER');
    expect(await enqueueDuoMembershipEndedEmail(fakeTx([[MEMBER], [], []]).tx, P)).toEqual({ jobId: null, skipped: 'DUPLICATE' });
  });
});

describe('L65-MAIL-03 — pas de doublon avec la suppression de son compte', () => {
  it('notify: false → aucune requête (l’e-mail de suppression suffit)', async () => {
    const { tx, seen } = fakeTx([]);
    expect(await enqueueDuoMembershipEndedEmail(tx, { ...P, notify: false })).toEqual({ jobId: null, skipped: 'SILENT' });
    expect(seen).toHaveLength(0);
  });

  it('suppression volontaire : départ du Duo sans e-mail ; le balayage J+30 passe par la même fonction', () => {
    const src = read('src/services/account/voluntary-deletion.service.ts');
    expect(src).toContain('await leaveDuo(userId, { notifyMember: false })');
    expect(src.match(/await leaveDuo\(/g)).toHaveLength(1);
    expect(src).toContain('detachSharing: detachSharingDefault');
    // L'e-mail de suppression existe bien (confirmation à la clôture).
    expect(src).toMatch(/type: 'ACCOUNT_DELETION_SCHEDULED', userId: user\.id/);
  });
});

describe('L65-MAIL-04 — branchements', () => {
  it('endMembership transmet le statut et `notifyMember` ; leaveDuo notifie par défaut', () => {
    const src = read('src/services/duo/duo-exit.service.ts');
    expect(src).toMatch(/status: p\.status,\s+notify: p\.notifyMember !== false/);
    expect(src).toMatch(/export async function leaveDuo\(userId: number, opts: \{ notifyMember\?: boolean \} = \{\}\)/);
    expect(src).toMatch(/status: 'LEFT',\s+notifyMember: opts\.notifyMember !== false/);
    // Route utilisée par l'interface (« Quitter le Duo ») : appel sans option.
    expect(read('src/app/api/duo/leave/route.ts')).toContain('await leaveDuo(session.userId)');
  });

  it('ancienne route POST /api/duos/:id/leave : même e-mail, dans la transaction, avant la mise à jour', () => {
    const src = read('src/services/duo.service.ts');
    const start = src.indexOf('static async leaveDuo(');
    const body = src.slice(start, start + 2500);
    const tx = body.indexOf('db.transaction(async (tx)');
    const enq = body.indexOf('await enqueueDuoMembershipEndedEmail(tx as never, {');
    const upd = body.indexOf("status: 'LEFT',\n          slot: null");
    expect(tx).toBeGreaterThan(0);
    expect(enq).toBeGreaterThan(tx);
    expect(upd).toBeGreaterThan(enq);
    expect(body).toMatch(/eq\(duoMemberships\.status, 'ACTIVE'\)/);
  });

  it('file : même construction (gabarit choisi par type) ; BO : gabarit listé et suivi', async () => {
    const src = read('src/services/email/transactional-email-jobs.service.ts');
    expect(src).toMatch(/templateCode: job\.kind === 'DUO_MEMBERSHIP_LEFT' \? 'DUO_MEMBERSHIP_LEFT' : 'DUO_MEMBERSHIP_ENDED'/);
    const { TRANSACTIONAL_EMAILS } = await import('@/services/admin/communications.service');
    expect(TRANSACTIONAL_EMAILS.map((e) => e.templateCode)).toContain('DUO_MEMBERSHIP_LEFT');
    expect(read('src/app/admin/communications/_components/TransactionalEmailsOps.tsx')).toContain("'DUO_MEMBERSHIP_LEFT'");
    expect(read('src/services/admin/transactional-email-logs.service.ts')).toMatch(/REQUIRED_TEMPLATES = \[[^\]]*'DUO_MEMBERSHIP_LEFT'/);
  });
});

describe('L65-LOCK-01 — verrouillage BO comme DUO_INVITATION', () => {
  it('motif affiché, canal toujours actif dans la vue même si la base dit « désactivé »', async () => {
    const { transactionalLockReason } = await import('@/lib/notifications/channel-activation');
    expect(transactionalLockReason('DUO_INVITATION')).toBeTruthy();
    for (const code of ['DUO_MEMBERSHIP_ENDED', 'DUO_MEMBERSHIP_LEFT']) {
      expect(transactionalLockReason(code), code).toMatch(/obligatoire/);
      expect(transactionalLockReason(code.toLowerCase()), code).toMatch(/obligatoire/);
    }
    const { listEventDefinitions, buildCommunicationsView, settingKey } = await import('@/services/admin/communications.service');
    const defs = listEventDefinitions([]);
    const settings = new Map<string, boolean>([
      [settingKey('email:DUO_MEMBERSHIP_ENDED', 'email'), false],
      [settingKey('email:DUO_MEMBERSHIP_LEFT', 'email'), false],
    ]);
    const view = buildCommunicationsView(defs, settings, new Map());
    const events = view.flatMap((g) => g.events);
    for (const code of ['email:DUO_INVITATION', 'email:DUO_MEMBERSHIP_ENDED', 'email:DUO_MEMBERSHIP_LEFT']) {
      const ev = events.find((e) => e.code === code)!;
      expect(ev, code).toBeTruthy();
      expect(ev.channels[0]).toMatchObject({ channel: 'email', locked: true, active: true });
      expect(ev.channels[0].lockReason).toBeTruthy();
    }
  });
});
