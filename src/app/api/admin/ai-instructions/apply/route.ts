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
 * `POST /api/admin/ai/prompt-changes` crée une demande de modification et la
 * fait analyser. La suite passe par `/diff`, les tests, puis deux validations
 * humaines distinctes avant `/activate`. `/rollback` restaure la version
 * précédente.
 *
 * ── POURQUOI UN 410 PLUTÔT QU'UNE SUPPRESSION ────────────────────────────
 * Une interface déployée peut encore appeler cette URL. Un 404 laisserait
 * croire à une panne ; un 410 dit que la ressource a disparu définitivement et
 * indique où aller. Le fichier disparaît au lot 6, où `check-legacy-ai.mjs`
 * l'interdit déjà (`FORBIDDEN_FILES`, phase 6).
 */
import { NextResponse } from 'next/server';

const REMPLACEMENT = '/api/admin/ai/prompt-changes';

export async function POST() {
  return NextResponse.json(
    {
      error: 'ROUTE_REMOVED',
      message:
        "L'application directe d'une modification de prompt n'est plus possible. " +
        'Créez une demande de modification, consultez le diff, exécutez les tests, ' +
        'puis faites valider l’activation par une seconde personne.',
      replacement: REMPLACEMENT,
    },
    { status: 410, headers: { Link: `<${REMPLACEMENT}>; rel="successor-version"` } },
  );
}
