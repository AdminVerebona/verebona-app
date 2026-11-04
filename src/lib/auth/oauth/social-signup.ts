/**
 * Inscription Google / Apple — lot 93, CDC 18 §6, §7, §7.2, §8.2, §12.4, §24,
 * §37 ; SIGN-01…SIGN-11, INT-02…INT-04.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLES
 *
 *   · Le compte n'est créé qu'APRÈS le choix explicite « Créer un nouveau
 *     compte », le profil (« Prénom ou pseudo » — lot 103B —, adresse
 *     principale) et l'acceptation des CGUV dans la version RÉELLEMENT
 *     affichée (SIGN-02/03). Prénom / nom civils : facultatifs, jamais
 *     fabriqués à partir du pseudo ni recopiés depuis le fournisseur sans
 *     saisie de l'utilisateur.
 *   · Compte ET identité externe créés dans UNE transaction : jamais
 *     d'identité orpheline ni de compte sans identité (§7.2 étape 14).
 *   · Adresse principale = celle attestée (vérifiée) par le fournisseur →
 *     compte actif immédiatement (§6). Autre adresse (ou aucune transmise,
 *     ex. relais Apple remplacé, §12.4) → code à 6 chiffres envoyé à cette
 *     adresse et saisi dans le même navigateur avant la création (§37).
 *   · Mêmes règles métier que l'inscription par mot de passe
 *     (`app/api/users/route.ts`) : offre STANDARD imposée côté serveur, essai
 *     de 7 jours (`grantTrial`, anti-fraude par adresse), preuve d'acceptation
 *     des CGUV, parrainage (sans double attribution), pré-lancement fermé
 *     sauf invitation valide, invitation à un compte partagé (adhésion
 *     activée : l'adresse est prouvée), invitation Premium Duo (identité
 *     seule, rattachement par /api/duo/join), transmission (acceptée après
 *     la première session, mécanisme existant de la page de transmission).
 *   · Invitation portant une adresse : l'adresse principale doit être
 *     celle-là (§24) — jamais d'adhésion avec une autre adresse.
 *   · Aucun mot de passe : compte « social-only » (Q1, `password_hash` NULL).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db, pgClient } from '@/db';
import { accountAuditLog, accountMemberships, accounts, authIdentities, users } from '@/db/schema';
import { getCurrentVersion } from '@/services/legal';
import { recordAcceptance } from '@/services/legal/legal-acceptances.service';
import { channelFrom } from '@/lib/legal/public-legal';
import { readClientContext } from '@/lib/mobile/client-context';
import { grantTrial } from '@/services/trial.service';
import { recordSignupReferral } from '@/services/referral-attribution.service';
import { getSignupMode } from '@/lib/prelaunch';
import { resolveSignupInvitation, type SignupInvitation } from '@/lib/prelaunch-invitations';
import { releaseUnverifiedEmail } from '@/services/auth/release-unverified-email';
import { runDetached } from '@/lib/auth/anti-enumeration';
import { emailService } from '@/lib/email/email-service';
import { logUserActivity } from '@/lib/audit-logger';
import { getClientIp } from '@/lib/auth/client-ip';
import type { TxClaims, TxContext } from './transactions';
import {
  DISPLAY_NAME_ERROR_MESSAGES, cleanCivilName, personalAccountName, validateDisplayName, type DisplayNameError,
} from '@/lib/auth/display-name';

export interface SocialProfile {
  /**
   * Lot 103B : « Prénom ou pseudo » (`users.username`, non unique). Absent
   * d'une étape « code » enregistrée avant le déploiement : le prénom saisi
   * alors en tient lieu (`profileDisplayName`).
   */
  username?: string;
  /** Champs civils facultatifs : seulement ce que l'utilisateur a saisi (ancien formulaire), sinon vides. */
  firstName: string;
  lastName: string;
  email: string;
  termsVersion: string;
  referralCode: string | null;
  /** Lot 102C : choix sur les relances commerciales (conservé à travers l'étape « code »). */
  marketing?: { checked?: unknown; noticeSha256?: unknown } | null;
  /** Lot 102D : jeton `rt` du lien de parrainage (facultatif). */
  referralTouch?: string | null;
}

export type ProfileError =
  | DisplayNameError | 'INVALID_EMAIL' | 'TERMS_NOT_ACCEPTED' | 'NO_CURRENT_LEGAL_VERSION';

