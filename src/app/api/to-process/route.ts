/**
 * GET /api/to-process — compteur de la pastille de navigation.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE COMPTEUR ET LA PAGE COMPTENT LA MÊME CHOSE
 *
 * Cette route servait le modèle V1 : elle additionnait des OBJETS — documents
 * en attente, échéances à vérifier, équipements sans bien. La page, elle,
 * affiche désormais des ACTIONS (§7.1), et un même document peut en porter
 * trois.
 *
 * Laisser les deux calculs en place aurait produit le défaut le plus sûr pour
 * faire cesser de consulter la page : un menu annonçant « 7 » au-dessus d'un
 * écran qui montre 3 cartes. Un compteur en désaccord avec ce qu'il annonce
 * est pire qu'une absence de compteur.
 *
 * `countActiveActions` est exactement la requête que la page utilise pour son
 * total : mêmes actions actives, même compte, même filtre `resolved_at IS
 * NULL`.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { countActiveActions } from '@/services/to-process/to-process-action.service';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  let session;
  try {
    session = await SessionService.getSession(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }

  const accountId = session.currentAccountId;
  // Aucun compte sélectionné : la pastille n'a rien à afficher, et une erreur
  // ici ferait échouer le rendu de toute la navigation.
  if (!accountId) return NextResponse.json({ total: 0 });

  const total = await countActiveActions(accountId);

  return NextResponse.json(
    { total },
    // Même durée que /api/v2/to-process : deux caches de durées différentes
    // afficheraient un compteur en retard sur l'écran.
    { headers: { 'Cache-Control': 'private, max-age=15, stale-while-revalidate=60' } },
  );
}
