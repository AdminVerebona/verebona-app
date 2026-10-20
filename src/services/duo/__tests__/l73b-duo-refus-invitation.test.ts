/**
 * Lot 73 (73B) — « Refuser l'invitation » Premium Duo (décision PO du
 * 20/10/2026, point 4). Parties pures et branchements ; le comportement en
 * base est prouvé par `src/test/e2e/scenarios/l73b-duo-refus-invitation.e2e.ts`.
 *
 * L73B-U01  Notification titulaire DUO_INVITATION_DECLINED : catégorie Duo,
 *           cloche obligatoire, push générique (aucune adresse), PAS d'e-mail
 *           par le canal des notifications (e-mail transactionnel dédié),
 *           lien vers le panneau d'invitation ; libellé BO ; cloche.
 * L73B-U02  E-mail DUO_INVITATION_DECLINED : migration 0530 = défaut du code,
 *           variables déclarées pour l'éditeur BO (lien obligatoire),
 *           désactivable (information), listé et suivi dans le BO, type
 *           accepté par la file (0530 + Drizzle).
 * L73B-U03  Lien refusé : DECLINED_TOKEN (410) pour rejoindre, refus définitif
 *           côté client (jeton mémorisé retiré), message dédié ; inscription
 *           avec ce lien : message « invitation refusée ».
 * L73B-U04  Route publique `/api/duo/decline` déclarée dans le middleware ;
 *           réponse uniforme (anti-énumération).
 * L73B-U05  Interface : bouton « Refuser l'invitation » (page d'invitation,
 *           écran « sans espace »), statut « Refusée » + « Réinviter » dans le
 *           panneau du titulaire — composants uniques ordinateur et mobile.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = join(__dirname, '../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('L73B-U01 — notification au titulaire (service de notifications)', () => {
  it('catalogue : cloche obligatoire, push discret, aucun e-mail générique, lien vers le panneau', async () => {
    const { NOTIFICATION_CATALOG } = await import('@/lib/notifications/catalog');
    const { NOTIFICATION_TYPES } = await import('@/types/notifications');
    expect(NOTIFICATION_TYPES.DUO_INVITATION_DECLINED).toBe('DUO_INVITATION_DECLINED');
    const e = NOTIFICATION_CATALOG.DUO_INVITATION_DECLINED!;
    expect(e).toMatchObject({ category: 'duo', mandatoryBell: true, mandatoryEmail: false, neverBell: false });
    expect(e.defaults.email).toBe(false);
    const r = e.render({ inviteEmail: 'ines@exemple.fr', duoId: 3 });
    expect(r.bellTitle).toBe('Invitation refusée');
    expect(r.bellBody).toContain('ines@exemple.fr');
    expect(r.pushBody).not.toContain('@');
    expect(r.pushTitle).not.toContain('@');
    expect(r.emailTemplateCode).toBeUndefined();
    expect(e.deepLink({})).toBe('/mon-compte#duo-invitation');
    expect(e.payloadSchema.safeParse({ duoId: 3, inviteEmail: 'a@b.fr' }).success).toBe(true);
    // Sans adresse (invitation historique sans e-mail) : texte générique.
    expect(e.render({}).bellBody).not.toMatch(/undefined|null/);
  });

  it('BO › Communications : libellé métier ; cloche : texte et lien', () => {
    expect(read('src/services/admin/communications.service.ts')).toMatch(/DUO_INVITATION_DECLINED: 'Invitation Premium Duo refusée \(information du titulaire\)'/);
    const bell = read('src/components/NotificationBell.tsx');
    expect(bell).toMatch(/case 'DUO_INVITATION_DECLINED':[\s\S]{0,200}refusé votre invitation/);
    expect(bell).toMatch(/type === 'DUO_INVITATION_DECLINED'[\s\S]{0,80}'\/mon-compte#duo-invitation'/);
  });
});

describe('L73B-U02 — e-mail transactionnel DUO_INVITATION_DECLINED', () => {
  it('migration 0530 = défaut du code ; type accepté par la file (SQL + Drizzle)', async () => {
    const mig = read('src/db/migrations/0530_l73b_duo_invitation_refus.sql');
    const { DEFAULT_EMAIL_TEMPLATES } = await import('@/lib/email-defaults');
    const d = DEFAULT_EMAIL_TEMPLATES.DUO_INVITATION_DECLINED;
    expect(d.subject).toBe('Votre invitation Premium Duo a été refusée');
    expect(mig).toContain(`'${d.subject}'`);
    expect(mig).toContain(d.body.replace(/'/g, "''").replace(/\n/g, '\\n'));
    // Garde 0483 : insertion seulement si absent, jamais d'écrasement.
    expect(mig).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM email_templates WHERE upper\(type\) = 'DUO_INVITATION_DECLINED'\)/);
    expect(mig).not.toMatch(/UPDATE email_templates|DELETE FROM email_templates|ON CONFLICT[^;]*DO UPDATE/);
    expect(mig).toMatch(/kind IN \([^)]*'DUO_INVITATION_DECLINED'/);
    expect(read('src/db/schema.ts')).toMatch(/transactional_email_jobs_kind_check[^\n]*'DUO_INVITATION_DECLINED'/);
    for (const v of ['firstName', 'inviteEmail', 'declinedAt', 'invitationUrl']) expect(d.body).toContain(`{{${v}}}`);
    expect(d.body).not.toMatch(/\btu\b|\bton\b|\bta\b/i);
  });

  it('éditeur BO : variables déclarées, lien obligatoire ; désactivable ; listé et suivi', async () => {
    const { hasDeclaredVariables, variableSpecFor } = await import('@/lib/email/template-editor');
    expect(hasDeclaredVariables('DUO_INVITATION_DECLINED')).toBe(true);
    const spec = variableSpecFor('DUO_INVITATION_DECLINED');
    expect(spec.variables.map((v) => v.name)).toEqual(expect.arrayContaining(['firstName', 'inviteEmail', 'declinedAt', 'invitationUrl']));
    expect(spec.required.flatMap((r) => r.anyOf)).toContain('invitationUrl');
    const { transactionalLockReason } = await import('@/lib/notifications/channel-activation');
    expect(transactionalLockReason('DUO_INVITATION_DECLINED')).toBeNull();
    const { TRANSACTIONAL_EMAILS } = await import('@/services/admin/communications.service');
    expect(TRANSACTIONAL_EMAILS.map((e) => e.templateCode)).toContain('DUO_INVITATION_DECLINED');
    expect(read('src/app/admin/communications/_components/TransactionalEmailsOps.tsx')).toContain("'DUO_INVITATION_DECLINED'");
    expect(read('src/services/admin/transactional-email-logs.service.ts')).toMatch(/REQUIRED_TEMPLATES = \[[^\]]*'DUO_INVITATION_DECLINED'/);
  });

  it('file : construction dédiée, valeurs utilisateur échappées', () => {
    const src = read('src/services/email/transactional-email-jobs.service.ts');
    expect(src).toMatch(/job\.kind === 'DUO_INVITATION_DECLINED' \? await buildDuoInvitationDeclined\(job\)/);
    expect(src).toMatch(/inviteEmail: escapeHtml\(/);
  });

  it('clé d’idempotence : un refus = un Duo × une invitation (empreinte du jeton)', async () => {
    const { duoInvitationDeclinedKey } = await import('../duo-invitation-decline.service');
    expect(duoInvitationDeclinedKey(7, 'ab'.repeat(32))).toBe(`duo-invitation-declined:7:${'ab'.repeat(32)}`);
  });
});

describe('L73B-U03 — lien refusé', () => {
  it('rejoindre : DECLINED_TOKEN 410 ; refus définitif côté client ; message', async () => {
    const { DUO_JOIN_HTTP_STATUS } = await import('@/services/account/membership.service');
    expect(DUO_JOIN_HTTP_STATUS.DECLINED_TOKEN).toBe(410);
    const { isDefinitiveDuoJoinError, duoJoinErrorMessage } = await import('@/lib/duo/pending-duo-join');
    expect(isDefinitiveDuoJoinError('DECLINED_TOKEN')).toBe(true);
    expect(duoJoinErrorMessage('DECLINED_TOKEN')).toMatch(/refusée/);
  });

  it('inscription avec un lien refusé : message dédié, sans inscription classique', async () => {
    const { invitationInvalidContent } = await import('@/app/(auth)/signup/SignupInvitationInvalid');
    const c = invitationInvalidContent({ kind: 'duo', state: 'declined' });
    expect(c.title).toBe('Invitation Premium Duo refusée');
    expect(c.message).toMatch(/nouvelle invitation/);
  });
});

describe('L73B-U04 — route publique, réponse uniforme', () => {
  it('middleware : `/api/duo/decline` public (invité sans compte) ; jeton borné', async () => {
    expect(read('src/middleware.ts')).toMatch(/'\/api\/duo\/decline',/);
    const { isWellFormedInviteToken } = await import('../duo-invitation-decline.service');
    expect(isWellFormedInviteToken('a'.repeat(64))).toBe(true);
    expect(isWellFormedInviteToken('x'.repeat(5000))).toBe(false);
    expect(isWellFormedInviteToken('../etc')).toBe(false);
    expect(isWellFormedInviteToken(42)).toBe(false);
    const route = read('src/app/api/duo/decline/route.ts');
    // Même réponse que l'invitation existe, ait été acceptée, refusée ou non.
    expect(route.match(/NextResponse\.json\(\{ success: true \}\)/g)?.length).toBe(1);
  });
});

describe('L73B-U05 — interface (ordinateur et mobile, même composant)', () => {
  it('page d’invitation : « Refuser l’invitation » avec confirmation, connecté ou non', () => {
    const page = read('src/app/duo/join/[token]/page.tsx');
    expect(page).toContain('Refuser l’invitation');
    expect(page).toContain('declineDuo(token)');
    expect(page).toMatch(/AlertDialog/);
    expect(page).toMatch(/pageState === 'declined'/);
    expect(page).toMatch(/data\.error === 'DECLINED_TOKEN'/);
    // Pas de largeur fixe : la carte est la même sur mobile (w-full, max-w-md).
    expect(page).toMatch(/w-full max-w-md/);
  });

  it('écran « sans espace » : refus de l’invitation en attente', () => {
    const ecran = read('src/components/shell/NoSpaceScreen.tsx');
    expect(ecran).toContain('Refuser l’invitation');
    expect(ecran).toMatch(/declineDuo\(null\)/);
  });

  it('panneau du titulaire : statut « Refusée » et « Réinviter »', () => {
    const panel = read('src/components/subscription/DuoInvitationPanel.tsx');
    expect(panel).toMatch(/'DECLINED'/);
    expect(panel).toContain('Invitation refusée');
    expect(panel).toContain('Réinviter');
    expect(panel).toContain('data-testid="duo-invite-declined"');
    expect(panel).toMatch(/flex flex-wrap gap-2/);
  });
});