export const PROFILE_ERROR_MESSAGES: Readonly<Record<ProfileError, string>> = {
  ...DISPLAY_NAME_ERROR_MESSAGES,
  INVALID_EMAIL: 'Adresse e-mail invalide.',
  TERMS_NOT_ACCEPTED: 'Vous devez accepter les CGUV pour créer un compte.',
  NO_CURRENT_LEGAL_VERSION: 'Les CGUV sont momentanément indisponibles. Réessayez dans quelques instants.',
};

const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : '');

/** Adresse plausible (même exigence minimale que l'inscription locale + forme usuelle). */
export function isPlausibleEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Contrôle du profil saisi (pur, hors version CGUV). Lot 103B : un seul nom
 * obligatoire, `username` (« Prénom ou pseudo ») ; un ancien formulaire
 * (prénom + nom, sans `username`) reste accepté : son prénom devient le nom
 * d'affichage et prénom / nom sont conservés tels que saisis.
 */
export function validateProfileInput(raw: Record<string, unknown>): { ok: true; username: string; firstName: string; lastName: string; email: string; referralCode: string | null; presentedVersion: string | null } | { ok: false; code: ProfileError } {
  const usernameProvided = typeof raw.username === 'string' && raw.username.trim() !== '';
  const display = validateDisplayName(usernameProvided ? raw.username : raw.firstName);
  if (!display.ok) return { ok: false, code: display.code };
  const firstName = cleanCivilName(raw.firstName);
  const lastName = cleanCivilName(raw.lastName);
  const email = clean(raw.email, 254).toLowerCase();
  if (!isPlausibleEmail(email)) return { ok: false, code: 'INVALID_EMAIL' };
  if (raw.acceptedTerms !== true) return { ok: false, code: 'TERMS_NOT_ACCEPTED' };
  const referral = clean(raw.referralCode, 40).toUpperCase();
  const presented = clean(raw.termsVersion, 80);
  return { ok: true, username: display.value, firstName, lastName, email, referralCode: referral || null, presentedVersion: presented || null };
}

/** Nom d'affichage d'un profil (étape « code » d'avant le lot 103B : le prénom saisi). */
export function profileDisplayName(profile: Pick<SocialProfile, 'username' | 'firstName'>): string {
  const v = validateDisplayName(profile.username?.trim() ? profile.username : profile.firstName);
  return v.ok ? v.value : '';
}

/** Version des CGUV retenue : celle présentée, sinon la courante (§7, CDC 7 §18). `null` : aucune publiée. */
export async function acceptedTermsVersion(presented: string | null): Promise<string | null> {
  const current = await getCurrentVersion();
  if (!current) return null;
  return presented ?? current.versionCode;
}

/**
 * Lot 108L : la version retenue est-elle consultable sur le site public ?
 * `false` → refus explicite `CGUV_PUBLIC_TEXT_UNAVAILABLE` (Supervision ouverte).
 */
export async function termsVersionAcceptable(code: string): Promise<boolean> {
  const { assertCguvAcceptable } = await import('@/services/legal/legal-acceptances.service');
  return (await assertCguvAcceptable(code)).ok;
}

/** Adresse déjà portée par un compte actif (ou clôturé / suspendu) ? */
export async function emailHasAccount(email: string): Promise<{ id: number; firstName: string | null } | null> {
  const rows = await pgClient<{ id: number; first_name: string | null }[]>`
    SELECT id, first_name FROM users WHERE email = ${email.trim().toLowerCase()} AND is_active = true LIMIT 1`;
  return rows[0] ? { id: rows[0].id, firstName: rows[0].first_name } : null;
}

export type InvitationCheck = { ok: true; invitation: SignupInvitation | null } | { ok: false; code: 'SIGNUP_CLOSED' | 'INVITATION_INVALID' };

/**
 * Pré-lancement et invitation (mêmes règles que `POST /api/users`) : le jeton
 * vient du contexte SERVEUR de la transaction, jamais d'un paramètre libre.
 */
