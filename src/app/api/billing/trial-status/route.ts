import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { newRequestId } from '@/lib/auth/session-errors';
import { db } from '@/db';
import { accountMemberships, accounts, assets, assetFiles, accountSubscriptions } from '@/db/schema';
import { eq, and, or, isNull, count } from 'drizzle-orm';
import { getTrialState, hasUsedTrial } from '@/services/trial.service';
import { getEntitlements, quotaUsage } from '@/services/entitlements.service';
import { getScheduledChange } from '@/services/plan-change.service';
import { kickPendingCheckoutReconciliation, pendingCheckoutState } from '@/services/billing/pending-checkout.service';
import { computeUnpaidCycle } from '@/services/billing/unpaid-cycle.rules';

/**
 * GET /api/billing/trial-status
 *
 * Etat de l'essai, droits effectifs et consommation des quotas.
 * Alimente le bandeau d'essai, les compteurs « x sur y » et l'ecran
 * de fin d'essai (CDC §9).
 *
 * Toutes les valeurs sont calculees cote serveur : le client se contente
 * de les afficher.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await SessionService.getSession(request);

    const [membership] = await db
      .select({ accountId: accountMemberships.accountId })
      .from(accountMemberships)
      .where(eq(accountMemberships.userId, session.userId))
      .limit(1);

    if (!membership) {
      return NextResponse.json(
        { error: 'User has no account', code: 'ACCOUNT_NOT_FOUND', message: 'Aucun compte n’est rattaché à cet utilisateur.' },
        { status: 404 },
      );
    }

    // Compte de la session d'abord : c'est celui que les routes d'écriture
    // contrôlent. `LIMIT 1` sans ordre pouvait désigner un autre compte de
    // l'utilisateur (invitation, Duo) et afficher des droits qui ne sont
    // pas ceux appliqués.
    const accountId = session.currentAccountId ?? membership.accountId;

    // ══════════════════════════════════════════════════════════════════
    // LECTURE LOCALE, SANS STRIPE (APP-PERF-18)
    //
    // Cette route attendait la vérification Stripe d'un paiement en attente
    // avant de lire les droits. Les droits se lisent désormais dans la base
    // uniquement ; le paiement en attente est SIGNALÉ (`pendingPayment`),
    // sans aucun droit, et sa vérification est confiée à la réconciliation
    // durable (`pending-checkout.service`) — déclenchée ici sans être
    // attendue quand elle est due. Lectures indépendantes en parallèle.
    // ══════════════════════════════════════════════════════════════════
    const now = new Date();
    const [trial, entitlements, scheduled, [sub], [accountRow], [assetRow], [docRow]] = await Promise.all([
      getTrialState(accountId),
      getEntitlements(accountId, now),
      getScheduledChange(accountId),
      // Details d'abonnement pour l'ecran « Mon abonnement » (CDC §9.1)
      db
        .select({
          planCode: accountSubscriptions.planCode,
          billingPeriod: accountSubscriptions.billingPeriod,
          currentPeriodEndAt: accountSubscriptions.currentPeriodEndAt,
          cancelAtPeriodEnd: accountSubscriptions.cancelAtPeriodEnd,
          stripeSubscriptionId: accountSubscriptions.stripeSubscriptionId,
        })
        .from(accountSubscriptions)
        .where(eq(accountSubscriptions.accountId, accountId))
        .limit(1),
      // Cycle d'impayé (GAP-06, AID-BILL-008) et paiement en attente : l'écran
      // doit distinguer l'impayé d'une fin d'essai et afficher l'échéance.
      db
        .select({
          unpaidStartedAt: accounts.unpaidStartedAt,
          unpaidRecoveryEndsAt: accounts.unpaidRecoveryEndsAt,
          checkoutSessionId: accounts.checkoutSessionId,
          checkoutSessionCreatedAt: accounts.checkoutSessionCreatedAt,
          checkoutNextCheckAt: accounts.checkoutNextCheckAt,
        })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .limit(1),
      // Consommation reelle (biens et documents non supprimes)
      db
        .select({ value: count() })
        .from(assets)
        .where(and(eq(assets.accountId, accountId), isNull(assets.deletedAt))),
      // ══════════════════════════════════════════════════════════════════
      // ⚠️ CE COMPTEUR VOYAIT DES DOCUMENTS QUI N'EXISTENT PAS
      //
      // Il comptait TOUTES les lignes `asset_files` non supprimées, sans
      // regarder `upload_status`. Or `/api/files/presign` crée la ligne AVANT
      // le téléversement : un envoi abandonné, échoué ou interrompu laisse une
      // ligne `PENDING` derrière lui. Même filtre partout que la page « Mes
      // documents » et le contrôle de quota du presign : un document est une
      // ligne téléversée.
      // ══════════════════════════════════════════════════════════════════
      db
        .select({ value: count() })
        .from(assetFiles)
        .where(and(
          eq(assetFiles.accountId, accountId),
          isNull(assetFiles.deletedAt),
          or(
            eq(assetFiles.uploadStatus, 'COMPLETED'),
            isNull(assetFiles.uploadStatus),
          ),
        )),
    ]);

    const unpaidCycle = accountRow?.unpaidStartedAt
      ? computeUnpaidCycle(accountRow.unpaidStartedAt, now, accountRow.unpaidRecoveryEndsAt)
      : null;

    const pending = pendingCheckoutState(accountRow, now);
    if (pending?.due) kickPendingCheckoutReconciliation(accountId);

    const assetsUsed = assetRow?.value ?? 0;
    const documentsUsed = docRow?.value ?? 0;

    // ══════════════════════════════════════════════════════════════════
    // « PAS D'ESSAI » A DEUX CAUSES TRÈS DIFFÉRENTES
    //
    // Soit l'attribution a échoué — anomalie technique.
    // Soit l'adresse a DÉJÀ consommé son essai (§3.4) — comportement
    // attendu, notamment lorsqu'un compte est recréé.
    //
    // L'écran annonçait « n'a pas pu être activé » dans les deux cas, ce qui
    // laisse croire à une panne là où la règle s'applique normalement.
    // ══════════════════════════════════════════════════════════════════
    const dejaConsomme =
      trial.status === 'none' && (await hasUsedTrial(session.email ?? ''));

    return NextResponse.json({
      trial: {
        status: trial.status,
        dejaConsomme,
        daysRemaining: trial.status === 'active' ? trial.daysRemaining : 0,
        endsAt: 'endsAt' in trial ? trial.endsAt.toISOString() : null,
        // A J-2 et J-1, le bandeau doit devenir plus visible (CDC §9.2)
        isUrgent: trial.status === 'active' && trial.daysRemaining <= 2,
      },
      plan: entitlements.plan,
      status: entitlements.status,
      subscription: {
        planCode: sub?.planCode ?? null,
        billingPeriod: sub?.billingPeriod ?? null,
        currentPeriodEndAt: sub?.currentPeriodEndAt?.toISOString() ?? null,
        cancelAtPeriodEnd: Boolean(sub?.cancelAtPeriodEnd),
        scheduledChange: scheduled
          ? {
              planCode: scheduled.planCode,
              billingPeriod: scheduled.billingPeriod,
              effectiveAt: scheduled.effectiveAt?.toISOString() ?? null,
            }
          : null,
        hasStripeSubscription: Boolean(sub?.stripeSubscriptionId),
      },
      // Paiement Checkout engagé mais pas encore constaté : affiché comme tel,
      // AUCUN droit associé tant que le paiement n'est pas appliqué.
      pendingPayment: pending ? { since: pending.since.toISOString() } : null,
      unpaid: unpaidCycle
        ? {
            startedAt: unpaidCycle.startedAt.toISOString(),
            deadlineAt: unpaidCycle.deadlineAt.toISOString(),
            daysLeft: unpaidCycle.daysLeft,
          }
        : null,
      premiumFeatures: entitlements.premiumFeatures,
      canWrite: entitlements.canWrite,
      isRestricted: entitlements.isRestricted,
      quotas: {
        assets: quotaUsage(assetsUsed, entitlements.quotas.maxAssets),
        documents: quotaUsage(documentsUsed, entitlements.quotas.maxDocuments),
        users: { limit: entitlements.quotas.maxUsers },
      },
    });
  } catch (error) {
    // Refus de session (absente, invalide, révoquée, compte suspendu) : 401 /
    // 403 normaux, non journalisés comme panne (APP-PERF-20). Ils étaient
    // tous rendus en 500, ce qui empêchait le client de renouveler la session.
    const requestId = newRequestId();
    if (isSessionError(error)) return sessionErrorResponse(error, requestId);
    console.error(`[trial-status][${requestId}] erreur:`, error instanceof Error ? error.message : error);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', code: 'INTERNAL_ERROR', message: 'Droits momentanément indisponibles. Réessayez dans un instant.', requestId },
      { status: 500, headers: { 'x-request-id': requestId } },
    );
  }
}
