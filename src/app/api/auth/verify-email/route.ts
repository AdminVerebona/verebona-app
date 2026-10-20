import { NextRequest, NextResponse } from 'next/server';
import { hasActiveSubscriptionStatus } from '@/lib/billing/subscription-status';
import { db } from '@/db';
import { users, duoAccounts, accountMemberships, accountAuditLog } from '@/db/schema';
import { and, eq, gt, isNotNull, sql } from 'drizzle-orm';
import { runDetached } from '@/lib/auth/anti-enumeration';
import { emailService } from '@/lib/email/email-service';
import { generateSessionTokens } from '@/lib/jwt';
import { AccountService } from '@/services/account-service';
import {
  checkEmailVerificationToken,
  consumeEmailVerification,
  isLegacyVerificationToken,
  parseEmailVerificationToken,
} from '@/services/auth/email-verification.service';
import type { UserRole, PlanType, UserStatus } from '@/types/domain';
import { setSessionCookies } from '@/lib/auth/session-tokens';
import { rememberTrustedDevice } from '@/lib/auth/device-trust';
import { normalizeEmail } from '@/lib/auth/auth-rate-limit';

const baseUrl = () =>
  process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

function redirect(path: string) {
  return NextResponse.redirect(`${baseUrl()}${path}`);
}

/** Offres acceptées dans le paramètre `plan` : il est recopié dans l'URL de redirection. */
const KNOWN_PLANS = new Set(['standard', 'premium', 'premium_duo', 'premium_pro']);

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token');
  const plan = searchParams.get('plan'); // 'premium' | 'premium_duo' | 'duo' | null
  // Liste fermée : le paramètre n'est pas signé et finit dans une URL de
  // redirection ; une valeur libre pourrait y injecter d'autres paramètres.
  const rawPlan = plan === 'duo' ? 'premium_duo' : plan;
  const normalizedPlan = rawPlan && KNOWN_PLANS.has(rawPlan) ? rawPlan : null;
  const planSuffix = normalizedPlan ? `&plan=${normalizedPlan}` : '';

  // Garde rétablie : `token` provient de la query string du lien reçu par
  // email, sans rapport avec le stockage local. Le codemod de migration l'a
  // retirée par excès de zèle.
  if (!token) {
    return redirect('/verify-email?error=missing_token');
  }

  // Lien émis avant le passage au jeton signé : refusé, mais expliqué — et
  // l'adresse qu'il contient pré-remplit le renvoi (qui ne révèle rien).
  const legacy = isLegacyVerificationToken(token);
  if (legacy) {
    return redirect(`/verify-email?error=link_outdated&email=${encodeURIComponent(legacy.email)}${planSuffix}`);
  }

  const parsed = parseEmailVerificationToken(token);
  if (!parsed) {
    return redirect(`/verify-email?error=invalid_token${planSuffix}`);
  }

  try {
    // Projection explicite : `select()` enumere toutes les colonnes du schema
    // et fait echouer la verification des qu'une seule manque en base.
    const userResult = await db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        isActive: users.isActive,
        role: users.role,
        planType: users.planType,
        status: users.status,
      })
      .from(users)
      .where(eq(users.id, parsed.userId))
      .limit(1);

    // Compte introuvable ou signature fausse : même réponse. Distinguer les
    // deux dirait à un fabricant de liens quels identifiants existent.
    const user = userResult[0] ?? null;
    const check = checkEmailVerificationToken(token, user);
    if (!check.ok || !user) {
      if (check.ok === false && check.code === 'TOKEN_EXPIRED' && user) {
        // Signature valide : c'est bien le lien de cette adresse, on peut
        // pré-remplir le renvoi.
        return redirect(`/verify-email?error=token_expired&email=${encodeURIComponent(user.email)}${planSuffix}`);
      }
      return redirect(`/verify-email?error=invalid_token${planSuffix}`);
    }

    if (user.isActive) {
      // Usage unique : un lien déjà utilisé n'ouvre plus de session.
      return redirect(`/verify-email?status=already_verified${planSuffix}`);
    }

    // Activation conditionnelle : seule la requête qui fait passer le compte
    // de « non vérifié » à « actif » obtient une session (voir le service).
    if (!(await consumeEmailVerification(user.id))) {
      return redirect(`/verify-email?status=already_verified${planSuffix}`);
    }

    // Lot 57A (P1-E) : le message de bienvenue n'est plus ATTENDU — un
    // fournisseur lent ou en panne ne retarde plus l'accès au compte.
    runDetached('e-mail de bienvenue', () => emailService.send({
      templateCode: 'WELCOME',
      to: user.email,
      variables: {
        firstName: user.firstName,
        loginUrl: `${baseUrl()}/login`,
      },
      userId: user.id,
    }));

    // CDC 18 §6 / LOGIN-05 : un compte suspendu ou supprimé entre-temps
    // n'obtient pas de session par le lien (l'adresse reste vérifiée).
    if (user.status === 'SUSPENDED' || user.status === 'DELETED') {
      return redirect(`/verify-email?status=already_verified${planSuffix}`);
    }

    // Lot 72D (décision PO Q10) : invitation à un compte partagé réservée à
    // cette identité à l'inscription — l'adresse étant désormais vérifiée,
    // l'adhésion devient active (et l'espace est ouvert par défaut).
    const joinedAccountIds = await activateReservedAccountInvitations(user.id, user.email);

    // Generate auth tokens so the user is logged in immediately after verification
    try {
      // Dernier espace choisi d'abord (lot 72D) : l'espace rejoint ci-dessus.
      const defaultAccount = await AccountService.getUserDefaultAccount(user.id);

      // Indication informative du jeton, jamais une source de droits : un
      // impayé reste connectable sans « abonnement actif » (APP-FUNC-31).
      const isSubscribedOrTrialing = !!defaultAccount && hasActiveSubscriptionStatus(defaultAccount.subscriptionStatus);

      const tokenPayload = {
        id: user.id,
        email: user.email,
        role: user.role as UserRole,
        planType: user.planType as PlanType,
        status: user.status as UserStatus,
        currentAccountId: defaultAccount?.id,
        hasActiveAccount: isSubscribedOrTrialing,
      };

      const { accessToken, refreshToken } = await generateSessionTokens(tokenPayload);

      // ══════════════════════════════════════════════════════════════════
      // AUCUN JETON DANS L'URL — CDC cookies §5.1 et §13
      //
      // Cette redirection transportait `at` et `rt` en clair dans la query
      // string. Une URL finit dans l'historique du navigateur, dans l'en-tete
      // `Referer` envoye aux tiers, dans les journaux du reverse proxy et dans
      // les outils de mesure : c'est exactement la fuite de jeton que le
      // chantier « suppression du stockage local » vise a supprimer.
      //
      // Les deux jetons sont deja poses en cookies HttpOnly sur cette meme
      // reponse (ci-dessous) : la session est etablie sans eux. La page de
      // destination les ignorait d'ailleurs deja.
      // ══════════════════════════════════════════════════════════════════
      const params = new URLSearchParams({ status: 'success' });
      if (normalizedPlan) params.set('plan', normalizedPlan);

      // Lot 57A / P2 inscription des invités : une invitation Premium Duo EN
      // ATTENTE pour cette adresse (désormais vérifiée) → la page propose de
      // rejoindre le Duo, même si l'e-mail est ouvert dans un autre
      // navigateur que l'inscription. Simple indication : le rattachement
      // reste contrôlé par POST /api/duo/join (session, adresse invitée).
      const pendingDuo = await hasPendingDuoInvitation(user.email);
      if (pendingDuo) params.set('duo', '1');
      // Lot 72D : identité qui rejoint un compte existant — aucun essai à
      // annoncer ; sans espace (invitation Duo à accepter) : l'écran le dit.
      if (joinedAccountIds.length > 0) params.set('joined', '1');
      if (!defaultAccount) params.set('space', 'none');

      const targetPath = normalizedPlan && !pendingDuo ? '/abonnement/onboarding' : '/verify-email';
      const response = NextResponse.redirect(`${baseUrl()}${targetPath}?${params.toString()}`);

      // Lot 53A (Q21, CDC 18 §19.3) : mêmes durées que partout ailleurs —
      // l'accès vivait ici 2 h au lieu de 15 min.
      setSessionCookies(response, { accessToken, refreshToken });
      // D1 : le lien reçu par e-mail prouve le contrôle de la boîte — ce
      // navigateur est reconnu pour ce compte.
      rememberTrustedDevice(request, response, normalizeEmail(user.email));

      return response;
    } catch {
      // Token generation failed — fall back to asking user to log in
      return redirect(`/verify-email?status=success${planSuffix}`);
    }

  } catch (error) {
    console.error('Verify email error:', error);
    return redirect('/verify-email?error=server_error');
  }
}