export async function checkSignupInvitation(context: TxContext, email: string): Promise<InvitationCheck> {
  const prelaunch = getSignupMode() === 'prelaunch';
  const token = context.inviteToken || (prelaunch ? context.transmissionToken : undefined);
  if (!token) return prelaunch ? { ok: false, code: 'SIGNUP_CLOSED' } : { ok: true, invitation: null };
  const invitation = await resolveSignupInvitation(token, email);
  if (!invitation.valid) return { ok: false, code: prelaunch ? 'SIGNUP_CLOSED' : 'INVITATION_INVALID' };
  return { ok: true, invitation };
}

export type CreateOutcome =
  | { ok: true; userId: number; accountId: number | null; joinedAccountId: number | null }
  | { ok: false; code: 'EMAIL_TAKEN' | 'OAUTH_IDENTITY_ALREADY_LINKED' }
  /** Lot 109F : garde finale — le domaine est devenu jetable entre la saisie et la création. */
  | { ok: false; code: 'DISPOSABLE_EMAIL_NOT_ALLOWED'; message: string };

function uniqueViolation(e: unknown): string | null {
  const err = e as { code?: string; constraint_name?: string; constraint?: string; cause?: { code?: string; constraint_name?: string; constraint?: string } };
  const c = err?.cause ?? err;
  if ((c?.code ?? err?.code) !== '23505') return null;
  return c?.constraint_name ?? c?.constraint ?? err?.constraint_name ?? err?.constraint ?? 'unique';
}

/**
 * Création ATOMIQUE compte + identité (§7.2 étape 14). L'adresse est PROUVÉE
 * (fournisseur ou code) : un compte non vérifié qui la retenait est libéré,
 * comme à l'inscription locale.
 */
