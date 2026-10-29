/**
 * Libération d'une adresse retenue par un compte JAMAIS vérifié — partagée
 * par l'inscription e-mail + mot de passe (`POST /api/users`) et, lot 93,
 * par l'inscription Google / Apple (adresse attestée par le fournisseur).
 * Déplacée telle quelle depuis `app/api/users/route.ts`.
 */
import { db } from '@/db';
import { users, accountMemberships } from '@/db/schema';
import { and, eq } from 'drizzle-orm';

/**
 * Libère l'adresse email d'un compte jamais vérifié.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE N'EST PLUS UN SIMPLE DELETE
 *
 * L'inscription supprimait la ligne `users` restée non vérifiée pour le même
 * email. Une soixantaine de tables référencent `users.id` ; quatre d'entre
 * elles le font sans `ON DELETE`, et une trace laissée par une tentative
 * précédente suffit alors à faire échouer la suppression. L'inscription
 * renvoyait un 500 et devenait définitivement impossible avec cet email.
 *
 * La suppression est tentée d'abord, parce qu'elle laisse la base propre. Si
 * une contrainte la refuse, l'email est neutralisé : la ligne est conservée
 * mais son adresse devient inutilisable, ce qui libère l'index unique et
 * permet la nouvelle inscription.
 *
 * Neutraliser plutôt qu'échouer : un compte jamais vérifié ne porte aucune
 * donnée utilisateur à protéger, et un inscrit bloqué ne réessaie pas.
 * ══════════════════════════════════════════════════════════════════════════
 */
export async function releaseUnverifiedEmail(email: string): Promise<void> {
  const stale = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.email, email), eq(users.isActive, false)));

  if (stale.length === 0) return;

  // Lot 72D : une invitation à un compte partagé réservée à l'identité non
  // vérifiée (`user_id`) redevient une invitation par adresse — la
  // suppression de l'utilisateur l'effacerait en cascade.
  for (const row of stale) {
    await db
      .update(accountMemberships)
      .set({ userId: null, updatedAt: new Date() })
      .where(and(eq(accountMemberships.userId, row.id), eq(accountMemberships.status, 'pending')));
  }

  try {
    await db.delete(users).where(and(eq(users.email, email), eq(users.isActive, false)));
    return;
  } catch (e) {
    console.warn(
      `[signup] Suppression du compte non vérifié impossible (${(e as Error).message}) — ` +
      'neutralisation de l\'email à la place.',
    );
  }

  // Repli : l'adresse est rendue inutilisable, la ligne reste en base.
  // Le suffixe garantit l'unicité même après plusieurs tentatives.
  for (const row of stale) {
    await db
      .update(users)
      .set({
        email: `released+${row.id}+${Date.now()}@invalid.local`,
        isActive: false,
        updatedAt: new Date(),
      })
      .where(eq(users.id, row.id));
  }
}
