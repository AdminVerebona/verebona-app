/**
 * Compte technique de mesure du corpus — CDC §11.1.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI UN COMPTE DÉDIÉ
 *
 * Les appels modèles d'une campagne de recette sont facturés comme les
 * autres. Les rattacher à un compte client mélangerait ses coûts réels avec
 * ceux de la mesure — et fausserait précisément le chiffrage que le corpus
 * sert à produire avant une bascule.
 *
 * Ce seed crée donc un compte isolé et affiche son identifiant, à reporter
 * dans `CORPUS_ACCOUNT_ID`.
 *
 * ── CE COMPTE NE DOIT PAS ÊTRE UTILISABLE ─────────────────────────────────
 *
 * `is_active = false` sur l'utilisateur : personne ne peut s'y connecter.
 * `subscription_status = 'NONE'` : il ne compte pas comme client dans les
 * tableaux d'abonnement. Le mot de passe est un marqueur impossible à
 * satisfaire — aucun hachage bcrypt ne commence par `!`, donc aucune
 * comparaison ne peut réussir.
 * ══════════════════════════════════════════════════════════════════════════
 *
 *   npm run db:seed:corpus-account
 */
// ⚠️ EN PREMIER : `@/db` lit DATABASE_URL au chargement du module.
import '@/lib/load-env';
import { db, ensureMigrations, getMigrationFailures } from '@/db';
import { accounts, users } from '@/db/schema';
import { eq } from 'drizzle-orm';

/** Adresse du compte technique. Locale et non routable, jamais joignable. */
export const CORPUS_EMAIL = 'corpus@verebona.local';
export const CORPUS_ACCOUNT_NAME = 'Corpus de recette IA';

export interface CorpusAccountResult {
  status: 'created' | 'already_present';
  accountId: number;
  userId: number;
}

export async function seedCorpusAccount(): Promise<CorpusAccountResult> {
  await ensureMigrations();

  const failures = getMigrationFailures();
  if (failures.length > 0) {
    throw new Error(
      `Migrations en échec, schéma incomplet : ${failures.map((f) => f.filename).join(', ')}.`,
    );
  }

  const now = new Date();

  // Idempotent : relancé, il retourne le compte existant plutôt que d'en
  // créer un second. Deux comptes de mesure disperseraient les coûts et
  // rendraient la comparaison entre campagnes impossible.
  const [existingUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, CORPUS_EMAIL))
    .limit(1);

  if (existingUser) {
    const [existingAccount] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.ownerUserId, existingUser.id))
      .limit(1);

    if (existingAccount) {
      return {
        status: 'already_present',
        accountId: existingAccount.id,
        userId: existingUser.id,
      };
    }
  }

  const userId = existingUser?.id ?? (
    await db
      .insert(users)
      .values({
        email: CORPUS_EMAIL,
        // Marqueur impossible à satisfaire : aucun hachage bcrypt ne commence
        // par `!`, donc aucune comparaison de mot de passe ne peut réussir.
        passwordHash: '!corpus-no-login',
        firstName: 'Corpus',
        lastName: 'Recette',
        isActive: false,
        role: 'USER',
        planType: 'PREMIUM',
        acceptedTermsAt: now,
        termsVersion: 'n/a',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: users.id })
  )[0].id;

  const [account] = await db
    .insert(accounts)
    .values({
      name: CORPUS_ACCOUNT_NAME,
      ownerUserId: userId,
      // Premium : la mesure doit s'exécuter sans buter sur un quota d'offre
      // inférieure, sinon elle mesurerait la limite et non le moteur.
      planType: 'PREMIUM',
      // `NONE` : aucun abonnement, donc aucune place dans les statistiques
      // commerciales ni dans les rapprochements Stripe.
      subscriptionStatus: 'NONE',
      isActive: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: accounts.id });

  return { status: 'created', accountId: account.id, userId };
}

if (process.argv[1]?.includes('seed-corpus-account')) {
  seedCorpusAccount()
    .then((r) => {
      console.log(
        r.status === 'created'
          ? `\n[corpus] Compte technique créé.`
          : `\n[corpus] Compte technique déjà présent.`,
      );
      console.log(`[corpus] Utilisateur : ${r.userId} (${CORPUS_EMAIL}, connexion impossible)`);
      console.log(`[corpus] Compte      : ${r.accountId}\n`);
      console.log('  Reportez cette ligne dans .env.local :\n');
      console.log(`      CORPUS_ACCOUNT_ID=${r.accountId}\n`);
      console.log('  Puis : npm run corpus:run\n');
      process.exit(0);
    })
    .catch((e) => {
      const cause = (e as { cause?: { message?: string; code?: string } }).cause;
      console.error('[corpus] échec :', e.message);
      if (cause?.message) {
        console.error(`[corpus] cause  : ${cause.message}${cause.code ? ` (${cause.code})` : ''}`);
      }
      process.exit(1);
    });
}
