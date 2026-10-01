/**
 * MIG-04 — supersede des preuves d'anciennes extractions (CDC 15 §14
 * point 4, T3-03, §14.4) : « Supersede les preuves d'anciennes extractions
 * en conservant la trace historique ».
 *
 * RÈGLE EXACTE : une preuve ACTIVE (`lifecycle_status` NULL ou ACTIVE) est
 * remplacée quand une AUTRE preuve ACTIVE existe pour la MÊME source
 * (`source_type`, `source_id`), le même champ (`field_key`) et la même cible
 * (bien, ou `target_type` / `target_entity_id`), issue d'une analyse
 * POSTÉRIEURE :
 *   · analyse datée plus récente (`analysis_run_id` supérieur, ou présent
 *     face à une preuve sans analyse) ;
 *   · à défaut d'analyse datée des deux côtés : autre exécution
 *     (`operation_trace_id` différent) extraite plus tard (`extracted_at`).
 * → `lifecycle_status = SUPERSEDED`, `superseded_at`, et
 *   `superseded_by_evidence_id` = la remplaçante la plus récente. Aucune
 *   suppression ; `status` et la valeur de la preuve sont conservés.
 * Une preuve sans remplaçante de même champ n'est pas touchée (une
 * extraction plus récente qui n'a pas relu ce champ ne prouve rien contre
 * lui). Aucune valeur de fiche n'est modifiée (MIG-09 sans objet). Copie
 * restaurable des colonnes de cycle de vie (`--restore`).
 */
import { iterateBatches } from '../iterate';
import { writeBackups, type BackupRow } from '../backup';
import { emptyCounts, type StepContext, type StepResult } from '../types';

const STEP = 'MIG-04' as const;

const ACTIF = (a: string) => `(${a}.lifecycle_status IS NULL OR ${a}.lifecycle_status = 'ACTIVE')`;
const POSTERIEURE = `(
  (n.analysis_run_id IS NOT NULL AND (o.analysis_run_id IS NULL OR n.analysis_run_id > o.analysis_run_id))
  OR (n.analysis_run_id IS NULL AND o.analysis_run_id IS NULL
      AND n.operation_trace_id IS DISTINCT FROM o.operation_trace_id AND n.extracted_at > o.extracted_at)
)`;
/** Requête des remplacements d'un lot (exportée pour les tests). */
export const SUPERSEDE_CANDIDATES_SQL = `
  SELECT o.id, o.account_id AS "accountId", o.asset_id AS "assetId", o.field_key AS "fieldKey",
         o.analysis_run_id AS "oldRun", o.extracted_at AS "oldAt",
         (SELECT n.id FROM field_evidence n
           WHERE n.account_id = o.account_id AND n.source_type = o.source_type AND n.source_id = o.source_id
             AND n.field_key = o.field_key AND n.asset_id = o.asset_id
             AND coalesce(n.target_type, 'ASSET') = coalesce(o.target_type, 'ASSET')
             AND n.target_entity_id IS NOT DISTINCT FROM o.target_entity_id
             AND n.id <> o.id AND ${ACTIF('n')} AND ${POSTERIEURE}
           ORDER BY n.analysis_run_id DESC NULLS LAST, n.extracted_at DESC, n.id DESC LIMIT 1) AS "newId"
    FROM field_evidence o
   WHERE ${ACTIF('o')} AND o.id > $1 AND ($2::int IS NULL OR o.account_id = $2)
   ORDER BY o.id LIMIT $3`;

export async function runMig04(ctx: StepContext): Promise<StepResult> {
  const counts = emptyCounts();
  const r = await iterateBatches(ctx, async (after, limit) => (await ctx.sql.unsafe(SUPERSEDE_CANDIDATES_SQL, [after, ctx.accountId, limit] as never[])) as unknown as Array<{
    id: number; accountId: number; assetId: number; fieldKey: string; oldRun: number | null; oldAt: Date; newId: number | null;
  }>, async (rows) => {
    for (const o of rows.filter((x) => x.newId != null)) {
      let applied = true;
      if (ctx.apply) {
        // Écriture et copie restaurable (valeurs d'avant lues sous verrou) dans UNE transaction.
        applied = false;
        await ctx.sql.begin(async (tx) => {
          const [av] = await tx<Array<{ l: string | null; s: string | null; b: string | null }>>`
            SELECT lifecycle_status AS l, superseded_at::text AS s, superseded_by_evidence_id::text AS b
              FROM field_evidence WHERE id = ${o.id} AND (lifecycle_status IS NULL OR lifecycle_status = 'ACTIVE') FOR UPDATE`;
          if (!av) return;
          const [ap] = await tx<Array<{ l: string | null; s: string | null; b: string | null }>>`
            UPDATE field_evidence SET lifecycle_status = 'SUPERSEDED', superseded_at = now(), superseded_by_evidence_id = ${o.newId}
             WHERE id = ${o.id} RETURNING lifecycle_status AS l, superseded_at::text AS s, superseded_by_evidence_id::text AS b`;
          const lignes: BackupRow[] = ([['lifecycle_status', 'l'], ['superseded_at', 's'], ['superseded_by_evidence_id', 'b']] as const)
            .filter(([, k]) => av[k] !== ap[k])
            .map(([name, k]) => ({ targetType: 'field_evidence', targetId: Number(o.id), assetId: o.assetId, name, old: { v: av[k] }, next: { v: ap[k] } }));
          await writeBackups(tx as never, { runId: ctx.runId, step: STEP, accountId: o.accountId }, lignes);
          applied = true;
        });
      }
      const decision = applied ? 'APPLIED' : 'NO_CHANGE';
      counts[decision] += 1;
      if (applied) {
        await ctx.report({
          step: STEP, accountId: o.accountId, assetId: o.assetId, entityType: 'field_evidence', entityId: o.id, fieldKey: o.fieldKey,
          before: { lifecycleStatus: 'ACTIVE', analysisRunId: o.oldRun }, after: { lifecycleStatus: 'SUPERSEDED', supersededBy: Number(o.newId) },
          decision, reason: 'OLDER_EXTRACTION_SAME_SOURCE',
        });
      }
    }
  });
  return { step: STEP, scanned: r.scanned, counts, cursor: r.cursor, cards: 0, complete: r.exhausted };
}
