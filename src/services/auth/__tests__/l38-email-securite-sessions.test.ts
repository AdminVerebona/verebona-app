/**
 * Lot 38 — volet B (décision PO, suite du lot 37 C2) : e-mail de sécurité
 * « appareils déconnectés par précaution » après la réutilisation d'un jeton
 * de renouvellement.
 *
 *   LOT 79C (décision PO) : l'e-mail est SUPPRIMÉ — le service d'envoi
 *   (`sessions-revoked-email.service.ts`) et ses tests L38-B-03 à L38-B-06
 *   sont retirés ; la non-émission est couverte par
 *   `l79c-sessions-revoked-supprime.test.ts`. Restent ici l'historique du
 *   gabarit (toujours en base, jamais envoyé) :
 *   L38-B-07  migration 0314 idempotente, seed et valeurs par défaut
 *             identiques, aperçu sans donnée manquante.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const { formatSecurityIncidentDate } = await import('@/lib/auth/security-email');
const { DEFAULT_EMAIL_TEMPLATES } = await import('@/lib/email-defaults');
const { TRANSACTIONAL_EMAILS, resolveTemplateVariables, MISSING_DATA_MARK } = await import('@/services/admin/communications.service');

describe('L38-B — date de l’incident (gabarit historique)', () => {
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

  it('Communications (BO) : listé comme supprimé (lot 79C), aperçu historique sans donnée manquante', () => {
    expect(TRANSACTIONAL_EMAILS.some((e) => e.templateCode === 'SECURITY_SESSIONS_REVOKED')).toBe(true);
    const def = DEFAULT_EMAIL_TEMPLATES.SECURITY_SESSIONS_REVOKED;
    const { variables, missingCount } = resolveTemplateVariables([def.subject, def.body],
      { firstName: 'Admin', lastName: 'BO', email: 'admin@verebona.fr', accountName: null, planLabel: null }, 'https://app.verebona.test/');
    expect(missingCount).toBe(0);
    expect(variables.forgotPasswordUrl).toBe('https://app.verebona.test/forgot-password');
    expect(Object.values(variables)).not.toContain(MISSING_DATA_MARK);
  });
});
