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
 * Ce seed crée donc un compte isolé, MARQUÉ comme compte technique en base
 * (lot 103G, `accounts.technical_kind`), et affiche son identifiant
 * (`CORPUS_ACCOUNT_ID` : confirmation facultative).
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
import { getMigrationFailures } from '@/db';
import { CORPUS_ACCOUNT_NAME, CORPUS_EMAIL, provisionCorpusAccount } from '@/services/ai/qualification/technical-account';

// Lot 103G : un seul mécanisme de provisionnement (`technical-account.ts`), partagé avec la route
// `corpus-account`, l'action du BO et l'auto-provisionnement de préproduction. Le compte est MARQUÉ en base
// (`accounts.technical_kind`) : `CORPUS_ACCOUNT_ID` devient une simple confirmation facultative.
export { CORPUS_ACCOUNT_NAME, CORPUS_EMAIL };

export interface CorpusAccountResult {
  status: 'created' | 'already_present';
  accountId: number;
  userId: number;
}

export async function seedCorpusAccount(): Promise<CorpusAccountResult> {
  const r = await provisionCorpusAccount({ actor: 'seed' });
  const failures = getMigrationFailures();
  if (failures.length > 0) {
    throw new Error(`Migrations en échec, schéma incomplet : ${failures.map((f) => f.filename).join(', ')}.`);
  }
  if (r.status === 'refused' || r.accountId == null || r.userId == null) throw new Error(r.message);
  return { status: r.status === 'created' ? 'created' : 'already_present', accountId: r.accountId, userId: r.userId };
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
      console.log('  Facultatif (le compte est reconnu par son marqueur en base) — confirmation dans .env.local :\n');
      console.log(`      CORPUS_ACCOUNT_ID=${r.accountId}\n`);
      console.log('  Puis : BO › Configuration IA › Qualification par couple (« Tester ce couple »).\n');
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
