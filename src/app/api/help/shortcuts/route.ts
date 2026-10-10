/**
 * GET /api/help/shortcuts?route=… — accès rapides de « Besoin d'aide ».
 * Lot 35 (L35-1), CDC Centre d'aide V1 §2.1, §13.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI PASSER PAR LE SERVEUR DE L'APPLICATION
 *
 * La modale lisait `/aide/catalogue.json` directement depuis le navigateur,
 * sur le site public. Cette lecture est soumise au CORS du site (une seule
 * origine autorisée, `appOrigin`) et à un délai de 5 s : dans l'application
 * mobile (vue web, réseau mobile), elle échouait et la feuille « Besoin
 * d'aide » n'affichait que la recherche et « Ouvrir le Centre d'aide », sans
 * les exemples visibles sur ordinateur.
 *
 * Le serveur lit le même catalogue (même source, même cache 5 min, même
 * contrôle d'environnement ENV-02) et renvoie les raccourcis résolus, dans
 * l'ordre de la page (`shortcutIdsForRoute`). Ordinateur et mobile appellent
 * cette même route : mêmes exemples, même logique contextuelle. Un ID inconnu
 * ou non publié reste masqué (§13).
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Route authentifiée (middleware) ; aucune donnée du compte n'est lue.
 */
import { NextRequest, NextResponse } from 'next/server';
import { fetchHelpCatalog, resolveShortcuts, shortcutIdsForRoute } from '@/lib/help-center/catalog';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('route') ?? '';
  // Chemin interne seulement, borné : sert uniquement à ordonner les IDs.
  const route = raw.startsWith('/') && !raw.startsWith('//') ? raw.slice(0, 300) : '';
  const catalog = await fetchHelpCatalog();
  if (!catalog) {
    return NextResponse.json({ available: false, shortcuts: [] }, { headers: { 'Cache-Control': 'no-store' } });
  }
  return NextResponse.json(
    { available: true, shortcuts: resolveShortcuts(catalog, shortcutIdsForRoute(route)) },
    { headers: { 'Cache-Control': 'private, max-age=60' } },
  );
}
