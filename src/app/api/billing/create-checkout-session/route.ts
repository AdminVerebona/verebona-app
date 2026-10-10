import { NextRequest, NextResponse } from 'next/server';
import {
    getStoredReferralCode,
    normalizeReferralCode,
    resolveReferralCode,
} from '@/services/referral-attribution.service';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { users, accounts, accountMemberships, referralEvents, accountSubscriptions } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { getStripeServer, StripeConfigError } from '@/lib/stripe';
import { ensureStripeCustomer } from '@/lib/stripe-customer';
import Stripe from 'stripe';
import { getAppBaseUrl } from '@/lib/app-url';
import { trackFunnelEvent } from '@/services/funnel-analytics.service';
import { blocksNewCheckout, isUnpaidAccountStatus } from '@/lib/billing/subscription-status';
import { PENDING_CHECKOUT_FIRST_CHECK_DELAY_MS } from '@/services/billing/pending-checkout.service';
import { parseBillingPeriodInput, parseDisplayedRevision, parsePlanInput } from '@/lib/billing/plan-catalog';
import { BillingCatalogError, toPublicOffer, type ResolvedPrice } from '@/services/billing/catalog-types';
import { assertDisplayedRevision, resolveCurrentPrice } from '@/services/billing/price-catalog.service';
import { markOperation, reserveCheckout, type PriceOperation } from '@/services/billing/price-operations.service';

/**
 * POST /api/billing/create-checkout-session — NOUVELLE souscription.
 *
 * Body : { plan: 'standard' | 'premium' | 'premium_duo' | 'duo',
 *          billing_period: 'monthly' | 'yearly',
 *          displayed_price_revision: 'pr_…',     // révision du prix affiché
 *          referralCode?, entry_point? }
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CDC « Migration Stripe vers lookup_key » V4 — §10, LK-37 à LK-46
 *
 *   1. Validation stricte AVANT toute conversion (LK-37, TC-09) : une valeur
 *      inconnue, un objet au lieu d'une chaîne, une périodicité absente → 400
 *      INVALID_PLAN / INVALID_BILLING_PERIOD. Plus aucun repli sur Premium ou
 *      sur l'annuel ; l'alias historique `duo` est normalisé explicitement.
 *   2. Compte résolu depuis la session ; seul le TITULAIRE souscrit (LK-38,
 *      TC-11) — un membre Duo non payeur reçoit 403 FORBIDDEN_BILLING_ACTION.
 *      Un abonnement en cours renvoie vers le parcours de changement.
 *   3. Prix courant de la révision active, RELU chez Stripe (LK-23, LK-39) ;
 *      révision affichée comparée à celle du prix choisi (LK-34, LK-35) :
 *      absente → 409 PRICE_CONFIRMATION_REQUIRED, différente → 409
 *      PRICE_CHANGED avec le nouveau tarif ; aucune session n'est créée.
 *   4. Une seule tentative ouverte par compte, clé d'idempotence stable
 *      (LK-44, LK-45) ; une session ouverte n'est réutilisée que si son PRIX
 *      RÉEL, sa révision, son client et son compte correspondent (LK-42) —
 *      sinon elle est expirée de façon contrôlée.
 *   5. `line_items: [{ price: resolved.priceId, quantity: 1 }]` — jamais de
 *      `price_data`, de montant de formulaire ou d'ancien identifiant
 *      d'environnement ; Premium Duo : quantité 1 (§1.2). Aucun essai Stripe
 *      (`subscription_data` sans `trial_*`, LK-41).
 *
 * ROUTAGE (LK-46) : nouvelle souscription ici ; montée en gamme immédiate
 * → POST /api/billing/upgrade ; baisse ou changement de périodicité →
 * POST /api/billing/schedule-change. L'ancienne branche « passage direct à
 * Duo » (mise à jour d'abonnement avec prorata DANS cette route) est retirée :
 * un seul moteur de changement de prix.
 *
 * Aucun état d'abonnement n'est écrit avant le paiement : seule la
 * synchronisation Stripe (webhook, retour de paiement) accorde des droits.
 * ══════════════════════════════════════════════════════════════════════════
 */