export async function createSocialAccount(input: {
  claims: TxClaims;
  profile: SocialProfile;
  invitation: SignupInvitation | null;
  request: NextRequest;
  now?: Date;
}): Promise<CreateOutcome> {
  const now = input.now ?? new Date();
  const { claims, profile, invitation } = input;
  // Lot 109F : GARDE FINALE, juste avant toute écriture (libération d'une
  // inscription non vérifiée comprise) — le statut du domaine peut avoir
  // changé depuis la saisie (mise à jour du référentiel, blocage d'urgence).
  const { checkDisposableEmail } = await import('@/services/auth/disposable-email-guard');
  const disposable = checkDisposableEmail(profile.email, 'social_final');
  if (disposable) return { ok: false, ...disposable };
  const username = profileDisplayName(profile) || null;
  await releaseUnverifiedEmail(profile.email);

  const pendingMembership = invitation?.valid && invitation.kind === 'account' ? invitation.membership : undefined;
  const joinsExistingAccount = !!invitation?.valid && (invitation.kind === 'account' || invitation.kind === 'duo');

  let created: { userId: number; accountId: number | null; joinedAccountId: number | null };
  try {
    created = await db.transaction(async (tx) => {
      const [u] = await tx.insert(users).values({
        email: profile.email,
        passwordHash: null,
        firstName: profile.firstName ?? '',
        lastName: profile.lastName ?? '',
        username,
        planType: 'STANDARD',
        isActive: true,
        locale: 'fr-FR',
        acceptedTermsAt: now,
        termsVersion: profile.termsVersion,
        createdAt: now,
        updatedAt: now,
      }).returning({ id: users.id });

      await tx.insert(authIdentities).values({
        userId: u.id,
        provider: claims.provider,
        issuer: claims.issuer,
        subject: claims.subject,
        emailAtLinkTime: claims.email,
        emailVerified: claims.emailVerified,
        lastProviderEmail: claims.email,
        isPrivateRelay: claims.isPrivateRelay,
        refreshTokenCiphertext: claims.refreshTokenCiphertext ?? null,
        linkedAt: now,
        lastUsedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      if (pendingMembership) {
        // Adresse prouvée : l'adhésion devient active tout de suite (même
        // effet que la vérification d'adresse du parcours local, lot 72D).
        const joined = await tx.update(accountMemberships).set({
          userId: u.id, status: 'active', joinedAt: now, inviteToken: null, inviteTokenExpiresAt: null,
          lastSelectedAt: now, source: 'account_invitation', updatedAt: now,
        }).where(and(eq(accountMemberships.id, pendingMembership.id), eq(accountMemberships.status, 'pending')))
          .returning({ accountId: accountMemberships.accountId });
        const joinedAccountId = joined[0]?.accountId ?? null;
        if (joinedAccountId) {
          await tx.insert(accountAuditLog).values({
            accountId: joinedAccountId, userId: u.id, userEmail: profile.email, actionType: 'MEMBER_JOINED',
            targetUserId: u.id, targetUserEmail: profile.email,
            details: JSON.stringify({ role: 'member', source: 'account_invitation', method: claims.provider }), timestamp: now,
          });
        }
        return { userId: u.id, accountId: null, joinedAccountId };
      }
      if (joinsExistingAccount) return { userId: u.id, accountId: null, joinedAccountId: null };

      const [acc] = await tx.insert(accounts).values({
        // Lot 103B : « Compte de Sophie », fondé sur le nom d'affichage.
        name: personalAccountName({ username, firstName: profile.firstName, lastName: profile.lastName }),
        ownerUserId: u.id,
        planType: 'STANDARD',
        subscriptionTier: 'free',
        subscriptionStatus: 'NONE',
        createdAt: now,
        updatedAt: now,
      }).returning({ id: accounts.id });
      await tx.insert(accountMemberships).values({
        accountId: acc.id, userId: u.id, role: 'owner', status: 'active', source: 'signup',
        invitedAt: now, joinedAt: now, lastSelectedAt: now, createdAt: now, updatedAt: now,
      });
      return { userId: u.id, accountId: acc.id, joinedAccountId: null };
    });
  } catch (e) {
    const c = uniqueViolation(e);
    if (c && /auth_identities/.test(c)) return { ok: false, code: 'OAUTH_IDENTITY_ALREADY_LINKED' };
    if (c && /email/.test(c)) return { ok: false, code: 'EMAIL_TAKEN' };
    throw e;
  }

  // Après validation (jamais bloquant, comme l'inscription locale).
  if (created.accountId) {
    try {
      await grantTrial({ accountId: created.accountId, email: profile.email, now });
    } catch (e) {
      console.error('[social-signup] attribution de l’essai :', (e as Error)?.message ?? e);
    }
  }
  try {
    await recordAcceptance({
      userId: created.userId,
      versionCode: profile.termsVersion,
      // Lot 102B : contexte « connexion sociale » et canal figés dans la preuve.
      context: 'SOCIAL_SIGNUP',
      channel: channelFrom(readClientContext(input.request).client, input.request.headers.get('user-agent')),
      ipAddress: getClientIp(input.request.headers),
      userAgent: input.request.headers.get('user-agent'),
      acceptedAt: now,
    });
  } catch (e) {
    console.error(`[social-signup] preuve d'acceptation non enregistrée (utilisateur ${created.userId}) :`, (e as Error)?.message ?? e);
  }
  // Lot 102C : preuve de l'information et du choix (relances commerciales). Ne lève jamais.
  {
    const { readSignupMarketingInput, recordSignupMarketingChoice } = await import('@/services/trial-lifecycle/signup-collection');
    await recordSignupMarketingChoice({ userId: created.userId, context: 'social_signup', marketing: readSignupMarketingInput(profile.marketing ?? null), now });
  }
  if (created.accountId && profile.referralCode) {
    try {
      await recordSignupReferral({ userId: created.userId, accountId: created.accountId, rawCode: profile.referralCode, referralTouch: profile.referralTouch ?? null, entryPoint: 'direct_signup', now });
    } catch (e) {
      console.error('[social-signup] parrainage :', (e as Error)?.message ?? e);
    }
  }
  runDetached('e-mail de bienvenue (inscription Google / Apple)', () => emailService.send({
    templateCode: 'WELCOME',
    to: profile.email,
    variables: { firstName: username ?? '', loginUrl: `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/login` },
    userId: created.userId,
  }));
  void logUserActivity({
    activityType: 'SOCIAL_SIGNUP',
    userId: created.userId,
    userEmail: profile.email,
    details: {
      method: claims.provider, privateRelay: claims.isPrivateRelay, providerEmailUsed: profile.email === claims.email,
      invitation: invitation?.valid ? invitation.kind : null, referral: !!profile.referralCode,
    },
    request: input.request,
  });
  void logUserActivity({
    activityType: 'IDENTITY_LINKED', userId: created.userId, userEmail: profile.email,
    details: { provider: claims.provider, context: 'signup' }, request: input.request,
  });
  return { ok: true, ...created };
}