/**
 * Lot 72D : active les invitations à un compte partagé réservées à cette
 * identité (posées par l'inscription sur invitation), encore valides et
 * destinées à cette adresse. Jamais bloquant pour la vérification.
 */
async function activateReservedAccountInvitations(userId: number, email: string): Promise<number[]> {
  try {
    const now = new Date();
    const rows = await db
      .update(accountMemberships)
      .set({
        status: 'active',
        joinedAt: now,
        inviteToken: null,
        inviteTokenExpiresAt: null,
        lastSelectedAt: now,
        source: 'account_invitation',
        updatedAt: now,
      })
      .where(and(
        eq(accountMemberships.userId, userId),
        eq(accountMemberships.status, 'pending'),
        sql`(${accountMemberships.inviteTokenExpiresAt} IS NULL OR ${accountMemberships.inviteTokenExpiresAt} > now())`,
        sql`(${accountMemberships.invitedEmail} IS NULL OR lower(${accountMemberships.invitedEmail}) = ${email.trim().toLowerCase()})`,
      ))
      .returning({ accountId: accountMemberships.accountId });
    for (const r of rows) {
      await db.insert(accountAuditLog).values({
        accountId: r.accountId, userId, userEmail: email, actionType: 'MEMBER_JOINED',
        targetUserId: userId, targetUserEmail: email,
        details: JSON.stringify({ role: 'member', source: 'account_invitation' }), timestamp: now,
      });
    }
    return rows.map((r) => r.accountId);
  } catch (e) {
    console.error('[verify-email] activation des invitations de compte impossible:', (e as Error).message);
    return [];
  }
}

/** Invitation Premium Duo en attente, non expirée, adressée à cette adresse. */
async function hasPendingDuoInvitation(email: string): Promise<boolean> {
  try {
    const rows = await db
      .select({ id: duoAccounts.id })
      .from(duoAccounts)
      .where(and(
        isNotNull(duoAccounts.pendingInviteToken),
        sql`lower(${duoAccounts.pendingInviteEmail}) = ${email.trim().toLowerCase()}`,
        sql`(${duoAccounts.pendingInviteTokenExpiresAt} IS NULL OR ${gt(duoAccounts.pendingInviteTokenExpiresAt, new Date())})`,
      ))
      .limit(1);
    return rows.length > 0;
  } catch {
    return false; // indication seulement : jamais bloquant
  }
}
