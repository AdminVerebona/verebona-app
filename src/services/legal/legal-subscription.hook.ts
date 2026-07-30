/**
 * Acceptation et confirmation lors d'une souscription payante — CDC 7 §8.2,
 * §10.1 et scénarios R02, R03, R08.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI UNE ACCEPTATION EST ENREGISTRÉE MÊME SI L'UTILISATEUR N'A RIEN
 * RECOCHÉ
 *
 * Le §8.2 dit deux choses qui semblent se contredire :
 *
 *   « demander une nouvelle acceptation uniquement si l'utilisateur n'a jamais
 *     accepté cette version » ;
 *   « la souscription est néanmoins enregistrée avec la version applicable ».
 *
 * Elles portent en fait sur deux objets distincts. La première concerne
 * l'INTERFACE — ne pas faire recocher une case identique, ce qui n'ajoute
 * rien à la preuve et alourdit le parcours (R02). La seconde concerne la
 * TRACE — savoir, plus tard, quelle version des conditions régissait ce
 * contrat précis.
 *
 * D'où une ligne `legal_acceptances` de contexte `PAID_SUBSCRIPTION`, portant
 * l'identifiant de la souscription, distincte de celle enregistrée à
 * l'inscription. L'index d'unicité les sépare par le contexte : les deux
 * coexistent sans se supplanter.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * NE LÈVE JAMAIS. Appelée depuis un webhook Stripe : une exception ferait
 * répondre le webhook en erreur, Stripe le rejouerait, et les effets de bord
 * sur l'abonnement seraient appliqués deux fois.
 */
import { db } from '@/db';
import { accounts, accountSubscriptions, users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getCurrentVersion } from './legal-versions.service';
import { recordAcceptance } from './legal-acceptances.service';
import { sendLegalConfirmationEmail } from './legal-confirmation.service';

export interface PaidSubscriptionAcceptanceInput {
  accountId: number;
  stripeSubscriptionId: string;
}

export interface HookResult {
  status: 'recorded' | 'skipped';
  reason?: string;
  versionCode?: string;
  emailSent?: boolean;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Libellés d'offre lisibles, pour l'email (§10.2). */
const OFFER_LABELS: Record<string, string> = {
  standard: 'Verebona Standard',
  premium: 'Verebona Premium',
  premium_duo: 'Verebona Premium Duo',
  premium_pro: 'Verebona Premium Pro',
};

export async function recordPaidSubscriptionAcceptance(
  input: PaidSubscriptionAcceptanceInput,
): Promise<HookResult> {
  try {
    const version = await getCurrentVersion();
    if (!version) {
      // Sans version publiée, rien à rattacher. Le paiement reste valide : ce
      // n'est pas ici qu'on refuse une souscription déjà encaissée.
      console.error(
        `[legal] souscription ${input.stripeSubscriptionId} : aucune version de CGVU publiée, ` +
        'acceptation non enregistrée. À régulariser.',
      );
      return { status: 'skipped', reason: 'NO_CURRENT_VERSION' };
    }

    const [account] = await db
      .select({
        id: accounts.id,
        ownerUserId: accounts.ownerUserId,
        planType: accounts.planType,
      })
      .from(accounts)
      .where(eq(accounts.id, input.accountId))
      .limit(1);

    if (!account?.ownerUserId) {
      return { status: 'skipped', reason: 'NO_OWNER' };
    }

    const [owner] = await db
      .select({ id: users.id, email: users.email, firstName: users.firstName })
      .from(users)
      .where(eq(users.id, account.ownerUserId))
      .limit(1);

    if (!owner) return { status: 'skipped', reason: 'OWNER_NOT_FOUND' };

    const [subscription] = await db
      .select({
        id: accountSubscriptions.id,
        planCode: accountSubscriptions.planCode,
        billingPeriod: accountSubscriptions.billingPeriod,
      })
      .from(accountSubscriptions)
      .where(eq(accountSubscriptions.accountId, account.id))
      .limit(1);

    const offerCode = subscription?.planCode ?? account.planType?.toLowerCase() ?? null;

    // Idempotent : un webhook rejoué ne crée pas de seconde preuve (§18).
    await recordAcceptance({
      userId: owner.id,
      versionCode: version.versionCode,
      context: 'PAID_SUBSCRIPTION',
      subscriptionId: subscription?.id ?? null,
      offerCode,
    });

    const now = new Date();
    const email = await sendLegalConfirmationEmail({
      to: owner.email,
      userId: owner.id,
      firstName: owner.firstName ?? '',
      versionCode: version.versionCode,
      permalink: version.permalink ?? `/cgvu/versions/${version.versionCode}`,
      subscription: {
        offerLabel: OFFER_LABELS[offerCode ?? ''] ?? 'Verebona',
        priceLabel:
          subscription?.billingPeriod === 'yearly'
            ? 'facturation annuelle'
            : 'facturation mensuelle',
        subscribedAtLabel: formatDate(now),
      },
    });

    return {
      status: 'recorded',
      versionCode: version.versionCode,
      emailSent: email.sent,
    };
  } catch (e) {
    // Le webhook doit répondre 200 quoi qu'il arrive côté légal.
    console.error(
      `[legal] rattachement de la souscription ${input.stripeSubscriptionId} impossible :`,
      (e as Error).message,
    );
    return { status: 'skipped', reason: 'ERROR' };
  }
}
