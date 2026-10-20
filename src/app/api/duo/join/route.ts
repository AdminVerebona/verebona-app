import { NextRequest, NextResponse } from 'next/server';
import { isDuoJoinable } from '@/lib/billing/subscription-status';
import { signalerDroitsModifies } from '@/services/duo/duo-exit.service';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { users, duoAccounts } from '@/db/schema';
import { eq, and, isNotNull, sql } from 'drizzle-orm';
import { inviteTokenHash } from '@/lib/duo/invite-token-hash';
import { DUO_JOIN_HTTP_STATUS, joinDuoByInvitation } from '@/services/account/membership.service';
import { issueSessionTokensOnAccount, setSessionCookies } from '@/lib/auth/session-tokens';

/**
 * GET /api/duo/join?token=xxx
 * Validate a duo invitation token (public endpoint, no auth required)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token');

  if (!token) {
    return NextResponse.json({ error: 'MISSING_TOKEN' }, { status: 400 });
  }

  const [duo] = await db
    .select({
      id: duoAccounts.id,
      billingOwnerUserId: duoAccounts.billingOwnerUserId,
      pendingInviteEmail: duoAccounts.pendingInviteEmail,
      pendingInviteTokenExpiresAt: duoAccounts.pendingInviteTokenExpiresAt,
      subscriptionStatus: duoAccounts.subscriptionStatus,
    })
    .from(duoAccounts)
    .where(eq(duoAccounts.pendingInviteToken, token))
    .limit(1);

  if (!duo) {
    // Lot 57A (P2 inscription des invités) : invitation DÉJÀ UTILISÉE
    // distinguée d'un lien inconnu, par l'empreinte du dernier jeton consommé.
    const [used] = await db
      .select({ id: duoAccounts.id })
      .from(duoAccounts)
      .where(eq(duoAccounts.lastUsedInviteTokenHash, inviteTokenHash(token)))
      .limit(1);
    if (used) return NextResponse.json({ error: 'USED_TOKEN' }, { status: 410 });
    // Lot 73B : invitation REFUSÉE par la personne invitée (empreinte du jeton).
    const [declined] = await db
      .select({ id: duoAccounts.id })
      .from(duoAccounts)
      .where(eq(duoAccounts.lastDeclinedInviteTokenHash, inviteTokenHash(token)))
      .limit(1);
    if (declined) return NextResponse.json({ error: 'DECLINED_TOKEN' }, { status: 410 });
    return NextResponse.json({ error: 'INVALID_TOKEN' }, { status: 404 });
  }

  if (duo.pendingInviteTokenExpiresAt && new Date(duo.pendingInviteTokenExpiresAt) < new Date()) {
    return NextResponse.json({ error: 'EXPIRED_TOKEN' }, { status: 410 });
  }

  // Rejoindre un Duo est une écriture : refusée pendant un impayé
  // (UNPAID_RECOVERY), comme toute écriture — aucune grâce (APP-FUNC-31).
  if (!isDuoJoinable(duo.subscriptionStatus)) {
    return NextResponse.json({ error: 'SUBSCRIPTION_INACTIVE' }, { status: 403 });
  }

  const [owner] = await db
    .select({ firstName: users.firstName, lastName: users.lastName })
    .from(users)
    .where(eq(users.id, duo.billingOwnerUserId))
    .limit(1);

  return NextResponse.json({
    valid: true,
    ownerName: owner ? `${owner.firstName} ${owner.lastName}` : '',
    inviteEmail: duo.pendingInviteEmail,
  });
}

/**
 * POST /api/duo/join
 * Authenticated: join a duo account via invitation token
 * Body: { token: string }
 */
export async function POST(request: NextRequest) {
  try {
    const session = await SessionService.getSession(request);
    const body = await request.json();
    let token: string | undefined = typeof body?.token === 'string' ? body.token : undefined;

    // ════════════════════════════════════════════════════════════════════
    // LOT 57A — REPRISE SANS JETON LOCAL (deux navigateurs)
    //
    // L'invité a créé son compte dans un navigateur et ouvert l'e-mail de
    // vérification dans un autre (téléphone…) : le jeton mémorisé n'y est
    // pas. `{ invitedEmail: true }` retrouve l'invitation EN ATTENTE adressée
    // à l'adresse de la SESSION — adresse vérifiée (aucune session sans
    // vérification). Jamais un identifiant fourni par le client : aucun
    // rattachement à un autre Duo par manipulation. Toutes les règles
    // ci-dessous (expiration, abonnement, place libre…) s'appliquent.
    // ════════════════════════════════════════════════════════════════════
    if (!token && body?.invitedEmail === true) {
      const email = String(session.email ?? '').trim().toLowerCase();
      const candidates = email
        ? await db
            .select({ token: duoAccounts.pendingInviteToken })
            .from(duoAccounts)
            .where(and(isNotNull(duoAccounts.pendingInviteToken), sql`lower(${duoAccounts.pendingInviteEmail}) = ${email}`))
            .limit(2)
        : [];
      if (candidates.length === 0) return NextResponse.json({ error: 'NO_PENDING_INVITATION' }, { status: 404 });
      if (candidates.length > 1) return NextResponse.json({ error: 'MULTIPLE_INVITATIONS' }, { status: 409 });
      token = candidates[0].token ?? undefined;
    }

    if (!token) {
      return NextResponse.json({ error: 'MISSING_TOKEN' }, { status: 400 });
    }

    // ════════════════════════════════════════════════════════════════════
    // LOT 72D — L'INVITÉ REJOINT LE COMPTE EXISTANT DU TITULAIRE
    //
    // Avant : seule une ligne `duo_memberships` était écrite — l'invité
    // restait dans son compte personnel (créé à l'inscription, avec un essai)
    // et ne voyait JAMAIS les données du Duo. Désormais (service unique,
    // transaction, compte verrouillé, idempotent) : adhésion `member` au
    // compte partagé + double écriture historique, puis la session est
    // RÉÉMISE sur ce compte (cookies) : accès immédiat aux biens, documents,
    // échéances et agenda existants.
    // ════════════════════════════════════════════════════════════════════
    const result = await joinDuoByInvitation({ userId: session.userId, email: String(session.email ?? ''), token });
    if (!result.ok) {
      const body: Record<string, string> = { error: result.error };
      if (result.error === 'INVITE_EMAIL_MISMATCH') {
        body.message = 'Cette invitation a été envoyée à une autre adresse e-mail. Connectez-vous avec l’adresse invitée.';
      }
      return NextResponse.json(body, { status: DUO_JOIN_HTTP_STATUS[result.error] });
    }

    // CDC Assistant §25.7 : droits du nouveau membre modifiés.
    signalerDroitsModifies();

    const response = NextResponse.json({ success: true, accountId: result.accountId, alreadyMember: result.alreadyMember });
    const [user] = await db
      .select({ id: users.id, email: users.email, role: users.role, planType: users.planType, status: users.status })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);
    const tokens = user ? await issueSessionTokensOnAccount(user, result.accountId) : null;
    if (tokens) setSessionCookies(response, tokens);
    return response;
  } catch (error) {
    return SessionService.handleSessionError(error);
  }
}
