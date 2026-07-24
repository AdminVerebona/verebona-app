import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

/**
 * Page racine.
 *
 * La session vit desormais dans un cookie HttpOnly : elle est lisible cote
 * serveur. La redirection se fait donc avant tout rendu, sans passer par le
 * navigateur — plus rapide, et sans etat d'authentification expose au
 * JavaScript (CDC §5.1 / §10.3).
 */
export default async function RootPage() {
  const cookieStore = await cookies();
  const hasSession =
    Boolean(cookieStore.get('access_token')?.value) ||
    Boolean(cookieStore.get('refresh_token')?.value);

  redirect(hasSession ? '/accueil' : '/login');
}
