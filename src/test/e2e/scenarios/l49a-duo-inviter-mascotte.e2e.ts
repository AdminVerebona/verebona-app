/**
 * Lot 49A — ticket 13 : « Inviter quelqu'un », première action de la
 * mascotte pour un nouvel abonné Premium Duo, sur PostgreSQL réel (schéma
 * réel de `accounts`, `duo_accounts`, `duo_memberships`, adhésion du payeur
 * créée comme à la souscription).
 */
import { expect, it } from 'vitest';
import { scenario } from '../scenario';

scenario('L49A-T13', 'Duo : « Inviter quelqu’un » proposé en premier, jusqu’à l’invitation', ({ sql, make }) => {
  it('AC13-1 / AC13-4 / AC13-5 — lecture réelle : proposé, puis retiré à l’envoi et à l’acceptation ; jamais pour le membre', async () => {
    const { readDuoInvite } = await import('@/services/home/mascot/duo-invite');
    const compte = await make.account({ plan: 'premium_duo' });
    // Souscription Duo : Duo du payeur, son adhésion (slot 0), compte rattaché.
    const [duo] = await sql<{ id: number }[]>`
      INSERT INTO duo_accounts (billing_owner_user_id, subscription_status) VALUES (${compte.ownerUserId}, 'ACTIVE') RETURNING id`;
    await sql`INSERT INTO duo_memberships (duo_id, user_id, status, slot, joined_at) VALUES (${duo.id}, ${compte.ownerUserId}, 'ACTIVE', 0, now())`;
    await sql`UPDATE accounts SET duo_account_id = ${duo.id} WHERE id = ${compte.id}`;

    expect(await readDuoInvite(compte.id)).toMatchObject({ title: 'Inviter quelqu’un', href: '/mon-compte#duo-invitation' });

    // Abonnement Duo pas encore activé par le paiement : rien.
    await sql`UPDATE duo_accounts SET subscription_status = 'CANCELED' WHERE id = ${duo.id}`;
    expect(await readDuoInvite(compte.id)).toBeNull();
    await sql`UPDATE duo_accounts SET subscription_status = 'ACTIVE' WHERE id = ${duo.id}`;

    // Invitation envoyée : retirée.
    await sql`UPDATE duo_accounts SET pending_invite_email = 'ami@test.invalid', pending_invite_sent_at = now() WHERE id = ${duo.id}`;
    expect(await readDuoInvite(compte.id)).toBeNull();

    // Invitation acceptée (le membre a rejoint, l'invitation est soldée) : retirée.
    const membre = await make.account();
    await sql`UPDATE duo_accounts SET pending_invite_email = NULL WHERE id = ${duo.id}`;
    await sql`INSERT INTO duo_memberships (duo_id, user_id, status, slot, joined_at) VALUES (${duo.id}, ${membre.ownerUserId}, 'ACTIVE', 1, now())`;
    expect(await readDuoInvite(compte.id)).toBeNull();

    // Le compte du membre ne se voit jamais proposer l'invitation.
    expect(await readDuoInvite(membre.id)).toBeNull();
    // Compte sans Duo : rien.
    expect(await readDuoInvite((await make.account({ plan: 'premium' })).id)).toBeNull();
  });
});