export async function POST(request: NextRequest) {
    try {
        const session = await SessionService.getSession(request);
        // URL publique de l'app : derrière le proxy, `request.url` pointe sur
        // le port interne du conteneur (localhost:xxxxx).
        const appUrl = getAppBaseUrl(request);

        // ── 1. Entrées ────────────────────────────────────────────────────
        const raw = await request.json().catch(() => null);
        const body: Record<string, unknown> = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
        const plan = parsePlanInput(body.plan);
        if (!plan.ok) return catalogError(new BillingCatalogError('INVALID_PLAN'));
        const period = parseBillingPeriodInput(body.billing_period);
        if (!period.ok) return catalogError(new BillingCatalogError('INVALID_BILLING_PERIOD'));
        const displayedRevision = parseDisplayedRevision(body.displayed_price_revision);
        const referralCodeFromBody = normalizeReferralCode(body.referralCode);
        const entryPoint = typeof body.entry_point === 'string' ? body.entry_point.slice(0, 60) : 'app_subscription_page';
        const planCode = plan.plan;
        const billingPeriod = period.period;

        // ── 2. Utilisateur, compte (depuis la session), droit de souscrire ──
        const [user] = await db
            .select({ id: users.id, email: users.email, firstName: users.firstName, lastName: users.lastName })
            .from(users)
            .where(eq(users.id, session.userId))
            .limit(1);
        if (!user) {
            return NextResponse.json({ code: 'USER_NOT_FOUND', message: 'User not found' }, { status: 404 });
        }

        const memberships = await db
            .select({ accountId: accountMemberships.accountId, role: accountMemberships.role })
            .from(accountMemberships)
            .where(eq(accountMemberships.userId, user.id));
        const membership = memberships.find((m) => m.accountId === session.currentAccountId) ?? memberships[0];
        if (!membership) {
            return NextResponse.json({ code: 'NO_ACCOUNT', message: 'User has no account' }, { status: 404 });
        }
        if (membership.role !== 'owner') {
            return catalogError(new BillingCatalogError('FORBIDDEN_BILLING_ACTION'));
        }

        const [account] = await db
            .select({
                id: accounts.id,
                planType: accounts.planType,
                stripeCustomerId: accounts.stripeCustomerId,
                stripeSubscriptionId: accounts.stripeSubscriptionId,
                subscriptionStatus: accounts.subscriptionStatus,
            })
            .from(accounts)
            .where(eq(accounts.id, membership.accountId))
            .limit(1);
        if (!account) {
            return NextResponse.json({ code: 'ACCOUNT_NOT_FOUND', message: 'Account not found' }, { status: 404 });
        }

        // Un impayé se régularise ; un abonnement en cours se modifie
        // (montée en gamme / changement programmé), jamais doublé.
        const currentStatus = account.subscriptionStatus?.toUpperCase() || 'NONE';
        if (isUnpaidAccountStatus(currentStatus)) {
            return NextResponse.json(
                {
                    code: 'PAYMENT_REGULARIZATION_REQUIRED',
                    message: 'Un paiement de votre abonnement a échoué : régularisez-le depuis la gestion de votre abonnement pour retrouver l\'usage normal de votre compte.',
                },
                { status: 400 }
            );
        }
        if (blocksNewCheckout(currentStatus)) {
            const same = account.planType?.toUpperCase() === planCode.toUpperCase();
            return NextResponse.json(
                same
                    ? { code: 'SUBSCRIPTION_ALREADY_ACTIVE', message: 'Vous disposez déjà d\'un abonnement actif pour ce plan.' }
                    : { code: 'SUBSCRIPTION_CHANGE_REQUIRED', message: 'Un abonnement actif existe déjà pour un plan différent. Veuillez d\'abord modifier ou résilier votre abonnement actuel.' },
                { status: 400 }
            );
        }

        // ── 3. Prix courant relu chez Stripe + révision affichée ──────────
        const resolved = await resolveCurrentPrice(planCode, billingPeriod, { forPayment: true });
        assertDisplayedRevision(resolved, displayedRevision);

        const stripe = getStripeServer();

        // Client Stripe valide dans le mode courant — recréé si l'identifiant
        // stocké est orphelin (client live en preprod, base restaurée, etc.).
        const ensured = await ensureStripeCustomer({
            stripe,
            accountId: account.id,
            userId: user.id,
            email: user.email,
            name: `${user.firstName} ${user.lastName}`.trim(),
            storedCustomerId: account.stripeCustomerId,
        });
        const customerId = ensured.customerId;

        // ── Parrainage : code explicite prioritaire, sinon code retenu à
        //    l'inscription (CDC parrainage §4.5). Règles inchangées.
        const referralCode = referralCodeFromBody ?? (await getStoredReferralCode(user.id));
        const resolvedReferral = referralCode ? await resolveReferralCode(referralCode, account.id) : null;
        const promoContext = process.env.STRIPE_CHECKOUT_ALLOW_PROMOTION_CODES === 'true' ? 'promo-codes' : 'none';

        // ── 4. Tentative unique, partagée entre instances ─────────────────
        const reserve = () => reserveCheckout({
            accountId: account.id,
            userId: user.id,
            price: resolved,
            promoContext,
            referralCode: resolvedReferral ? referralCode : null,
            customerId,
        });
        let reservation = await reserve();
        if (reservation.kind === 'new' && reservation.superseded?.stripeReference) {
            // Tentative précédente à d'autres paramètres (autre offre, ancien
            // tarif…) : sa session est expirée ; payée entre-temps, on relit
            // l'abonnement au lieu d'en créer un second (LK-44, TC-34).
            if ((await expireReplacedSession(stripe, reservation.superseded.stripeReference)) === 'completed') {
                await markOperation(reservation.op.id, 'superseded');
                return verificationInProgress();
            }
        }
        if (reservation.kind === 'same' && reservation.op.stripeReference) {
            const reusable = await reusableSession(stripe, reservation.op.stripeReference, { customerId, accountId: account.id, price: resolved });
            if (reusable.url) return NextResponse.json({ checkout_url: reusable.url, offer: toPublicOffer(resolved) });
            if (reusable.completed) {
                await markOperation(reservation.op.id, 'completed');
                return verificationInProgress();
            }
            // Session expirée ou divergente : tentative close, nouvelle clé.
            await markOperation(reservation.op.id, 'expired');
            reservation = await reserve();
        }
        const op: PriceOperation = reservation.op;

        // Duo : le compte Duo doit exister avant le paiement ; il reste
        // inactif (CANCELED) jusqu'à la synchronisation du paiement.
        let duoId: number | null = null;
        if (planCode === 'premium_duo') duoId = await ensureInactiveDuo(user.id, account.id, customerId);

        void trackFunnelEvent({ event: 'checkout_opened', accountId: account.id, planCode, billingPeriod });

        const metadata = {
            userId: user.id.toString(),
            accountId: account.id.toString(),
            duoId: duoId?.toString() || '',
            planTier: planCode,
            billing_period: billingPeriod,
            environment: process.env.NEXT_PUBLIC_APP_ENV || 'unknown',
            // Références de diagnostic (LK-40) — jamais une source de droits.
            price_id: resolved.priceId,
            price_revision: resolved.priceRevision,
            price_operation_id: String(op.id),
        };

        let checkoutSession: Stripe.Checkout.Session;
        try {
            checkoutSession = await stripe.checkout.sessions.create({
                mode: 'subscription',
                customer: customerId,
                line_items: [{ price: resolved.priceId, quantity: 1 }],
                // Page de retour dédiée : elle applique le paiement, affiche la
                // confirmation puis recharge l'application avec les nouveaux droits.
                success_url: `${appUrl}/abonnement/success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${appUrl}/abonnement/cancel?plan=${planCode}`,
                metadata: { ...metadata, entry_point: entryPoint, referralCode: resolvedReferral ? (referralCode ?? '') : '' },
                billing_address_collection: 'auto',
                // CDC BO PRO-001/PRO-002 : codes promotionnels soumis à décision
                // produit (STRIPE_CHECKOUT_ALLOW_PROMOTION_CODES=true).
                ...(promoContext === 'promo-codes' ? { allow_promotion_codes: true } : {}),
                payment_method_collection: 'always',
                locale: 'fr',
                customer_update: { address: 'auto' },
                // CDC §4.2 / LK-41 : AUCUNE période d'essai Stripe. L'essai de
                // 7 jours est géré entièrement dans Verebona, avant toute
                // souscription.
                subscription_data: { metadata },
            }, { idempotencyKey: op.idempotencyKey });
        } catch (error) {
            // Résultat incertain (réponse perdue) : la tentative garde sa clé ;
            // la prochaine demande rejoue la même et retrouve la session (TC-31).
            await markOperation(op.id, isUncertain(error) ? 'uncertain' : 'failed', { error: (error as Error).message?.slice(0, 300) });
            throw error;
        }
        await markOperation(op.id, 'created', { stripeReference: checkoutSession.id });

        if (resolvedReferral) {
            await db.insert(referralEvents).values({
                referralLinkId: resolvedReferral.linkId,
                referrerAccountId: resolvedReferral.referrerAccountId,
                referredAccountId: account.id,
                referredUserId: user.id,
                status: 'link_used',
                rewardCredits: 10,
                metadataJson: { checkoutSessionId: checkoutSession.id, referralCode: referralCode ?? '' },
                createdAt: new Date(),
                updatedAt: new Date(),
            }).onConflictDoNothing();
        }

        await db
            .update(accounts)
            .set({
                checkoutSessionId: checkoutSession.id,
                checkoutSessionCreatedAt: new Date(),
                // Suivi du paiement en attente (APP-PERF-18) : première
                // vérification de rattrapage après le délai laissé au webhook
                // et à la page de retour.
                checkoutCheckAttempts: 0,
                checkoutNextCheckAt: new Date(Date.now() + PENDING_CHECKOUT_FIRST_CHECK_DELAY_MS),
                updatedAt: new Date(),
            })
            .where(eq(accounts.id, account.id));

        // Seul le client Stripe est rattaché ; aucun état d'abonnement avant paiement.
        await db
            .update(accountSubscriptions)
            .set({ stripeCustomerId: customerId, updatedAt: new Date() })
            .where(eq(accountSubscriptions.accountId, account.id));

        return NextResponse.json({ checkout_url: checkoutSession.url, offer: toPublicOffer(resolved) });

    } catch (error) {
        if (error instanceof BillingCatalogError) return catalogError(error);
        console.error('[Checkout Session Error]', error);

        if (error instanceof Error && ['AUTH_REQUIRED', 'INVALID_TOKEN', 'ACCOUNT_SUSPENDED'].includes(error.message)) {
            return SessionService.handleSessionError(error);
        }

        // Le message brut de Stripe (identifiants, mode test/live…) reste dans
        // les logs : il n'a pas à s'afficher dans le toast de l'utilisateur.
        if (error instanceof StripeConfigError) {
            return catalogError(new BillingCatalogError('STRIPE_UNAVAILABLE'));
        }
        if (isUncertain(error)) {
            return NextResponse.json(
                { code: 'PAYMENT_VERIFICATION_IN_PROGRESS', message: 'Vérification en cours. Merci de réessayer dans quelques instants : aucune double souscription ne sera créée.' },
                { status: 503 }
            );
        }
        return NextResponse.json(
            { code: 'CHECKOUT_SESSION_FAILED', message: 'Impossible de démarrer le paiement. Merci de réessayer dans quelques instants.' },
            { status: 500 }
        );
    }
}

