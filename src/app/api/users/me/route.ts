import { NextRequest, NextResponse } from 'next/server';
import { extractAccessToken } from '@/lib/auth/token-extractor';
import { verifySessionAccessToken } from '@/lib/auth/session-guard';
import { SessionService } from '@/lib/session-service';
import { isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { db, pgClient } from '@/db';
import { users, accounts, accountMemberships, duoAccounts } from '@/db/schema';
import { duoOfAccount } from '@/services/account/membership.service';
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

    // ══════════════════════════════════════════════════════════════════════
    // LOT 72D — L'OFFRE AFFICHÉE EST CELLE DU COMPTE DE LA SESSION
    //
    // Avant : le compte était la « première adhésion active » (sans ordre),
    // l'offre `users.plan_type`, le rôle Duo pris de `duo_memberships` quel
    // que soit l'espace ouvert. Un invité Duo voyait donc « Essai gratuit ·
    // J-x » (essai de son compte personnel artificiel) au lieu de « Premium
    // Duo — Membre ». Désormais tout dérive du compte COURANT
    // (`currentAccountId`, adhésion vérifiée par la garde) : offre, statut,
    // essai (titulaire seulement — l'essai et la facturation ne concernent
    // pas un membre), rôle d'adhésion. `users.plan_type` n'est plus lu.
    // ══════════════════════════════════════════════════════════════════════
    const currentAccountId = payload.currentAccountId ?? null;
    const [userRows, accountRows] = await Promise.all([
      db
        .select({
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          username: users.username,
          company: users.company,
          role: users.role,
          status: users.status,
          hasSeenUploadNotice: users.hasSeenUploadNotice,
        })
        .from(users)
        .where(eq(users.id, payload.userId))
        .limit(1),
      currentAccountId
        ? db
            .select({
              accountId: accounts.id,
              accountName: accounts.name,
              planType: accounts.planType,
              subscriptionStatus: accounts.subscriptionStatus,
              membershipRole: accountMemberships.role,
            })
            .from(accounts)
            .leftJoin(accountMemberships, and(
              eq(accountMemberships.accountId, accounts.id),
              eq(accountMemberships.userId, payload.userId),
              or(eq(accountMemberships.status, 'active'), eq(accountMemberships.status, 'ACTIVE')),
            ))
            .where(eq(accounts.id, currentAccountId))
            .limit(1)
        : Promise.resolve([]),
    ]);

    const [userData] = userRows;

    if (!userData) {
      return NextResponse.json(
        { error: 'USER_NOT_FOUND', message: 'Utilisateur introuvable' },
        { status: 404 }
      );
    }

    const account = accountRows[0] ?? null;
    // Compte historique sans ligne d'adhésion : la garde admet le titulaire
    // `owner_user_id` — rôle titulaire.
    const accountRole: 'owner' | 'admin' | 'member' | null = account
      ? ((account.membershipRole as 'owner' | 'admin' | 'member' | null) ?? 'owner')
      : null;

    const duoId = account ? await duoOfAccount(account.accountId) : null;
    const [duoInfo] = duoId
      ? await db
          .select({
            duoSubscriptionStatus: duoAccounts.subscriptionStatus,
            duoActivatedAt: duoAccounts.activatedAt,
            unpaidRecoveryEndsAt: duoAccounts.unpaidRecoveryEndsAt,
          })
          .from(duoAccounts)
          .where(eq(duoAccounts.id, duoId))
          .limit(1)
      : [];

    const effectivePlan = account?.planType ? account.planType.toUpperCase() : 'STANDARD';
    const duoEntitlement = effectivePlan === 'PREMIUM_DUO';
    const isDuoSpace = !!duoInfo && duoEntitlement;

    // Statut AFFICHÉ, jamais une source de droits (entitlements). Aucune
    // écriture ici : la fin du délai de régularisation d'un impayé est
    // traitée par le balayage `billing-unpaid` (APP-FUNC-31).
    const finalSubscriptionStatus = account?.subscriptionStatus || 'NONE';

    // ══════════════════════════════════════════════════════════════════════
    // LE CORPS EST CONSTRUIT AVANT LA RÉPONSE, PAS RELU DEPUIS ELLE
    // (lire une réponse consomme son flux : `/api/users/me` répondait 500).
    // ══════════════════════════════════════════════════════════════════════
    // État d'essai (`account_subscriptions`) du compte COURANT, servi au
    // titulaire seulement : il sert le libellé et la carte de la barre
    // latérale, n'accorde aucun droit (cf. `@/lib/plan-label`).
    let trialStatus: 'none' | 'active' | 'expired' | 'converted' = 'none';
    let trialDaysLeft: number | null = null;
    if (account && accountRole === 'owner') {
      try {
        const etat = await getTrialState(account.accountId);
        trialStatus = etat.status;
        if (etat.status === 'active') trialDaysLeft = etat.daysRemaining;
      } catch (err) {
        // L'identité ne doit jamais tomber pour un libellé d'offre.
        console.error('[users/me] état d\'essai illisible:', err);
      }
    }

    // Un seul espace : le nom n'a rien à distinguer. Plusieurs : il devient
    // utile de savoir dans lequel on se trouve (sélecteur d'espace, lot 72D :
    // les comptes archivés ne comptent pas, sauf l'espace ouvert).
    const [espaces] = await pgClient<{ total: number }[]>`
      SELECT count(DISTINCT m.account_id)::int AS total
      FROM account_memberships m
      JOIN accounts a ON a.id = m.account_id
      WHERE m.user_id = ${userData.id} AND m.status = 'active'
        AND (a.archived_at IS NULL OR a.id = ${currentAccountId ?? 0})
    `;
    const nombreEspaces = espaces?.total ?? 1;

    const corps = {
      id: userData.id,
      email: userData.email,
      firstName: userData.firstName,
      lastName: userData.lastName,
      username: userData.username ?? null,
      company: userData.company ?? null,
      accountName: account?.accountName ?? null,
      /** Lot 72D : compte de la session (null : identité sans espace, écran dédié). */
      accountId: account?.accountId ?? null,
      /** Lot 72D : rôle d'adhésion sur le compte de la session. */
      accountRole,
      /**
       * Nombre d'espaces auxquels l'utilisateur a accès.
       *
       * Le panneau de compte n'affiche le nom de l'espace partagé que s'il y
       * en a plusieurs à distinguer ; le sélecteur d'espace aussi (Q6).
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
      duoId: isDuoSpace ? duoId : null,
      duoStatus: isDuoSpace ? duoInfo.duoSubscriptionStatus : null,
      duoRole: isDuoSpace ? (accountRole === 'owner' ? 'BILLING_OWNER' : 'MEMBER') : null,
      duoActivatedAt: isDuoSpace ? duoInfo.duoActivatedAt : null,
      unpaidRecoveryEndsAt: isDuoSpace ? duoInfo.unpaidRecoveryEndsAt : null,
      isInRecovery: isDuoSpace && duoInfo.duoSubscriptionStatus === 'UNPAID_RECOVERY',
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
