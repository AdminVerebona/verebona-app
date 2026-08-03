/**
 * GET /api/to-process — compteur des éléments à traiter.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CETTE ROUTE N'EXISTAIT PAS
 *
 * `DashboardLayout` et la navigation mobile l'appellent à chaque chargement
 * pour afficher la pastille « à traiter ». Elle répondait 404.
 *
 * Deux sous-chemins existaient pourtant — `/api/to-process/suppliers` et
 * `/api/to-process/conficts`, ce dernier portant d'ailleurs une faute de
 * frappe — mais rien à la racine.
 *
 * Le client s'en accommodait par un repli silencieux vers
 * `/api/dashboard/a-traiter`. Le compteur finissait par s'afficher, au prix
 * de deux requêtes en échec à chaque ouverture de l'application.
 *
 * ── ELLE NE DUPLIQUE PAS LE CALCUL ────────────────────────────────────────
 *
 * `/api/dashboard/a-traiter` sait déjà quoi compter — documents en attente,
 * échéances à vérifier, équipements sans bien. Refaire ce calcul ici
 * garantirait qu'un jour les deux divergent, et que la pastille annonce un
 * nombre que l'écran ne montre pas.
 *
 * Cette route appelle donc la même logique et n'en rend que le total.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { GET as getATraiter } from '../dashboard/a-traiter/route';

export const dynamic = 'force-dynamic';

interface Detail {
  documents?: unknown[];
  agendaItems?: unknown[];
  equipements?: unknown[];
}

export async function GET(req: NextRequest) {
  try {
    await SessionService.getSession(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }

  const reponse = await getATraiter(req);

  // Une erreur en amont est transmise telle quelle : la masquer par un
  // compteur à zéro ferait croire qu'il n'y a rien à traiter.
  if (!reponse.ok) return reponse;

  const detail = (await reponse.json()) as Detail;
  const total =
    (detail.documents?.length ?? 0) +
    (detail.agendaItems?.length ?? 0) +
    (detail.equipements?.length ?? 0);

  return NextResponse.json(
    { total },
    // Même durée que la route détaillée : deux caches de durées différentes
    // afficheraient un compteur en désaccord avec l'écran.
    { headers: { 'Cache-Control': 'private, max-age=15, stale-while-revalidate=60' } },
  );
}