function catalogError(error: BillingCatalogError): NextResponse {
    return NextResponse.json(error.toBody(), { status: error.httpStatus });
}

function isUncertain(error: unknown): boolean {
    const e = error as { type?: string; statusCode?: number };
    return e?.type === 'StripeConnectionError' || (typeof e?.statusCode === 'number' && e.statusCode >= 500);
}

/**
 * Session ouverte réutilisable ? (LK-42) — le PRIX RÉEL est relu dans les
 * lignes de la session : l'offre et la périodicité ne suffisent pas. Une
 * session à un autre prix (ancienne révision, TC-32) est expirée.
 */
async function reusableSession(
    stripe: Stripe,
    sessionId: string,
    expect: { customerId: string; accountId: number; price: ResolvedPrice },
): Promise<{ url: string | null; completed: boolean }> {
    try {
        const s = await stripe.checkout.sessions.retrieve(sessionId);
        if (s.status === 'complete') return { url: null, completed: true };
        if (s.status !== 'open') return { url: null, completed: false };
        const lines = await stripe.checkout.sessions.listLineItems(sessionId, { limit: 5 });
        const priceIds = lines.data.map((l) => l.price?.id);
        const ok = s.customer === expect.customerId
            && s.metadata?.accountId === String(expect.accountId)
            && s.metadata?.price_revision === expect.price.priceRevision
            && priceIds.length === 1 && priceIds[0] === expect.price.priceId
            && (lines.data[0]?.quantity ?? 1) === 1;
        if (ok) return { url: s.url, completed: false };
        await stripe.checkout.sessions.expire(sessionId).catch(() => undefined);
        return { url: null, completed: false };
    } catch (e) {
        console.warn('[Checkout] session existante illisible :', (e as Error).message);
        return { url: null, completed: false };
    }
}

