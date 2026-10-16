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
 * Lot 62 (L62-AIDE) — SECONDE SOURCE : LE CORPUS DE L'ASSISTANT
 *
 * « Besoin d'aide sans les exemples » : quand le catalogue ne se lit pas
 * (site public lent ou injoignable depuis le serveur, catalogue refusé), la
 * route rendait `available: false` et la fenêtre restait sans exemple. Le
 * serveur lit déjà, pour l'assistant, le corpus publié par le MÊME site
 * (`/aide/corpus-t2.json` : mêmes IDs, titres et adresses), avec un dernier
 * corpus valide conservé en base (PUB-01) et le même contrôle d'environnement
 * (ENV-02). Les raccourcis en sont tirés quand le catalogue manque : mêmes
 * IDs, même ordre, un article absent ou non publié reste masqué (§13).
 * L'URL du site est celle que lit l'assistant (`HELP_CENTER_URL` serveur,
 * puis `NEXT_PUBLIC_PUBLIC_SITE_URL`) : les deux lectures ne divergent plus.
 * En-tête `X-Help-Shortcuts-Source` : `catalogue`, `corpus` ou `none`.
 *
 * Route authentifiée (middleware) ; aucune donnée du compte n'est lue.
 */
import { NextRequest, NextResponse } from 'next/server';
import { resolveHelpShortcutsOnServer } from '@/lib/help-center/shortcuts.server';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('route') ?? '';
  // Chemin interne seulement, borné : sert uniquement à ordonner les IDs.
  const route = raw.startsWith('/') && !raw.startsWith('//') ? raw.slice(0, 300) : '';
  const { source, shortcuts } = await resolveHelpShortcutsOnServer(route);
  if (source === 'none') {
    return NextResponse.json({ available: false, shortcuts: [] }, { headers: { 'Cache-Control': 'no-store', 'X-Help-Shortcuts-Source': 'none' } });
  }
  return NextResponse.json(
    { available: true, shortcuts },
    { headers: { 'Cache-Control': source === 'catalogue' ? 'private, max-age=60' : 'no-store', 'X-Help-Shortcuts-Source': source } },
  );
}
