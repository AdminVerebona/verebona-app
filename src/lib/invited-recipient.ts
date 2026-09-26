/**
 * Invitation nominative : la personne connectée est-elle celle invitée ?
 *
 * Règle commune aux invitations qui désignent une adresse (transmission d'un
 * bien, Premium Duo, inscription sur invitation) : comparaison sans espaces
 * autour ni casse. Hors d'un fichier de route : Next.js n'admet dans une
 * route que ses propres exports (GET, POST…).
 *
 * Contrairement à l'inscription, où une invitation SANS adresse est ouverte
 * à tous, ici l'absence d'adresse (invitée ou de session) refuse : on ne
 * remet pas un bien à « n'importe qui ».
 */
export function isInvitedRecipient(
  invitedEmail: string | null | undefined,
  sessionEmail: string | null | undefined,
): boolean {
  if (!invitedEmail || !sessionEmail) return false;
  return invitedEmail.trim().toLowerCase() === sessionEmail.trim().toLowerCase();
}
