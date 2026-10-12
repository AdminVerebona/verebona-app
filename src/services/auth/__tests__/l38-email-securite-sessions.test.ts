/**
 * Lot 38 — volet B (décision PO, suite du lot 37 C2) : e-mail de sécurité
 * « appareils déconnectés par précaution » après la réutilisation d'un jeton
 * de renouvellement.
 *
 *   L38-B-03  envoi : gabarit système, variables limitées (aucune IP, aucun
 *             appareil, aucun jeton), lien « Mot de passe oublié » ;
 *   L38-B-04  au plus un e-mail par utilisateur et par heure ;
 *   L38-B-05  envoi APRÈS la réponse (détaché, ne lève jamais) ;
 *   L38-B-06  compte supprimé : aucun e-mail ;
 *   L38-B-07  gabarit modifiable au BO : migration 0314 idempotente, seed et
 *             valeurs par défaut identiques, listé dans Communications,
 *             aperçu sans donnée manquante.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  user: { email: 'alice@exemple.fr', firstName: 'Alice', isActive: true, status: 'ACTIVE' } as Record<string, unknown> | null,
  sent: [] as Array<{ templateCode: string; to: string; userId?: number; variables: Record<string, string> }>,
  sendResult: { success: true } as { success: boolean; error?: string },
  sendDelay: 0,
}));

vi.mock('@/db', () => ({
  db: {
    select: () => {
      const c = { from: () => c, where: () => c, limit: async () => (h.user ? [h.user] : []) };
      return c;
    },
  },
  pgClient: {},
}));
vi.mock('@/lib/email/email-service', () => ({
  emailService: {
    send: async (o: (typeof h.sent)[number]) => {
      if (h.sendDelay) await new Promise((r) => setTimeout(r, h.sendDelay));
      h.sent.push(o);
      return h.sendResult;
    },
  },
}));

const { sendSessionsRevokedEmail, scheduleSessionsRevokedEmail } = await import('../sessions-revoked-email.service');
const { AuthRateLimiter, MemoryAuthLimitStore, setAuthRateLimiterForTests, AUTH_LIMITS } = await import('@/lib/auth/auth-rate-limit');
const { settleDetachedAuthTasks } = await import('@/lib/auth/anti-enumeration');
const { SESSIONS_REVOKED_TEMPLATE, formatSecurityIncidentDate } = await import('@/lib/auth/security-email');
const { DEFAULT_EMAIL_TEMPLATES } = await import('@/lib/email-defaults');
const { TRANSACTIONAL_EMAILS, resolveTemplateVariables, MISSING_DATA_MARK } = await import('@/services/admin/communications.service');

let now = Date.parse('2026-10-11T16:05:00.000Z');

beforeEach(() => {
  h.user = { email: 'alice@exemple.fr', firstName: 'Alice', isActive: true, status: 'ACTIVE' };
  h.sent.length = 0;
  h.sendResult = { success: true };
  h.sendDelay = 0;
  now = Date.parse('2026-10-11T16:05:00.000Z');
  setAuthRateLimiterForTests(new AuthRateLimiter(new MemoryAuthLimitStore(), () => now));
  process.env.APP_URL = 'https://app.verebona.test';
});
afterEach(() => { setAuthRateLimiterForTests(null); delete process.env.APP_URL; });

describe('L38-B — e-mail « appareils déconnectés par précaution »', () => {
  it('L38-B-03 gabarit système, variables fermées : prénom, date, connexion, mot de passe oublié — jamais d’IP', async () => {
    expect(await sendSessionsRevokedEmail(1, new Date(now))).toBe('sent');
    expect(h.sent).toHaveLength(1);
    const [m] = h.sent;
    expect(m).toMatchObject({ templateCode: SESSIONS_REVOKED_TEMPLATE, to: 'alice@exemple.fr', userId: 1 });
    expect(Object.keys(m.variables).sort()).toEqual(['firstName', 'forgotPasswordUrl', 'incidentDate', 'loginUrl']);
    expect(m.variables).toMatchObject({
      firstName: 'Alice',
      loginUrl: 'https://app.verebona.test/login',
      forgotPasswordUrl: 'https://app.verebona.test/forgot-password',
      incidentDate: '11 octobre 2026 à 18 h 05',
    });
    expect(JSON.stringify(m.variables)).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|token|jti|sid/i);
  });

  it('L38-B-04 au plus un e-mail par utilisateur et par heure ; un autre utilisateur n’est pas freiné', async () => {
    expect(await sendSessionsRevokedEmail(1)).toBe('sent');
    now += 10 * 60_000;
    expect(await sendSessionsRevokedEmail(1)).toBe('throttled');
    expect(await sendSessionsRevokedEmail(2)).toBe('sent');
    now += 51 * 60_000; // plus d'une heure après le premier
    expect(await sendSessionsRevokedEmail(1)).toBe('sent');
    expect(h.sent.map((m) => m.userId)).toEqual([1, 2, 1]);
    expect(AUTH_LIMITS.securityEmailUser).toMatchObject({ maxAttempts: 1, windowMs: 3_600_000, lockMs: 3_600_000 });
  });

  it('L38-B-04b échec du fournisseur : compté quand même (aucune rafale de nouvelles tentatives)', async () => {
    h.sendResult = { success: false, error: 'provider down' };
    expect(await sendSessionsRevokedEmail(1)).toBe('failed');
    h.sendResult = { success: true };
    expect(await sendSessionsRevokedEmail(1)).toBe('throttled');
  });

  it('L38-B-05 envoi détaché : la planification rend la main avant l’envoi et ne lève jamais', async () => {
    h.sendDelay = 30;
    const t0 = Date.now();
    scheduleSessionsRevokedEmail(1);
    expect(Date.now() - t0).toBeLessThan(25);
    expect(h.sent).toHaveLength(0);
    await settleDetachedAuthTasks();
    expect(h.sent).toHaveLength(1);
    // Une erreur (base indisponible) est absorbée et journalisée.
    h.user = null;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => scheduleSessionsRevokedEmail(3)).not.toThrow();
    await settleDetachedAuthTasks();
    spy.mockRestore();
  });

  it('L38-B-06 compte supprimé ou introuvable : aucun e-mail', async () => {
    h.user = { email: 'x@y.fr', firstName: '', isActive: false, status: 'DELETED' };
    expect(await sendSessionsRevokedEmail(1)).toBe('no_recipient');
    h.user = null;
    expect(await sendSessionsRevokedEmail(2)).toBe('no_recipient');
    expect(h.sent).toHaveLength(0);
  });

  it('formatSecurityIncidentDate : fuseau Europe/Paris (heure d’hiver comprise)', () => {
    expect(formatSecurityIncidentDate(new Date('2026-12-01T08:30:00Z'))).toBe('1 décembre 2026 à 09 h 30');
  });
});

describe('L38-B-07 — gabarit système modifiable au BO', () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

  it('migration 0314 : insertion idempotente (DO NOTHING), même texte que les valeurs par défaut', () => {
    const sql = read('src/db/migrations/0314_security_sessions_revoked_email_template.sql');
    expect(sql).toMatch(/INSERT INTO email_templates \(type, subject, body, placeholders, updated_at\)/);
    expect(sql).toMatch(/ON CONFLICT \(type\) DO NOTHING/);
    const def = DEFAULT_EMAIL_TEMPLATES.SECURITY_SESSIONS_REVOKED;
    expect(sql).toContain(`'${def.subject.replace(/'/g, "''")}'`);
    expect(sql).toContain(`E'${def.body.replace(/'/g, "''").replace(/\n/g, '\\n')}'`);
    for (const v of ['firstName', 'incidentDate', 'loginUrl', 'forgotPasswordUrl']) expect(def.body).toContain(`{{${v}}}`);
    expect(def.body).toMatch(/Par précaution, nous avons déconnecté vos appareils/);
    expect(def.body).toMatch(/reconnectez-vous/);
    expect(def.body).toMatch(/Si ce n'était pas vous[\s\S]*changez votre mot de passe/);
    expect(def.body).not.toMatch(/\{\{\s*(ip|ipAddress|device|userAgent)\s*\}\}/i);
  });

  it('seed système : le gabarit est (ré)initialisé depuis les valeurs par défaut', () => {
    const seed = read('src/db/seeds/email_templates_system.ts');
    expect(seed).toContain("eq(emailTemplates.type, 'SECURITY_SESSIONS_REVOKED')");
    expect(seed).toContain('DEFAULT_EMAIL_TEMPLATES.SECURITY_SESSIONS_REVOKED.body');
  });

  it('Communications (BO) : e-mail transactionnel listé, aperçu sans donnée manquante', () => {
    expect(TRANSACTIONAL_EMAILS.some((e) => e.templateCode === 'SECURITY_SESSIONS_REVOKED')).toBe(true);
    const def = DEFAULT_EMAIL_TEMPLATES.SECURITY_SESSIONS_REVOKED;
    const { variables, missingCount } = resolveTemplateVariables([def.subject, def.body],
      { firstName: 'Admin', lastName: 'BO', email: 'admin@verebona.fr', accountName: null, planLabel: null }, 'https://app.verebona.test/');
    expect(missingCount).toBe(0);
    expect(variables.forgotPasswordUrl).toBe('https://app.verebona.test/forgot-password');
    expect(Object.values(variables)).not.toContain(MISSING_DATA_MARK);
  });
});
