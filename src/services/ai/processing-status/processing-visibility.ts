/**
 * Visibilité d'un traitement d'analyse — lot 50 (ticket « Mascotte :
 * fiabiliser les sujets affichés et le contexte transmis à T6 »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN TRAITEMENT EST « UTILISATEUR » OU « TECHNIQUE »
 *
 *   USER       l'utilisateur attend ce traitement : dépôt d'un document,
 *              analyse demandée (document, lot), analyse rétroactive après
 *              changement d'offre ;
 *   TECHNICAL  réanalyse interne déclenchée par une correction, un
 *              rattachement, un déplacement, une montée de référentiel, une
 *              reprise ou une réparation — légitime, réellement exécutée,
 *              mais jamais présentée comme un sujet (mascotte).
 *
 * Chaque appelant DÉCLARE la visibilité de son traitement (`processingVisibility`
 * de `analyzeFileSources` / `enqueueFileAnalyses`) : aucune liste d'origines
 * n'est interprétée par les lecteurs. La valeur est portée par le travail de
 * file (payload, héritée par les remises en file) et par le document
 * (`asset_files.analysis_visibility`, migration 0337), écrite à la mise en
 * file et au démarrage de l'analyse.
 *
 * Règle de non-déclassement : tant qu'un document n'a JAMAIS été analysé
 * (`last_analysis_at` nul), un traitement technique (reprise d'un dépôt
 * bloqué, réanalyse au rattachement d'un document encore en file…) ne
 * masque pas sa première analyse, que l'utilisateur attend toujours.
 *
 * L'état technique du document (`effectiveAnalysisStateSql`) n'est PAS
 * modifié : l'analyse reste « en cours » partout où l'état réel compte
 * (tiroir, liste, BO) ; seul le choix des sujets de la mascotte filtre.
 *
 * Colonne volontairement NON déclarée dans Drizzle (`asset_files` est lu
 * partout par `db.select().from(assetFiles)`) : lue et écrite en SQL
 * seulement si sa présence est confirmée. Absente : rien n'est écrit, tout
 * traitement est considéré USER (comportement antérieur). Ne lève jamais.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { probeCount } from '@/lib/schema-readiness-log';
import { cachedSchemaProbe } from '../telemetry/trace-schema';
export type ProcessingVisibility = 'USER' | 'TECHNICAL';

/** Valeur d'un travail ou d'une demande qui n'en déclare pas (antérieurs au lot 50). */
const DEFAULT_PROCESSING_VISIBILITY: ProcessingVisibility = 'USER';

/** Lecture tolérante d'une valeur (payload de file, option). */
export function normalizeProcessingVisibility(v: unknown): ProcessingVisibility {
  return v === 'TECHNICAL' ? 'TECHNICAL' : DEFAULT_PROCESSING_VISIBILITY;
}

const visibilityProbe = cachedSchemaProbe(async () => {
  const { pgClient } = await import('@/db');
  const rows = (await pgClient.unsafe(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'asset_files' AND column_name = 'analysis_visibility'`,
  )) as unknown as Array<{ n: number }>;
  const found = probeCount(rows); // lot 75A : résultat inexploitable = inconnu, pas 0
  return { ready: found === 1, found };
}, {
  scope: '[processing-visibility]', migration: '0337', expected: ['asset_files.analysis_visibility'],
  consequence: 'Toute analyse en cours reste présentée par la mascotte (comportement antérieur).',
});

/** Colonne `asset_files.analysis_visibility` (0337) présente ? Ne lève jamais. */
export async function analysisVisibilityColumnReady(): Promise<boolean> {
  return visibilityProbe();
}

/**
 * SQL de l'écriture (pure, testée) : USER s'impose toujours ; TECHNICAL ne
 * remplace pas la valeur d'un document jamais analysé (règle de
 * non-déclassement). `updated_at` n'est PAS modifié : la visibilité n'est
 * pas une modification du document.
 */
export const MARK_ANALYSIS_VISIBILITY_SQL = `UPDATE asset_files
    SET analysis_visibility = CASE
          WHEN $3::text = 'USER' THEN 'USER'
          WHEN last_analysis_at IS NULL THEN analysis_visibility
          ELSE 'TECHNICAL' END
  WHERE id = ANY($1::int[]) AND account_id = $2
    AND analysis_visibility IS DISTINCT FROM (CASE
          WHEN $3::text = 'USER' THEN 'USER'
          WHEN last_analysis_at IS NULL THEN analysis_visibility
          ELSE 'TECHNICAL' END)`;

/**
 * Pose la visibilité du traitement sur les documents (mise en file, début
 * d'analyse). Ne lève jamais : la visibilité ne doit jamais faire échouer
 * une analyse ni un dépôt.
 */
export async function markAnalysisVisibility(
  fileIds: number[],
  accountId: number,
  visibility: ProcessingVisibility,
): Promise<void> {
  const ids = [...new Set(fileIds.filter(Number.isInteger))];
  if (ids.length === 0 || !accountId) return;
  try {
    if (!(await analysisVisibilityColumnReady())) return;
    const { pgClient } = await import('@/db');
    await pgClient.unsafe(MARK_ANALYSIS_VISIBILITY_SQL, [ids, accountId, normalizeProcessingVisibility(visibility)] as never[]);
  } catch (e) {
    console.error('[processing-visibility] visibilité du traitement non écrite :', (e as Error).message);
  }
}

const ALIAS = /^[a-z_][a-z0-9_]*$/i;

/**
 * Condition SQL « traitement présenté à l'utilisateur » sur `asset_files`
 * (alias contrôlé). `columnReady` faux : toujours vrai (comportement
 * antérieur). Pure.
 */
export function userVisibleAnalysisSql(alias: string, columnReady: boolean): string {
  if (!ALIAS.test(alias)) throw new Error(`alias SQL invalide : ${alias}`);
  return columnReady ? `(COALESCE(${alias}.analysis_visibility, 'USER') = 'USER')` : 'TRUE';
}
