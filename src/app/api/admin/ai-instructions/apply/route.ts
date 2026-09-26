/**
 * POST /api/admin/ai-instructions/apply — ROUTE RETIRÉE (CDC §4.5.3, critère n°18).
 *
 * ── CE QU'ELLE FAISAIT ───────────────────────────────────────────────────
 * Elle envoyait l'instruction de l'administrateur à Gemini, via le SDK en
 * direct, récupérait des patches et les écrivait dans les `.txt` de
 * `src/services/document-ai/prompts/` avec `writeFileSync`. Aucun aperçu,
 * aucune validation distincte, aucun test — trois exigences du §4.5.3, et le
 * critère d'acceptation n°18 en entier.
 *
 * Ce n'était pas seulement non conforme, c'était inopérant : sur un hébergement
 * où le système de fichiers du conteneur est éphémère et non partagé entre
 * instances, ces écritures étaient perdues au redéploiement et invisibles des
 * autres instances. La migration 0106 en tire la conséquence — les prompts sont
 * des données versionnées, plus des fichiers.
 *
 * ── CE QUI LA REMPLACE ───────────────────────────────────────────────────
 * L'écran Prompt Control (T5) de la Configuration IA — `/admin/ai-config`,
 * section `#prompt-control` (CDC BO IA SCR-06, WF-20) — adossé à
 * `POST /api/admin/ai/prompt-control` : l'administrateur décrit le besoin en
 * français, T5 analyse puis réécrit le prompt DANS UN BROUILLON ; la mise en
 * service suit le cycle Brouillon → À tester → Active des versions de
 * configuration.
 *
 * Cette réponse renvoyait auparavant vers `/api/admin/ai/prompt-changes`
 * (et `/diff`, `/activate`, `/rollback`) : ces routes ont été SUPPRIMÉES. Un
 * client qui suivait le lien de remplacement tombait sur un 404.
 *
 * ── POURQUOI UN 410 PLUTÔT QU'UNE SUPPRESSION ────────────────────────────
 * Une interface déployée peut encore appeler cette URL. Un 404 laisserait
 * croire à une panne ; un 410 dit que la ressource a disparu définitivement et
 * indique où aller. Le fichier disparaît au lot 6, où `check-legacy-ai.mjs`
 * l'interdit déjà (`FORBIDDEN_FILES`, phase 6).
 */
import { NextResponse } from 'next/server';

/** Écran Prompt Control (Configuration IA) — destination à montrer à l'administrateur. */
const REMPLACEMENT_ECRAN = '/admin/ai-config#prompt-control';
/** Route qui porte Prompt Control — successeur technique de celle-ci. */
const REMPLACEMENT_API = '/api/admin/ai/prompt-control';

export async function POST() {
  return NextResponse.json(
    {
      error: 'ROUTE_REMOVED',
      message:
        "L'application directe d'une modification de prompt n'est plus possible. " +
        'Utilisez Prompt Control dans la Configuration IA : décrivez le besoin, ' +
        'la modification est écrite dans un brouillon, testée, puis activée.',
      replacement: REMPLACEMENT_ECRAN,
      replacementApi: REMPLACEMENT_API,
    },
    { status: 410, headers: { Link: `<${REMPLACEMENT_API}>; rel="successor-version"` } },
  );
}
