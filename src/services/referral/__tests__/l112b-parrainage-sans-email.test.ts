/**
 * Lot 112B — suppression complète de l'invitation de parrainage PAR E-MAIL
 * (décision PO). Partie pure ; la migration sur PostgreSQL réel est couverte
 * par `src/test/e2e/scenarios/l112b-parrainage-sans-email.e2e.ts`.
 *
 *   L112B-01  route `POST /api/referral/send-email` supprimée, plus aucun appelant
 *   L112B-02  service : seules la construction du lien et `/r/<code>` restent
 *   L112B-03  table `referral_email_sends` : hors schéma Drizzle, diagnostic, export de recette
 *   L112B-04  gabarit `REFERRAL_INVITATION` : ni listé ni éditable au BO ; libellé d'historique
 *   L112B-05  migration 1405 idempotente (DROP IF EXISTS, DELETE ciblés, email_logs intact)
 *   L112B-06  variable RESEND_FROM_EMAIL retirée (signalée si encore posée)
 *   L112B-07  conservés : code, lien, copie, partage natif, repli mailto (111H), Duo
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** Le code seul (un commentaire qui raconte la suppression n'est pas un usage). */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

function fichiers(dir: string, out: string[] = []): string[] {
  for (const nom of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${nom}`;
    if (nom === 'node_modules' || nom === '__tests__' || nom === 'migrations' || nom.startsWith('.')) continue;
    const st = statSync(join(ROOT, rel));
    if (st.isDirectory()) fichiers(rel, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(nom) && !/\.(test|e2e)\.tsx?$/.test(nom)) out.push(rel);
  }
  return out;
}

describe('L112B-01 — route d’envoi supprimée', () => {
  it('le fichier de route et son dossier n’existent plus', () => {
    expect(existsSync(join(ROOT, 'src/app/api/referral/send-email/route.ts'))).toBe(false);
    expect(existsSync(join(ROOT, 'src/app/api/referral/send-email'))).toBe(false);
  });

  it('aucun code applicatif (web, mobile, scripts) ne cite la route, la table ni le gabarit', () => {
    const sources = [...fichiers('src'), ...fichiers('scripts'), ...(existsSync(join(ROOT, 'mobile/src')) ? fichiers('mobile/src') : [])];
    const fautifs = sources.filter((f) => {
      const c = code(read(f));
      return c.includes('/api/referral/send-email') || c.includes('referral_email_sends') || c.includes('referralEmailSends')
        || /['"`]REFERRAL_INVITATION['"`]/.test(c);
    });
    // Seul le libellé d'historique (lecture des anciens `email_logs`) cite encore le code du gabarit.
    expect(fautifs).toEqual([]);
  });
});

describe('L112B-02 — service du lien de parrainage', () => {
  it('seules les fonctions du lien restent exportées', async () => {
    const mod = await import('@/services/referral/referral-invitation.service');
    expect(Object.keys(mod).sort()).toEqual(['appBaseUrl', 'buildReferralUrl', 'referralRedirectPath']);
    expect(mod.buildReferralUrl('ABCD2345', 'https://app.verebona.fr/')).toBe('https://app.verebona.fr/r/ABCD2345');
  });
});

describe('L112B-03 — table referral_email_sends retirée des catalogues', () => {
  it('schéma Drizzle, registre du diagnostic, export de recette', async () => {
    const schema = await import('@/db/schema');
    expect('referralEmailSends' in schema).toBe(false);
    const { DIAG_TABLE_COVERAGE, DIAG_TABLE_EXCLUSIONS } = await import('@/services/admin/diagnostics-export/coverage');
    expect(DIAG_TABLE_COVERAGE.referral_email_sends).toBeUndefined();
    expect(DIAG_TABLE_EXCLUSIONS.referral_email_sends).toBeUndefined();
    const { RECETTE_TABLES, RECETTE_EXCLUDED } = await import('@/services/admin/diagnostics-export/recette-catalog');
    expect(RECETTE_TABLES.referral_email_sends).toBeUndefined();
    expect(RECETTE_EXCLUDED.referral_email_sends).toBeUndefined();
    // Les autres tables du parrainage restent couvertes.
    expect(DIAG_TABLE_COVERAGE.referral_links).toBeDefined();
    expect(DIAG_TABLE_COVERAGE.referral_events).toBeDefined();
  });
});

