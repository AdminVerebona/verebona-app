/**
 * Carte #876 — comptes de revue Apple / Google : exemption CIBLÉE de
 * l'obligation globale de double authentification.
 *
 *   1. décision pure (`appReviewEligibility`) : toutes les conditions, fail closed ;
 *   2. décision centrale (`mfaRequirementFor`) : clients existants / nouveaux,
 *      obligation active / inactive, administrateurs, identité autorisée / non
 *      autorisée, facteur enrôlé, révocation, rôle et appartenance modifiés,
 *      erreur serveur ;
 *   3. garde centrale : accès AAL1 de l'identité de revue, aucun faux AAL2 ;
 *   4. architecture : identification par état serveur seulement (jamais
 *      e-mail, en-tête, appareil, IP), aucune décision côté client, migration
 *      additive (comptes clients inchangés).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { appReviewEligibility, appReviewFactsFromRow, type AppReviewFacts } from '../app-review';
import { __setMfaPolicyStoreForTests, mfaRequirementFor, type MfaPolicyState } from '../policy';
import { assertMfaSatisfied } from '../guard';
import { MFA_REQUIRED_CODE } from '../constants';
import { isStrongSession } from '../assurance';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const reviewer = (over: Partial<AppReviewFacts> = {}): AppReviewFacts => ({
  role: 'USER', status: 'ACTIVE', exemptionAccountId: 42, exemptionAccountKind: 'APPLE',
  hasAccessToExemptionAccount: true, foreignAccessibleAccounts: 0, ...over,
});

describe('C876-ELIG décision pure : toutes les conditions, sinon aucune exemption', () => {
  it('identité autorisée, USER active, compte de revue accessible, aucun autre compte : exemptée', () => {
    expect(appReviewEligibility(reviewer())).toEqual({ exempt: true, kind: 'APPLE', accountId: 42 });
    expect(appReviewEligibility(reviewer({ exemptionAccountKind: 'GOOGLE' }))).toMatchObject({ exempt: true, kind: 'GOOGLE' });
  });
  it('aucune autorisation (défaut, révoquée) : pas d’exemption', () => {
    expect(appReviewEligibility(null)).toEqual({ exempt: false, reason: 'NO_EXEMPTION' });
    expect(appReviewEligibility(undefined)).toEqual({ exempt: false, reason: 'NO_EXEMPTION' });
    expect(appReviewEligibility(reviewer({ exemptionAccountId: null }))).toEqual({ exempt: false, reason: 'NO_EXEMPTION' });
  });
  it('administrateurs et rôles inconnus : jamais exemptés', () => {
    for (const role of ['ADMIN', 'SUPER_ADMIN', 'user', '', null]) {
      expect(appReviewEligibility(reviewer({ role }))).toEqual({ exempt: false, reason: 'ROLE_NOT_ELIGIBLE' });
    }
  });
  it('identité suspendue, clôturée ou non vérifiée : pas d’exemption', () => {
    for (const status of ['SUSPENDED', 'PENDING_DELETION', 'DELETED', 'PENDING_VERIFICATION', null]) {
      expect(appReviewEligibility(reviewer({ status }))).toEqual({ exempt: false, reason: 'STATUS_NOT_ACTIVE' });
    }
  });
  it('compte non (ou plus) qualifié, valeur inattendue : pas d’exemption', () => {
    for (const k of [null, 'CLIENT', 'apple', 'AI_QUALIFICATION_CORPUS']) {
      expect(appReviewEligibility(reviewer({ exemptionAccountKind: k }))).toEqual({ exempt: false, reason: 'ACCOUNT_NOT_QUALIFIED' });
    }
  });
  it('appartenance retirée / quittée : pas d’exemption', () => {
    expect(appReviewEligibility(reviewer({ hasAccessToExemptionAccount: false }))).toEqual({ exempt: false, reason: 'NO_ACCESS_TO_REVIEW_ACCOUNT' });
  });
  it('accès à un compte client réel ou d’un autre store (invitation acceptée…) : exemption suspendue ; état inconnu : aucune', () => {
    expect(appReviewEligibility(reviewer({ foreignAccessibleAccounts: 1 }))).toEqual({ exempt: false, reason: 'OTHER_ACCOUNT_ACCESS' });
    expect(appReviewEligibility(reviewer({ foreignAccessibleAccounts: -1 }))).toEqual({ exempt: false, reason: 'OTHER_ACCOUNT_ACCESS' });
    expect(appReviewEligibility(reviewer({ foreignAccessibleAccounts: Number.NaN }))).toEqual({ exempt: false, reason: 'OTHER_ACCOUNT_ACCESS' });
  });
  it('ligne SQL → faits : valeurs absentes = fail closed', () => {
    const f = appReviewFactsFromRow({ role: 'USER', status: 'ACTIVE', review_account_id: '42', review_account_kind: 'APPLE', review_has_access: null, review_foreign_accounts: null });
    expect(f).toMatchObject({ exemptionAccountId: 42, hasAccessToExemptionAccount: false, foreignAccessibleAccounts: -1 });
    expect(appReviewEligibility(f).exempt).toBe(false);
  });
});

describe('C876-POLICY décision MFA centrale (obligation globale neutralisée pour la SEULE identité autorisée)', () => {
  const now = new Date('2026-12-01T10:00:00Z');
  const ON = { users: new Date('2026-11-01T00:00:00Z'), admins: new Date('2026-11-01T00:00:00Z') };
  const OFF = { users: null, admins: null };
  let state: MfaPolicyState | null = null;
  let fail = false;
  beforeEach(() => {
    __setMfaPolicyStoreForTests({
      load: async () => { if (fail) throw new Error('ECONNREFUSED'); return state; },
      readSettings: async () => OFF,
      writeSetting: async () => {},
    });
  });
  afterEach(() => { fail = false; state = null; __setMfaPolicyStoreForTests(null); });

  it('client existant / nouveau, obligation active : MFA requise (inchangé)', async () => {
    state = { role: 'USER', enabledAt: null, settings: ON };
    expect(await mfaRequirementFor(1, now)).toMatchObject({ required: true, enforced: true, exempt: false, reviewKind: null });
    state = { role: 'USER', enabledAt: null, settings: ON, appReview: null };
    expect(await mfaRequirementFor(1, now)).toMatchObject({ required: true, exempt: false });
  });
  it('identité de revue autorisée, obligation active : MFA non requise, exemption tracée', async () => {
    state = { role: 'USER', enabledAt: null, settings: ON, appReview: reviewer() };
    expect(await mfaRequirementFor(1, now)).toEqual({ required: false, enrolled: false, enforced: true, exempt: true, reviewKind: 'APPLE', role: 'USER' });
  });
  it('obligation inactive : aucune exemption utile (comportement inchangé, MFA non requise)', async () => {
    state = { role: 'USER', enabledAt: null, settings: OFF, appReview: reviewer() };
    expect(await mfaRequirementFor(1, now)).toMatchObject({ required: false, enforced: false, exempt: false, reviewKind: null });
  });
  it('facteur DÉJÀ enrôlé : toujours exigé, même pour une identité de revue autorisée', async () => {
    state = { role: 'USER', enabledAt: new Date('2026-10-01T00:00:00Z'), settings: ON, appReview: reviewer() };
    expect(await mfaRequirementFor(1, now)).toMatchObject({ required: true, enrolled: true, exempt: false });
    state = { role: 'USER', enabledAt: new Date('2026-10-01T00:00:00Z'), settings: OFF, appReview: reviewer() };
    expect(await mfaRequirementFor(1, now)).toMatchObject({ required: true, exempt: false });
  });
  it('administrateur : jamais exempté (même si une ligne existait)', async () => {
    state = { role: 'ADMIN', enabledAt: null, settings: ON, appReview: reviewer({ role: 'ADMIN' }) };
    expect(await mfaRequirementFor(1, now)).toMatchObject({ required: true, exempt: false });
    state = { role: 'SUPER_ADMIN', enabledAt: null, settings: ON, appReview: reviewer({ role: 'SUPER_ADMIN' }) };
    expect(await mfaRequirementFor(1, now)).toMatchObject({ required: true, exempt: false });
  });
  it('rôle modifié entre les faits et la décision (incohérence) : aucune exemption', async () => {
    state = { role: 'ADMIN', enabledAt: null, settings: ON, appReview: reviewer({ role: 'USER' }) };
    expect(await mfaRequirementFor(1, now)).toMatchObject({ required: true, exempt: false });
  });
  it('révocation, retrait de qualification, appartenance changée : règle normale réimposée', async () => {
    for (const f of [null, reviewer({ exemptionAccountKind: null }), reviewer({ hasAccessToExemptionAccount: false }), reviewer({ foreignAccessibleAccounts: 2 }), reviewer({ status: 'SUSPENDED' })]) {
      state = { role: 'USER', enabledAt: null, settings: ON, appReview: f };
      expect(await mfaRequirementFor(1, now)).toMatchObject({ required: true, exempt: false });
    }
  });
  it('erreur serveur : SESSION_UNAVAILABLE, jamais une exemption ; utilisateur absent : MFA requise', async () => {
    fail = true;
    await expect(mfaRequirementFor(1, now)).rejects.toThrow('SESSION_UNAVAILABLE');
    fail = false;
    state = null;
    expect(await mfaRequirementFor(1, now)).toMatchObject({ required: true, exempt: false });
  });
  it('garde : identité de revue en session de niveau 1 admise sur les routes privées ; client refusé', async () => {
    state = { role: 'USER', enabledAt: null, settings: { users: new Date('2026-01-01T00:00:00Z'), admins: null }, appReview: reviewer() };
    await expect(assertMfaSatisfied({ userId: 1 }, '/api/assets', 'GET')).resolves.toBeUndefined();
    await expect(assertMfaSatisfied({ userId: 1, aal: 1 }, '/api/documents/zip', 'POST')).resolves.toBeUndefined();
    state = { role: 'USER', enabledAt: null, settings: { users: new Date('2026-01-01T00:00:00Z'), admins: null } };
    await expect(assertMfaSatisfied({ userId: 2 }, '/api/assets', 'GET')).rejects.toThrow(MFA_REQUIRED_CODE);
  });
  it('aucun faux AAL2 : la session de l’identité de revue reste de niveau 1', () => {
    expect(isStrongSession({ aal: 1 })).toBe(false);
    expect(isStrongSession({})).toBe(false);
  });
});

describe('C876-PRIMARY connexion : session de niveau 1, jamais de preuve forte fabriquée', () => {
  it('la décision primaire n’ajoute aucune `assurance` pour une identité exemptée', () => {
    const src = read('src/lib/auth/mfa/primary.ts');
    const branche = src.slice(src.indexOf('if (!requirement.required) {'), src.indexOf("const step = (await countStrongMethods"));
    expect(branche).toContain("kind: 'open', method: input.method");
    expect(branche).not.toMatch(/assurance\s*:/);
    expect(branche).not.toContain('strongAssurance');
    expect(branche).toContain("'MFA_APP_REVIEW_EXEMPTION_APPLIED'");
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { if (f !== '__tests__' && f !== 'node_modules') walk(p, out); } else if (/\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$|\.e2e\.ts$/.test(f)) out.push(p);
  }
  return out;
}

describe('C876-ARCH identification par état serveur seulement, aucune décision client', () => {
  it('le module de décision ne lit ni e-mail, ni en-tête, ni appareil, ni IP, ni variable d’environnement', () => {
    const src = read('src/lib/auth/mfa/app-review.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/email|headers|user-?agent|cookie|x-forwarded|process\.env|device|\bip\b/i);
  });
  it('seuls la politique MFA et le service BO lisent les exemptions (aucun composant client)', () => {
    const lecteurs = walk(join(ROOT, 'src'))
      .filter((f) => /app_review_mfa_exemptions|APP_REVIEW_FACTS_SQL|appReviewEligibility/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(ROOT.length + 1).split('\\').join('/'))
      .sort();
    expect(lecteurs).toEqual([
      'src/db/schema.ts',
      'src/lib/auth/mfa/app-review.ts',
      'src/lib/auth/mfa/policy.ts',
      'src/services/admin/app-review.service.ts',
    ]);
  });
  it('aucune route utilisateur n’écrit la qualification ni l’exemption (BO seul)', () => {
    const ecrivains = walk(join(ROOT, 'src', 'app'))
      .filter((f) => /app-review\.service|app_review_kind|app_review_mfa_exemptions/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(ROOT.length + 1).split('\\').join('/'));
    expect(ecrivains).toEqual(['src/app/api/admin/accounts/[id]/app-review/route.ts']);
  });
  it('migration 2020 additive : défaut NULL (compte client), aucune donnée existante réécrite, exemption révocable', () => {
    const m = read('src/db/migrations/2020_c876_comptes_revue_stores.sql').replace(/--.*$/gm, '');
    expect(m).toMatch(/ALTER TABLE accounts ADD COLUMN IF NOT EXISTS app_review_kind TEXT;/);
    expect(m).toMatch(/app_review_kind IN \('APPLE', 'GOOGLE'\)\) NOT VALID/);
    expect(m).not.toMatch(/\bUPDATE\s+\w+\s+SET\b|DELETE\s+FROM|DROP TABLE|DROP COLUMN|INSERT INTO|TRUNCATE/i);
    expect(m).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS app_review_mfa_exemptions_active_uniq\s+ON app_review_mfa_exemptions \(user_id\) WHERE revoked_at IS NULL/);
  });
  it('décision : exemption seulement sur l’obligation globale, jamais sur un facteur enrôlé', () => {
    const src = read('src/lib/auth/mfa/policy.ts');
    expect(src).toContain('required: enrolled || (enforced && !exempt)');
    expect(src).toContain('const exempt = !enrolled && enforced && review?.exempt === true;');
  });
});
