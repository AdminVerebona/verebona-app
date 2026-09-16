import { NextRequest, NextResponse } from 'next/server';
import {
    getStoredReferralCode,
    normalizeReferralCode,
    resolveReferralCode,
} from '@/services/referral-attribution.service';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { users, accounts, accountMemberships, referralEvents, accountSubscriptions } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getStripeServer, STRIPE_PRODUCTS, StripeConfigError } from '@/lib/stripe';
import { ensureStripeCustomer, isStripeResourceMissing } from '@/lib/stripe-customer';
import { resolvePriceId, isBillingPeriod, type BillingPeriod } from '@/lib/stripe-prices';
import Stripe from 'stripe';
import { getAppBaseUrl } from '@/lib/app-url';
import { trackFunnelEvent } from '@/services/funnel-analytics.service';

/**
 * POST /api/billing/create-checkout-session
 * Crée une session Stripe Checkout pour souscrire à un plan (Premium, Premium Duo, Pro)
 *
 * Body: { plan?: 'standard' | 'premium' | 'premium_duo' | 'duo', referralCode?: string }
 */
export async function POST(request: NextRequest) {
    try {
        const session = await SessionService.getSession(request);
        // URL publique de l'app : derrière le proxy, `request.url` pointe sur
        // le port interne du conteneur (localhost:xxxxx).
        const appUrl = getAppBaseUrl(request);
    
        // Récupérer l'utilisateur
        const [user] = await db
            .select({
                id: users.id,
                email: users.email,
                firstName: users.firstName,
                lastName: users.lastName,
            })
            .from(users)
            .where(eq(users.id, session.userId))
            .limit(1);
    
        if (!user) {
            return NextResponse.json(
                { code: 'USER_NOT_FOUND', message: 'User not found' },
                { status: 404 }
            );
        }

        // Récupérer le compte actif de l'utilisateur
        const [membership] = await db
            .select({
                accountId: accountMemberships.accountId,
                role: accountMemberships.role,
            })
            .from(accountMemberships)
            .where(eq(accountMemberships.userId, user.id))
            .limit(1);

        if (!membership) {
            return NextResponse.json(
                { code: 'NO_ACCOUNT', message: 'User has no account' },
                { status: 404 }
            );
        }

        // Récupérer le compte
        const [account] = await db
            .select({
                id: accounts.id,
                planType: accounts.planType,
                stripeCustomerId: accounts.stripeCustomerId,
                stripeSubscriptionId: accounts.stripeSubscriptionId,
                subscriptionStatus: accounts.subscriptionStatus,
                checkoutSessionId: accounts.checkoutSessionId,
                checkoutSessionCreatedAt: accounts.checkoutSessionCreatedAt,
            })
            .from(accounts)
            .where(eq(accounts.id, membership.accountId))
            .limit(1);

        if (!account) {
            return NextResponse.json(
                { code: 'ACCOUNT_NOT_FOUND', message: 'Account not found' },
                { status: 404 }
            );
        }

        // Récupérer le plan demandé
        const body = await request.json().catch(() => ({}));
        let requestedPlan = body.plan ? body.plan.toUpperCase() : null;

        // Normalisation alias legacy 'DUO' -> 'PREMIUM_DUO'
        if (requestedPlan === 'DUO') {
            requestedPlan = 'PREMIUM_DUO';
        }

        // Si requestedPlan est absent, utiliser account.planType
        if (!requestedPlan) {
            requestedPlan = account.planType ? account.planType.toUpperCase() : 'PREMIUM';
        }

        const normalizedRequestedPlan = requestedPlan;
        const referralCodeFromBody = normalizeReferralCode(body.referralCode);
        const entryPoint = body.entry_point || 'app_subscription_page';
        const product = STRIPE_PRODUCTS[normalizedRequestedPlan as keyof typeof STRIPE_PRODUCTS] || STRIPE_PRODUCTS.PREMIUM;

        // ── Tarification V2 (CDC) : le client choisit une offre ET une periodicite.
        // Le Price ID n'est JAMAIS transmis par le frontend : il est resolu ici
        // depuis une table serveur (CDC §5.6 / §16).
        const billingPeriod: BillingPeriod = isBillingPeriod(body.billing_period)
            ? body.billing_period
            : 'yearly'; // defaut retrocompatible avec l'ancien modele annuel

        let resolvedPriceId: string;
        try {
            resolvedPriceId = resolvePriceId(product.tier, billingPeriod);
        } catch (priceError) {
            console.error('[checkout] resolution du prix impossible:', priceError);
            return NextResponse.json(
                { error: 'Offre indisponible', code: 'PRICE_NOT_CONFIGURED', message: 'Cette offre est momentanément indisponible.' },
                { status: 400 },
            );
        }

        // ══════════════════════════════════════════════════════════════════
        // CONTRÔLE « PLAN_MISMATCH » RETIRÉ
        //
        // Il refusait toute offre différente de `accounts.planType`, sauf pour
        // un compte STANDARD. Or `planType` est l'offre choisie À
        // L'INSCRIPTION : un compte ouvert en essai Premium ne pouvait plus
        // choisir Standard, ni un compte Standard en essai prendre Premium Duo
        // — « Le plan demandé ne correspond pas au plan configuré pour votre
        // compte ».
        //
        // Sans abonnement payant en cours, l'utilisateur choisit librement son
        // offre. Avec un abonnement actif, le contrôle ci-dessous renvoie déjà
        // vers la modification d'abonnement (`SUBSCRIPTION_CHANGE_REQUIRED`).
        // ══════════════════════════════════════════════════════════════════

        // Renforcer la règle d'éligibilité : si subscriptionStatus est ACTIVE, TRIALING, ou PAST_DUE_GRACE, interdire la souscription.
        const normalizedAccountPlan = account.planType?.toUpperCase();
        const activeStatuses = ['ACTIVE', 'TRIALING', 'PAST_DUE_GRACE'];
        const currentStatus = account.subscriptionStatus?.toUpperCase() || 'NONE';

        if (activeStatuses.includes(currentStatus)) {
            if (normalizedAccountPlan === normalizedRequestedPlan) {
                return NextResponse.json(
                    {
                        code: 'SUBSCRIPTION_ALREADY_ACTIVE',
                        message: 'Vous disposez déjà d\'un abonnement actif pour ce plan.',
                    },
                    { status: 400 }
                );
            } else {
                return NextResponse.json(
                    {
                        code: 'SUBSCRIPTION_CHANGE_REQUIRED',
                        message: 'Un abonnement actif existe déjà pour un plan différent. Veuillez d\'abord modifier ou résilier votre abonnement actuel.',
                    },
                    { status: 400 }
                );
            }
        }

        // ══════════════════════════════════════════════════════════════════
        // CONTRÔLE MORT RETIRÉ
        //
        // Ce bloc testait `product.priceId`, qui lit `STRIPE_PRICE_STANDARD` —
        // l'ancienne variable du modèle à périodicité unique. La tarification
        // V2 résout le prix vingt lignes plus haut, par couple offre/période :
        //
        //     resolvedPriceId = resolvePriceId(product.tier, billingPeriod);
        //
        // C'est `resolvedPriceId` qui alimente la session Stripe (l. 361, 405).
        // `product.priceId` n'était plus lu nulle part dans ce fichier.
        //
        // Le contrôle rejetait donc une requête dont le prix était correctement
        // résolu — « Stripe Price ID not configured for plan STANDARD » alors
        // que STRIPE_PRICE_STANDARD_YEARLY était bien renseignée.
        //
        // Le 500 était trompeur par-dessus le marché : rien n'avait planté.
        // `resolvePriceId` lève déjà si le prix manque, et cet échec est traité
        // en 400 `PRICE_NOT_CONFIGURED` juste au-dessus.
        // ══════════════════════════════════════════════════════════════════

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
        // Si le client a été remplacé, l'abonnement et la session stockés
        // appartiennent à l'ancien mode : on ne doit plus s'y référer.
        const customerReplaced = ensured.replacedCustomerId !== null;
        const currentSubscriptionId = customerReplaced ? null : account.stripeSubscriptionId;
        const currentCheckoutSessionId = customerReplaced ? null : account.checkoutSessionId;

        // Vérification de session Stripe existante
        if (currentCheckoutSessionId && account.checkoutSessionCreatedAt) {
            const now = new Date();
            const sessionAgeMinutes = (now.getTime() - new Date(account.checkoutSessionCreatedAt).getTime()) / (1000 * 60);

            if (sessionAgeMinutes < 15) {
                try {
                    const existingStripeSession = await stripe.checkout.sessions.retrieve(currentCheckoutSessionId);
                    if (
                        existingStripeSession &&
                        existingStripeSession.status === 'open' &&
                        existingStripeSession.customer === customerId &&
                        existingStripeSession.metadata?.accountId === account.id.toString() &&
                        existingStripeSession.metadata?.planTier === product.tier &&
                        // La session réutilisée doit porter la périodicité demandée
                        existingStripeSession.metadata?.billing_period === billingPeriod
                    ) {
                        return NextResponse.json({
                            checkout_url: existingStripeSession.url,
                        });
                    }
                } catch (e) {
                    console.warn('[Checkout] Failed to retrieve existing session:', e);
                }
            }
        }

        // ── Parrainage ────────────────────────────────────────────────────
        //
        // Le code presente ici est rarement dans la requete : le filleul
        // souscrit plusieurs jours apres son inscription, apres une
        // verification d'email et un essai de sept jours. Le code retenu a
        // l'inscription (CDC parrainage §4.5) prend donc le relais.
        //
        // Un code explicitement transmis reste prioritaire : il traduit une
        // action volontaire au moment de souscrire.
        const referralCode =
            referralCodeFromBody ?? (await getStoredReferralCode(user.id));

        const resolvedReferral = referralCode
            ? await resolveReferralCode(referralCode, account.id)
            : null;

        // Préparer le duo_account si nécessaire
        let duoId: number | null = null;
        if (normalizedRequestedPlan === 'PREMIUM_DUO') {
            const { duoAccounts, duoMemberships } = await import('@/db/schema');
            const [existingDuo] = await db
                .select()
                .from(duoAccounts)
                .where(eq(duoAccounts.billingOwnerUserId, user.id))
                .limit(1);

            if (existingDuo) {
                duoId = existingDuo.id;
            } else {
                const [newDuo] = await db.insert(duoAccounts).values({
                    billingOwnerUserId: user.id,
                    subscriptionStatus: 'CANCELED', // activé par le webhook
                    stripeCustomerId: customerId,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                }).returning();

                duoId = newDuo.id;

                await db.insert(duoMemberships).values({
                    duoId: newDuo.id,
                    userId: user.id,
                    status: 'ACTIVE',
                    slot: 0,
                    invitedAt: new Date(),
                    joinedAt: new Date(),
                    createdAt: new Date(),
                    updatedAt: new Date(),
                });
            }

            await db
                .update(accounts)
                .set({ duoAccountId: duoId, updatedAt: new Date() })
                .where(eq(accounts.id, account.id));
        }

        // ── Upgrade PREMIUM → PREMIUM_DUO : mettre à jour la subscription existante avec prorata ──
        if (
            normalizedRequestedPlan === 'PREMIUM_DUO' &&
            (account.planType?.toUpperCase() === 'PREMIUM' || account.planType?.toUpperCase() === 'STANDARD') &&
            currentSubscriptionId
        ) {
            const existingSub = await stripe.subscriptions.retrieve(currentSubscriptionId);
            const existingItem = existingSub.items.data[0];

            if (!existingItem) {
                return NextResponse.json(
                    { code: 'SUBSCRIPTION_ITEM_NOT_FOUND', message: 'Impossible de trouver l\'abonnement existant.' },
                    { status: 500 }
                );
            }

            const alreadyOnDuoPrice = existingItem.price.id === resolvedPriceId;

            if (alreadyOnDuoPrice) {
                // Stripe est déjà sur PREMIUM_DUO — synchroniser la DB et rediriger vers succès
                await db.update(accounts).set({
                    planType: 'PREMIUM_DUO',
                    subscriptionTier: 'pro',
                    subscriptionStatus: 'ACTIVE',
                    maxMembers: 2,
                    updatedAt: new Date(),
                }).where(eq(accounts.id, account.id));
                await db.update(users).set({ planType: 'PREMIUM_DUO', updatedAt: new Date() }).where(eq(users.id, user.id));
                const { duoAccounts: da } = await import('@/db/schema');
                if (duoId) {
                    await db.update(da).set({ stripeSubscriptionId: currentSubscriptionId, subscriptionStatus: 'ACTIVE', updatedAt: new Date() }).where(eq(da.id, duoId));
                }
                return NextResponse.json({ checkout_url: `${appUrl}/accueil` });
            }

            // Mettre à jour la subscription avec le nouveau price DUO
            await stripe.subscriptions.update(currentSubscriptionId, {
                items: [{ id: existingItem.id, price: resolvedPriceId }],
                proration_behavior: 'create_prorations',
                metadata: {
                    userId: user.id.toString(),
                    accountId: account.id.toString(),
                    duoId: duoId?.toString() || '',
                    planTier: 'premium_duo',
                    entry_point: entryPoint,
                },
            });

            // Récupérer la facture draft de prorata
            const pendingInvoices = await stripe.invoices.list({
                customer: customerId,
                status: 'draft',
                limit: 1,
            });

            const pendingInvoice = pendingInvoices.data[0];

            if (pendingInvoice && (pendingInvoice.amount_due ?? 0) > 0) {
                const finalized = await (stripe.invoices as any).finalizeInvoice(pendingInvoice.id);
                if (finalized.hosted_invoice_url) {
                    return NextResponse.json({ checkout_url: finalized.hosted_invoice_url });
                }
            }

            // Prorata nul → succès direct
            return NextResponse.json({ checkout_url: `${appUrl}/accueil` });
        }

        // ── Nouvelle subscription ──
        void trackFunnelEvent({
            event: 'checkout_opened',
            accountId: account.id,
            planCode: product.tier,
            billingPeriod,
        });

        const checkoutSession = await stripe.checkout.sessions.create({
            mode: 'subscription',
            customer: customerId,
            line_items: [
                {
                    price: resolvedPriceId,
                    quantity: 1,
                },
            ],
            success_url: `${appUrl}/accueil?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${appUrl}/abonnement/cancel?plan=${normalizedRequestedPlan.toLowerCase()}`,
            metadata: {
                userId: user.id.toString(),
                accountId: account.id.toString(),
                duoId: duoId?.toString() || '',
                planTier: product.tier,
                billing_period: billingPeriod,
                environment: process.env.NEXT_PUBLIC_APP_ENV || 'unknown',
                entry_point: entryPoint,
                referralCode: resolvedReferral ? (referralCode ?? '') : '',
            },
            billing_address_collection: 'auto',
            payment_method_collection: 'always',
            locale: 'fr',
            customer_update: {
                address: 'auto',
            },
            subscription_data: {
                // CDC §4.2 : AUCUNE periode d'essai Stripe. L'essai de 7 jours est
                // gere entierement dans Verebona, avant toute souscription.
                metadata: {
                    userId: user.id.toString(),
                    accountId: account.id.toString(),
                    duoId: duoId?.toString() || '',
                    planTier: product.tier,
                    billing_period: billingPeriod,
                    environment: process.env.NEXT_PUBLIC_APP_ENV || 'unknown',
                },
            },
        });

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
                updatedAt: new Date(),
            })
            .where(eq(accounts.id, account.id));

        // ══════════════════════════════════════════════════════════════════
        // ⚠️ AUCUN ÉTAT D'ABONNEMENT N'EST ÉCRIT AVANT LE PAIEMENT
        //
        // Ce bloc passait `account_subscriptions` en `active` (ou `trialing`)
        // avec l'offre choisie, dès le clic. `entitlements.service` lisant
        // cette ligne, abandonner le formulaire Stripe suffisait à obtenir
        // l'offre — et un client réellement abonné pouvait voir son état
        // écrasé par un simple clic sur une autre carte.
        //
        // L'état est désormais écrit uniquement par la synchronisation
        // Stripe (webhook ou retour de paiement). On ne rattache ici que le
        // client Stripe, sur la ligne existante.
        // ══════════════════════════════════════════════════════════════════
        await db
            .update(accountSubscriptions)
            .set({ stripeCustomerId: customerId, updatedAt: new Date() })
            .where(eq(accountSubscriptions.accountId, account.id));

        return NextResponse.json({
            checkout_url: checkoutSession.url,
        });

    } catch (error) {
        console.error('[Checkout Session Error]', error);

        if (error instanceof Error && error.message.includes('AUTH_REQUIRED')) {
            return SessionService.handleSessionError(error);
        }

        // Le message brut de Stripe (identifiants, mode test/live…) reste dans
        // les logs : il n'a pas à s'afficher dans le toast de l'utilisateur.
        if (error instanceof StripeConfigError) {
            return NextResponse.json(
                {
                    code: 'PAYMENT_UNAVAILABLE',
                    message: 'Le paiement est momentanément indisponible. Merci de réessayer plus tard.',
                },
                { status: 503 }
            );
        }

        const stripeError = error as Stripe.errors.StripeError;
        if (isStripeResourceMissing(stripeError) && stripeError.param?.includes('price')) {
            return NextResponse.json(
                {
                    code: 'PRICE_UNAVAILABLE',
                    message: 'Cette offre est momentanément indisponible. Merci de réessayer plus tard.',
                },
                { status: 503 }
            );
        }

        return NextResponse.json(
            {
                code: 'CHECKOUT_SESSION_FAILED',
                message: 'Impossible de démarrer le paiement. Merci de réessayer dans quelques instants.',
            },
            { status: 500 }
        );
    }
}
