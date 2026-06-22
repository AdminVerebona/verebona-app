import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { users, accounts, accountMemberships, referralLinks, referralEvents, accountSubscriptions } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getStripeServer, STRIPE_PRODUCTS } from '@/lib/stripe';
import Stripe from 'stripe';
import { mapLegacyPlanTypeToCommercialCode } from '@/services/commercial-model.service';

/**
 * POST /api/billing/create-checkout-session
 * Crée une session Stripe Checkout pour souscrire à un plan (Premium, Premium Duo, Pro)
 *
 * Body: { plan?: 'standard' | 'premium' | 'premium_duo' | 'duo', referralCode?: string }
 */
export async function POST(request: NextRequest) {
    try {
        const session = await SessionService.getSession(request);
        const origin = new URL(request.url).origin;
    
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
        const referralCode = typeof body.referralCode === 'string' ? body.referralCode.trim() : '';
        const entryPoint = body.entry_point || 'app_subscription_page';
        const product = STRIPE_PRODUCTS[normalizedRequestedPlan as keyof typeof STRIPE_PRODUCTS] || STRIPE_PRODUCTS.PREMIUM;

        // Si requestedPlan est présent et différent de account.planType, renvoyer PLAN_MISMATCH
        // Utiliser la valeur déjà normalisée (body.plan peut contenir alias 'duo')
        const normalizedBodyPlan = body.plan ? (body.plan.toUpperCase() === 'DUO' ? 'PREMIUM_DUO' : body.plan.toUpperCase()) : null;
        const normalizedAccountPlanForCheck = (account.planType || '').toUpperCase();
        if (normalizedBodyPlan && normalizedAccountPlanForCheck && normalizedBodyPlan !== normalizedAccountPlanForCheck) {
            // Legitimate for first-time paid subscription: accounts start as STANDARD (non-paid),
            // requesting PREMIUM / PREMIUM_DUO etc. is the normal upgrade flow from signup/offers.
            const currentStatusUpper = (account.subscriptionStatus || 'NONE').toUpperCase();
            const isInitialNonPaidState = normalizedAccountPlanForCheck === 'STANDARD' && ['NONE', 'PENDING'].includes(currentStatusUpper);
            if (!isInitialNonPaidState) {
                return NextResponse.json(
                    {
                        code: 'PLAN_MISMATCH',
                        message: 'Le plan demandé ne correspond pas au plan configuré pour votre compte.',
                    },
                    { status: 400 }
                );
            }
        }

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

        if (!product.priceId) {
            return NextResponse.json(
                {
                    code: 'STRIPE_NOT_CONFIGURED',
                    message: `Stripe Price ID not configured for plan ${requestedPlan}.`,
                },
                { status: 500 }
            );
        }

        const stripe = getStripeServer();

        // Vérification de session Stripe existante
        if (account.checkoutSessionId && account.checkoutSessionCreatedAt) {
            const now = new Date();
            const sessionAgeMinutes = (now.getTime() - new Date(account.checkoutSessionCreatedAt).getTime()) / (1000 * 60);

            if (sessionAgeMinutes < 15) {
                try {
                    const existingStripeSession = await stripe.checkout.sessions.retrieve(account.checkoutSessionId);
                    if (
                        existingStripeSession &&
                        existingStripeSession.status === 'open' &&
                        existingStripeSession.customer === account.stripeCustomerId &&
                        existingStripeSession.metadata?.accountId === account.id.toString() &&
                        existingStripeSession.metadata?.planTier === product.tier
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

        // ── Vérifier si ce compte est éligible au trial ──────────────────────
        // Le trial de 2 mois (ou 3 avec parrainage) est accordé à l'inscription pour le premier
        // abonnement payant, quel que soit le plan (standard/premium/premium_duo), tant qu'il n'y a
        // jamais eu de souscription Stripe réelle ni de facturation effective (firstBilledAt).
        const [existingSubscription] = await db
            .select({ trialStartedAt: accountSubscriptions.trialStartedAt, firstBilledAt: accountSubscriptions.firstBilledAt })
            .from(accountSubscriptions)
            .where(eq(accountSubscriptions.accountId, account.id))
            .limit(1);

        // Créer ou récupérer le Customer Stripe (pour que le check Stripe utilise toujours l'ID effectif)
        let customerId = account.stripeCustomerId;

        if (!customerId) {
            const customer = await stripe.customers.create({
                email: user.email,
                name: `${user.firstName} ${user.lastName}`,
                metadata: {
                    userId: user.id.toString(),
                    accountId: account.id.toString(),
                },
            });

            customerId = customer.id;

            await db
                .update(accounts)
                .set({ stripeCustomerId: customerId })
                .where(eq(accounts.id, account.id));
        }

        // Vérifier côté Stripe (customer effectif, incluant tentatives abandonnées sans sub) si déjà eu des subscriptions (toutes statuts)
        let stripeHadSubscription = false;
        if (customerId) {
            const stripeSubs = await stripe.subscriptions.list({
                customer: customerId,
                status: 'all',
                limit: 1,
            });
            stripeHadSubscription = stripeSubs.data.length > 0;
        }

        // Éligibilité au trial à l'inscription :
        // - jamais eu de sub côté Stripe (même incomplete/canceled)
        // - jamais eu de première facturation réelle (firstBilledAt)
        // On ignore trialStartedAt s'il provient d'un simple "intent" de checkout abandonné (pas de sub réel).
        // Cela garantit les 2 mois d'essai gratuits pour tout nouveau signup, quel que soit le plan choisi.
        let isTrialEligible =
            !stripeHadSubscription &&
            !existingSubscription?.firstBilledAt;

        // Renforcement explicite pour les premiers checkouts "inscription/onboarding" :
        // même si un marqueur trialStartedAt existe localement (d'un précédent create sans complétion Stripe),
        // tant qu'il n'y a aucune subscription Stripe historique et aucune facturation, on accorde le trial.
        if (!isTrialEligible && existingSubscription?.trialStartedAt && !stripeHadSubscription && !existingSubscription?.firstBilledAt) {
            const acctStatus = (account.subscriptionStatus || 'NONE').toUpperCase();
            const neverHadRealSubOnAccount = !account.stripeSubscriptionId && (acctStatus === 'NONE' || acctStatus === 'PENDING');
            if (neverHadRealSubOnAccount) {
                isTrialEligible = true;
            }
        }

        // Résoudre éventuellement un code de parrainage valide (3 mois offerts)
        let resolvedReferral: { linkId: number; referrerAccountId: number } | null = null;
        if (referralCode.length > 0) {
            const [link] = await db
                .select({ id: referralLinks.id, accountId: referralLinks.accountId, isActive: referralLinks.isActive })
                .from(referralLinks)
                .where(eq(referralLinks.code, referralCode))
                .limit(1);

            if (link?.isActive && link.accountId !== account.id) {
                resolvedReferral = { linkId: link.id, referrerAccountId: link.accountId };
            }
        }

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
            account.stripeSubscriptionId
        ) {
            const existingSub = await stripe.subscriptions.retrieve(account.stripeSubscriptionId);
            const existingItem = existingSub.items.data[0];

            if (!existingItem) {
                return NextResponse.json(
                    { code: 'SUBSCRIPTION_ITEM_NOT_FOUND', message: 'Impossible de trouver l\'abonnement existant.' },
                    { status: 500 }
                );
            }

            const alreadyOnDuoPrice = existingItem.price.id === product.priceId;

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
                    await db.update(da).set({ stripeSubscriptionId: account.stripeSubscriptionId, subscriptionStatus: 'ACTIVE', updatedAt: new Date() }).where(eq(da.id, duoId));
                }
                return NextResponse.json({ checkout_url: `${origin}/accueil` });
            }

            // Mettre à jour la subscription avec le nouveau price DUO
            await stripe.subscriptions.update(account.stripeSubscriptionId, {
                items: [{ id: existingItem.id, price: product.priceId }],
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
                customer: customerId as string,
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
            return NextResponse.json({ checkout_url: `${origin}/accueil` });
        }

        // ── Nouvelle subscription ──
        const checkoutSession = await stripe.checkout.sessions.create({
            mode: 'subscription',
            customer: customerId,
            line_items: [
                {
                    price: product.priceId,
                    quantity: 1,
                },
            ],
            success_url: `${origin}/accueil?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${origin}/abonnement/cancel?plan=${normalizedRequestedPlan.toLowerCase()}`,
            metadata: {
                userId: user.id.toString(),
                accountId: account.id.toString(),
                duoId: duoId?.toString() || '',
                planTier: product.tier,
                entry_point: entryPoint,
                referralCode: resolvedReferral ? referralCode : '',
            },
            billing_address_collection: 'auto',
            payment_method_collection: 'always',
            locale: 'fr',
            customer_update: {
                address: 'auto',
            },
            subscription_data: {
                ...(isTrialEligible ? { trial_period_days: resolvedReferral ? 90 : 60 } : {}),
                metadata: {
                    userId: user.id.toString(),
                    accountId: account.id.toString(),
                    duoId: duoId?.toString() || '',
                    planTier: product.tier,
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
                metadataJson: { checkoutSessionId: checkoutSession.id, referralCode },
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

        const checkoutPlanCode = mapLegacyPlanTypeToCommercialCode(normalizedRequestedPlan);

        // Note: on enregistre l'intention de checkout/trial ici (pour le suivi et les quotas optimistes),
        // mais on n'écrit PAS trialStartedAt/trialEndsAt tant que la subscription Stripe n'est pas réellement créée (webhook).
        // Cela évite de "consommer" le droit au trial sur simple clic si l'utilisateur abandonne le formulaire Stripe.
        const subStatus = isTrialEligible ? 'trialing' : 'active';

        await db.insert(accountSubscriptions).values({
            accountId: account.id,
            planCode: checkoutPlanCode,
            status: subStatus,
            stripeCustomerId: customerId || null,
            createdAt: new Date(),
            updatedAt: new Date(),
        }).onConflictDoUpdate({
            target: accountSubscriptions.accountId,
            set: {
                planCode: checkoutPlanCode,
                status: subStatus,
                stripeCustomerId: customerId || null,
                updatedAt: new Date(),
            },
        });

        return NextResponse.json({
            checkout_url: checkoutSession.url,
        });

    } catch (error) {
        console.error('[Checkout Session Error]', error);

        if (error instanceof Error && error.message.includes('AUTH_REQUIRED')) {
            return SessionService.handleSessionError(error);
        }

        const stripeError = error as Stripe.StripeRawError;
        const message = stripeError?.message || (error instanceof Error ? error.message : 'Failed to create checkout session');

        return NextResponse.json(
            {
                code: 'CHECKOUT_SESSION_FAILED',
                message,
            },
            { status: 500 }
        );
    }
}
