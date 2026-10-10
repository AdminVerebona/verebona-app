/**
 * État d'analyse EFFECTIF d'un document, en SQL — lot 34C (cas 7).
 *
 * Même règle que `computeProcessingStatus` (`@/lib/ai/processing-status`),
 * pour les lectures agrégées (assistant, mascotte, accueil) qui lisent
 * `asset_files.analysis_state` directement :
 *
 *   job T1 vivant RUNNING            → 'ANALYZING'  (analyse en cours, même si
 *                                                    le document porte l'échec
 *                                                    intermédiaire d'une tentative)
 *   job T1 vivant PENDING            → 'UPLOADED'   (réellement en file)
 *   'UPLOADED' / 'UPLOADING' sans job → NULL        (rien n'est en file : jamais
 *                                                    « en cours d'analyse »)
 *   sinon                            → l'état du document
 *
 * `alias` : alias SQL de `asset_files` dans la requête appelante (identifiant
 * simple, contrôlé). Pur : aucune requête ici.
 */
const ALIAS = /^[a-z_][a-z0-9_]*$/i;

function liveJob(alias: string, status: 'RUNNING' | 'PENDING'): string {
  return `EXISTS (SELECT 1 FROM ai_job_queue jq34
                   WHERE jq34.treatment = 'T1' AND jq34.target_type = 'asset_file'
                     AND jq34.target_id = ${alias}.id::text AND jq34.status = '${status}')`;
}

export function effectiveAnalysisStateSql(alias: string): string {
  if (!ALIAS.test(alias)) throw new Error(`alias SQL invalide : ${alias}`);
  return `(CASE
     WHEN ${liveJob(alias, 'RUNNING')} THEN 'ANALYZING'
     WHEN ${liveJob(alias, 'PENDING')} THEN 'UPLOADED'
     WHEN ${alias}.analysis_state IN ('UPLOADED', 'UPLOADING') THEN NULL
     ELSE ${alias}.analysis_state END)`;
}
