import { NextRequest, NextResponse } from 'next/server';
import { extractAccessToken } from '@/lib/auth/token-extractor';
import { verifySessionAccessToken } from '@/lib/auth/session-guard';
import { SessionService } from '@/lib/session-service';
import { isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { db, pgClient } from '@/db';
import { users, accounts, accountMemberships, duoAccounts, duoMemberships } from '@/db/schema';
import { eq, and, or } from 'drizzle-orm';
import { serverCacheGet, serverCacheSet, userCacheKey, wantsFreshRead } from '@/lib/server-cache';
import { getTrialState } from '@/services/trial.service';
import { handleCloseAccount } from './deletion/close-account';

export async function GET(request: NextRequest) {
  try {
    const token = extractAccessToken(request);

    if (!token) {
      return NextResponse.json(
        { error: 'AUTH_REQUIRED', message: 'Authentification requise' },
        { status: 401 }
      );
    }

    const payload = await verifySessionAccessToken(token, request);

    if (!payload) {
      return NextResponse.json(
        { error: 'INVALID_TOKEN', message: 'Token invalide ou expiré' },
        { status: 401 }
      );
    }

    if (payload.status === 'SUSPENDED' || payload.status === 'DELETED') {
      return NextResponse.json(
        { error: 'ACCOUNT_SUSPENDED', message: 'Compte suspendu ou supprimé' },
        { status: 403 }
      );
    }

    // Cache serveur 30s : /api/users/me est appelé sur chaque page dashboard.
    // APP-PERF-22 : clé par utilisateur ET compte courant de la session (le
    // même utilisateur peut basculer d'espace), invalidée par ses écritures
    // et par la synchronisation d'abonnement ; contournée sur demande de
    // fraîcheur. Pas de cache HTTP navigateur (non cloisonné par session).
    const cacheKey = userCacheKey(payload.userId, 'me', payload.currentAccountId ?? 0);
    const cached = wantsFreshRead(request.headers) ? null : serverCacheGet<object>(cacheKey);
    if (cached) {
      const meResponse = NextResponse.json(cached);
      meResponse.headers.set('Cache-Control', 'private, no-cache');
      return meResponse;
    }

    const [userRows, duoMembershipData] = await Promise.all([
      db
        .select({
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          username: users.username,
          company: users.company,
          role: users.role,
          planType: users.planType,
          status: users.status,
          hasSeenUploadNotice: users.hasSeenUploadNotice,
          accountName: accounts.name,
          accountId: accounts.id,
          subscriptionStatus: accounts.subscriptionStatus,
        })
        .from(users)
        .leftJoin(accountMemberships, and(
          eq(accountMemberships.userId, users.id),
          or(eq(accountMemberships.status, 'active'), eq(accountMemberships.status, 'ACTIVE'))
        ))
        .leftJoin(accounts, eq(accounts.id, accountMemberships.accountId))
        .where(eq(users.id, payload.userId))
        .limit(1),
      db
        .select({
          duoId: duoMemberships.duoId,
          membershipStatus: duoMemberships.status,
          slot: duoMemberships.slot,
          duoSubscriptionStatus: duoAccounts.subscriptionStatus,
          duoActivatedAt: duoAccounts.activatedAt,
          unpaidRecoveryEndsAt: duoAccounts.unpaidRecoveryEndsAt,
          billingOwnerUserId: duoAccounts.billingOwnerUserId,
        })
        .from(duoMemberships)
        .innerJoin(duoAccounts, eq(duoAccounts.id, duoMemberships.duoId))
        .where(
          and(
            eq(duoMemberships.userId, payload.userId),
            or(
              eq(duoMemberships.status, 'ACTIVE'),
              eq(duoMemberships.status, 'INVITED')
            )
          )
        )
        .limit(1),
    ]);

    const [userData] = userRows;

    if (!userData) {
      return NextResponse.json(
        { error: 'USER_NOT_FOUND', message: 'Utilisateur introuvable' },
        { status: 404 }
      );
    }

    const duoInfo = duoMembershipData[0] || null;

    // users.planType est la source de vérité : STANDARD | PREMIUM | PREMIUM_DUO | PREMIUM_PRO
    const effectivePlan = userData.planType ? userData.planType.toUpperCase() : 'STANDARD';

    const duoEntitlement = effectivePlan === 'PREMIUM_DUO';

    const isDuoGuest = duoInfo && duoInfo.billingOwnerUserId !== payload.userId;
    const rawSubscriptionStatus = isDuoGuest
      ? duoInfo.duoSubscriptionStatus
      : userData.subscriptionStatus;

    // Statut AFFICHÉ, jamais une source de droits (entitlements). Aucune
    // écriture ici : la fin du délai de régularisation d'un impayé est
    // traitée par le balayage `billing-unpaid` (APP-FUNC-31), plus par une
    // lecture de profil qui passait le compte en EXPIRED.
    const finalSubscriptionStatus = rawSubscriptionStatus || 'NONE';

    // ══════════════════════════════════════════════════════════════════════
    // LE CORPS EST CONSTRUIT AVANT LA RÉPONSE, PAS RELU DEPUIS ELLE
    //
    // Le code d'origine construisait la réponse, puis appelait
    // `await meResponse.json()` pour alimenter le cache — et renvoyait la
    // même réponse.
    //
    // Or lire une réponse CONSOMME son flux. La réponse renvoyée était donc
    // vide et verrouillée :
    //
    //   Error: failed to pipe response
    //     [cause]: TypeError: Invalid state: The ReadableStream is locked
    //
    // `/api/users/me` répondait 500. Comme elle porte l'identité, tout ce qui
    // suivait tombait en 401 : accueil, biens, à-traiter, statut d'essai. Un
    // import de document paraissait « rester en cours » alors que le
    // navigateur n'était simplement plus authentifié.
    // ══════════════════════════════════════════════════════════════════════
    // ══════════════════════════════════════════════════════════════════════
    // ⚠️ L'ÉTAT D'ESSAI MANQUAIT DANS LA SESSION
    //
    // `subscription.plan` vient de `users.plan_type`, que l'attribution
    // d'essai ne touche pas : l'essai vit dans `account_subscriptions`
    // (`plan_code = 'premium'`, `status = 'trialing'`). Un compte en essai
    // porte donc `STANDARD` dans la colonne lue par le menu, qui affichait
    // « Standard » à un utilisateur en essai gratuit.
    //
    // Le même manque rendait `SidebarPlanCard` inerte : `DashboardLayout`
    // lui passe `subscription?.trialDaysLeft`, une propriété que cette
    // route n'a jamais servie. La carte « Essai gratuit · J-x » ne
    // s'affichait donc jamais.
    //
    // On sert l'état, on ne change pas le plan : les droits restent ceux de
    // `plan_type` (cf. `@/lib/plan-label`).
    // ══════════════════════════════════════════════════════════════════════
    let trialStatus: 'none' | 'active' | 'expired' | 'converted' = 'none';
    let trialDaysLeft: number | null = null;
    if (userData.accountId) {
      try {
        const etat = await getTrialState(userData.accountId);
        trialStatus = etat.status;
        if (etat.status === 'active') trialDaysLeft = etat.daysRemaining;
      } catch (err) {
        // L'identité ne doit jamais tomber pour un libellé d'offre.
        console.error('[users/me] état d\'essai illisible:', err);
      }
    }

    // Un seul espace : le nom n'a rien à distinguer. Plusieurs : il devient
    // utile de savoir dans lequel on se trouve.
    const [espaces] = await pgClient<{ total: number }[]>`
      SELECT count(DISTINCT account_id)::int AS total
      FROM account_memberships
      WHERE user_id = ${userData.id} AND status = 'active'
    `;
    const nombreEspaces = espaces?.total ?? 1;

    const corps = {
      id: userData.id,
      email: userData.email,
      firstName: userData.firstName,
      lastName: userData.lastName,
      username: userData.username ?? null,
      company: userData.company ?? null,
      accountName: userData.accountName,
      /**
       * Nombre d'espaces auxquels l'utilisateur a accès.
       *
       * Le panneau de compte n'affiche le nom de l'espace partagé que s'il y
       * en a plusieurs à distinguer. Sans ce décompte, la condition ne peut
       * pas être évaluée côté client — et afficher « Compte de Geoffroy
       * Maupilier » à quelqu'un qui n'a qu'un espace n'apprend rien.
       */
      accountsCount: nombreEspaces,
      role: userData.role,
      // PENDING_DELETION : compte clôturé, suppression programmée (J+30).
      status: userData.status,
      hasSeenUploadNotice: userData.hasSeenUploadNotice ?? false,
      subscription: {
        plan: effectivePlan,
        status: finalSubscriptionStatus,
        // Sert le libellé et la carte de la barre latérale. N'accorde aucun droit.
        trialStatus,
        trialDaysLeft,
        isTrial: trialStatus === 'active',
      },
      subscription_status: finalSubscriptionStatus,
      duoId: duoInfo?.duoId ?? null,
      duoStatus: duoInfo?.duoSubscriptionStatus ?? null,
      duoRole: duoInfo ? (duoInfo.billingOwnerUserId === payload.userId ? 'BILLING_OWNER' : 'MEMBER') : null,
      duoActivatedAt: duoInfo?.duoActivatedAt ?? null,
      unpaidRecoveryEndsAt: duoInfo?.unpaidRecoveryEndsAt ?? null,
      isInRecovery: duoInfo?.duoSubscriptionStatus === 'UNPAID_RECOVERY',
      duoEntitlement,
      effectivePlan,
    };

    // Le cache reçoit l'objet, la réponse est construite après : aucune
    // lecture de flux, donc aucun verrouillage possible.
    serverCacheSet(cacheKey, corps, 30_000);

    const meResponse = NextResponse.json(corps);
    meResponse.headers.set('Cache-Control', 'private, no-cache');
    return meResponse;
  } catch (error) {
    // Vérification de session impossible (base injoignable) : 503 explicite,
    // que le client traite comme une indisponibilité, pas une déconnexion.
    if (isSessionError(error)) return sessionErrorResponse(error);
    return NextResponse.json(
      { error: 'SERVER_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

/**
 * Suppression du compte — n'est plus immédiate.
 *
 * Ce point d'entrée anonymisait l'utilisateur dans la requête et laissait
 * ses biens, documents et fichiers en place. Décision produit : la
 * suppression volontaire est DIFFÉRÉE DE 30 JOURS (clôture immédiate,
 * annulation et export possibles, suppression complète à J+30). Il délègue
 * désormais au parcours unique `POST /api/users/me/deletion`, avec les mêmes
 * exigences (texte de confirmation ET mot de passe).
 */
export async function DELETE(req: NextRequest) {
  return handleCloseAccount(req);
}

export async function PUT(req: NextRequest) {
  try {
    let session;
    try {
      session = await SessionService.getSession(req);
    } catch (e) {
      return SessionService.handleSessionError(e);
    }

    const body = await req.json();
    const { firstName, lastName, username, company } = body;

    if (!firstName?.trim() || !lastName?.trim()) {
      return NextResponse.json({ error: 'Le prénom et le nom sont requis' }, { status: 400 });
    }

    await db.update(users).set({
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      username: username?.trim() || null,
      company: company?.trim() || null,
      updatedAt: new Date(),
    }).where(eq(users.id, session.userId));

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: 'SERVER_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