describe('L112B-04 — gabarit REFERRAL_INVITATION retiré du BO', () => {
  it('ni dans les e-mails transactionnels (Communications), ni dans l’éditeur de gabarits', async () => {
    const { TRANSACTIONAL_EMAILS, listEventDefinitions } = await import('@/services/admin/communications.service');
    expect(TRANSACTIONAL_EMAILS.map((t) => t.templateCode)).not.toContain('REFERRAL_INVITATION');
    // Même si une base n'avait pas encore reçu la migration 1405, le gabarit
    // restant serait listé comme « inconnu » : la migration le supprime.
    expect(listEventDefinitions([]).map((d) => d.code)).not.toContain('email:REFERRAL_INVITATION');
    const { hasDeclaredVariables } = await import('@/lib/email/template-editor');
    expect(hasDeclaredVariables('REFERRAL_INVITATION')).toBe(false);
    expect(hasDeclaredVariables('DUO_INVITATION')).toBe(true);
    // Les autres e-mails du parrainage et de Duo sont intacts.
    expect(TRANSACTIONAL_EMAILS.map((t) => t.templateCode)).toEqual(expect.arrayContaining(['DUO_INVITATION', 'ACCOUNT_INVITATION']));
  });

  it('les anciens envois gardent un libellé lisible dans l’historique (email_logs conservé)', async () => {
    const { communicationTypeLabel, REMOVED_TRANSACTIONAL_EMAIL_LABELS } = await import('@/services/admin/communications.service');
    expect(Object.keys(REMOVED_TRANSACTIONAL_EMAIL_LABELS)).toEqual(['REFERRAL_INVITATION']);
    expect(communicationTypeLabel('REFERRAL_INVITATION')).toMatch(/Invitation de parrainage par e-mail \(supprimée/);
    expect(communicationTypeLabel('DUO_INVITATION')).toMatch(/Invitation Duo/);
  });
});

describe('L112B-05 — migration 1405', () => {
  const mig = read('src/db/migrations/1405_l112b_parrainage_sans_email.sql');
  const sqlSeul = mig.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  it('idempotente : DROP TABLE IF EXISTS et suppressions ciblées du gabarit', () => {
    expect(sqlSeul).toContain('DROP TABLE IF EXISTS referral_email_sends;');
    expect(sqlSeul).not.toMatch(/CASCADE/i);
    expect(sqlSeul).toMatch(/DELETE FROM email_templates WHERE upper\(type\) = 'REFERRAL_INVITATION'/);
    expect(sqlSeul).toMatch(/DELETE FROM email_template_versions WHERE upper\(template_type\) = 'REFERRAL_INVITATION'/);
    expect(sqlSeul).toMatch(/DELETE FROM communication_channel_settings WHERE upper\(event_code\) = 'EMAIL:REFERRAL_INVITATION'/);
  });

  it('un gabarit personnalisé est aussi supprimé (garde 0483 levée le temps du fichier seulement)', () => {
    expect(sqlSeul).toMatch(/set_config\('verebona\.email_template_edit', 'on', true\)[\s\S]*DELETE FROM email_templates[\s\S]*set_config\('verebona\.email_template_edit', '', true\)/);
  });

  it('l’historique des envois n’est jamais touché', () => {
    expect(sqlSeul).not.toMatch(/email_logs/);
    expect(sqlSeul).not.toMatch(/referral_links|referral_events/);
  });

  it('numérotée dans la plage réservée au chantier (1405-1409), seule du chantier', () => {
    const miens = readdirSync(join(ROOT, 'src/db/migrations')).filter((f) => /^14(0[5-9])_/.test(f));
    expect(miens).toEqual(['1405_l112b_parrainage_sans_email.sql']);
  });
});

describe('L112B-06 — variable d’environnement', () => {
  it('RESEND_FROM_EMAIL n’est plus documentée et figure parmi les variables retirées', async () => {
    expect(read('.env.example')).not.toContain('RESEND_FROM_EMAIL');
    const { retiredEnvVariables } = await import('@/services/admin/ops/env-catalog');
    expect(retiredEnvVariables().map((v) => v.name)).toContain('RESEND_FROM_EMAIL');
  });
});

describe('L112B-07 — conservé', () => {
  it('code, lien, copies, partage natif et repli e-mail préparé côté client (111H)', () => {
    const bloc = read('src/components/account/ReferralBlock.tsx');
    for (const id of ['referral-copy-code', 'referral-copy-link', 'referral-share', 'referral-terms-link']) expect(bloc).toContain(id);
    expect(bloc).toContain('export function referralInvitationMailto');
    expect(bloc).toContain("apiClient.get<any>('/api/referral/me')");
  });

  it('routes de parrainage conservées et Duo intact', () => {
    for (const f of ['src/app/api/referral/me/route.ts', 'src/app/api/referral/validate/[code]/route.ts', 'src/app/r/[code]/route.ts', 'src/app/api/duo/invitation/route.ts']) {
      expect(existsSync(join(ROOT, f)), f).toBe(true);
    }
  });
});
