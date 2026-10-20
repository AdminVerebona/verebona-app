import { redirect } from 'next/navigation';

/**
 * Lot 72D (ticket P0 « Premium Duo — compte partagé », décision PO Q11) :
 * les demandes croisées et la « récupération » de biens n'existent plus — les
 * deux membres partagent le même espace. Ancien lien (e-mail, notification) :
 * redirection vers Mon compte (desktop et mobile).
 */
export default function Page() {
  redirect('/mon-compte');
}