/** Expire une session ouverte remplacée (LK-44). Rend son état final. */
async function expireReplacedSession(stripe: Stripe, sessionId: string): Promise<'expired' | 'completed' | 'unknown'> {
    try {
        const s = await stripe.checkout.sessions.retrieve(sessionId);
        if (s.status === 'complete') return 'completed';
        if (s.status === 'open') await stripe.checkout.sessions.expire(sessionId);
        return 'expired';
    } catch (e) {
        console.warn('[Checkout] expiration de la session remplacée :', (e as Error).message);
        return 'unknown';
    }
}

function verificationInProgress(): NextResponse {
    return NextResponse.json(
        { code: 'PAYMENT_VERIFICATION_IN_PROGRESS', message: 'Votre paiement est en cours de vérification. Votre offre sera mise à jour dans quelques instants.' },
        { status: 409 },
    );
}

/** Compte Duo inactif rattaché au titulaire (activé par la synchronisation du paiement). */
async function ensureInactiveDuo(userId: number, accountId: number, customerId: string): Promise<number> {
    const { duoAccounts, duoMemberships } = await import('@/db/schema');
    const [existingDuo] = await db.select({ id: duoAccounts.id }).from(duoAccounts).where(eq(duoAccounts.billingOwnerUserId, userId)).limit(1);
    let duoId = existingDuo?.id ?? null;
    if (!duoId) {
        const now = new Date();
        const [newDuo] = await db.insert(duoAccounts).values({
            billingOwnerUserId: userId,
            subscriptionStatus: 'CANCELED', // activé par le webhook
            stripeCustomerId: customerId,
            createdAt: now,
            updatedAt: now,
        }).returning();
        duoId = newDuo.id;
        await db.insert(duoMemberships).values({
            duoId, userId, status: 'ACTIVE', slot: 0, invitedAt: now, joinedAt: now, createdAt: now, updatedAt: now,
        });
    }
    await db.update(accounts).set({ duoAccountId: duoId, updatedAt: new Date() }).where(and(eq(accounts.id, accountId)));
    return duoId;
}
