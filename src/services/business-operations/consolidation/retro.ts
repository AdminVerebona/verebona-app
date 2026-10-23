/**
 * Réconciliation RÉTROACTIVE des échéances d'un contrat (lot 55B, ticket P1
 * « rattacher automatiquement toutes les factures d'un même contrat », C).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI
 *
 * Un document déjà consolidé (CREATE_NEW → son Opération « solo ») n'est
 * jamais réexaminé par le passage T3 : la continuité M2 (même source) le
 * rattache à sa propre Opération. Quand une Opération pertinente apparaît ou
 * change (contrat créé, échéance ajoutée, requalification), les factures
 * historiques qui lui appartiennent restaient donc séparées.
 *
 * COMMENT (file T3 existante, aucun nouveau worker)
 *
 *   · MARQUE (`requestRetroReconciliation`, migration 0398 pour le
 *     rattrapage initial) : candidats ACTIFS déjà traités, porteurs d'une
 *     preuve d'échéance (période facturée / INSTALLMENT) ou qualifiés
 *     CONTRACT, seuls sur leur Opération (une seule source active : la leur),
 *     liés à une autre Opération du MÊME compte par le prestataire ou un bien
 *     → `t3_pending` + `t3_detail.retroRequested`. Borné (50 par appel),
 *     paginé par le balayage T3 existant (200 documents par passage).
 *   · EXAMEN (`consolidateDocument`, mode rétroactif) : décision T3 recalculée
 *     SANS la propre Opération du document → mêmes règles que pour un
 *     nouveau document (M0 décision utilisateur, M1 référence exacte, M3
 *     verdict IA certain). Identité commune établie → FUSION (historique,
 *     sources, composantes, décisions conservés ; Opération absorbée
 *     redirigée). Doute → la source reste où elle est, l'IA (M3, plafonds
 *     inchangés) puis l'utilisateur (carte « À traiter ») tranchent. Rien de
 *     plausible → fin de l'examen.
 *   · REPRISE : l'état est porté par le candidat (`retroRequested`,
 *     `retro.status = PENDING`) : une interruption laisse la marque, le
 *     passage suivant reprend ; un examen terminé (`retro.status = DONE`)
 *     n'est jamais rejoué sans nouveau changement pertinent.
 *
 * Sécurité : toutes les requêtes sont bornées par `account_id` ; la fusion
 * exige deux Opérations du compte (dépôt sous verrou du compte) ; jamais sur
 * le seul prestataire / montant / intitulé (la marque n'est qu'un filtre, la
 * décision reste M0 / M1 / M3) ; jamais contre une décision utilisateur
 * (REJECTED, couples séparés).
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Candidats marqués au plus par appel (le reste au passage suivant). */
export const RETRO_MARK_LIMIT = 50;

/**
 * Prédicat SQL (alias `c`) : candidat porteur d'une échéance (période
 * facturée réelle ou portée INSTALLMENT) ou qualifié CONTRACT. Même règle
 * que `hasRecurringPeriod` (model.ts) — copiée telle quelle dans 0398.
 */
export const RETRO_ELIGIBLE_SQL = `(c.type_hint = 'CONTRACT' OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.payload->'financialHints') = 'array' THEN c.payload->'financialHints' ELSE '[]'::jsonb END) h
     WHERE h->>'amountScope' = 'INSTALLMENT'
        OR (h->>'periodStart' ~ '^\\d{4}-\\d{2}-\\d{2}$' AND h->>'periodEnd' ~ '^\\d{4}-\\d{2}-\\d{2}$' AND h->>'periodStart' < h->>'periodEnd')))`;

/** Prédicat SQL (alias `c`, `x` = Opération du candidat) : la seule source active de `x` est celle du candidat. */
export const RETRO_SOLO_SQL = `(
    (SELECT count(*) FROM business_operation_sources s WHERE s.operation_id = x.id AND s.account_id = x.account_id AND s.active) = 1
    AND EXISTS (SELECT 1 FROM business_operation_sources s WHERE s.operation_id = x.id AND s.account_id = x.account_id AND s.active
                   AND s.source_kind = 'DOCUMENT' AND s.source_entity_key = c.file_id::text AND s.locator->>'candidateKey' = c.candidate_key))`;

/** Types concernés par la réconciliation des échéances (jamais acquisition, cession, financement, sinistre). */
export const RETRO_TYPES_SQL = (alias: string) => `(${alias}.type_code IS NULL OR ${alias}.type_code IN ('CONTRACT', 'INTERVENTION', 'OTHER'))`;

/** État rétroactif d'un candidat (`t3_detail.retro`). */
export interface RetroTrace {
  status: 'PENDING' | 'DONE';
  /** Opération propre du document au début de l'examen. */
  operationId: number;
  /** DONE : MERGED, NO_MATCH, NOT_MERGEABLE, NOT_APPLICABLE. */
  result?: string;
  at?: string;
}

/** Le candidat est-il en examen rétroactif (marque, ou examen en attente IA / utilisateur) ? Pure. */
export function retroActive(detail: Record<string, unknown> | null | undefined): boolean {
  if (!detail) return false;
  if (detail.retroRequested) return true;
  const r = detail.retro as RetroTrace | undefined;
  return r?.status === 'PENDING';
}

/**
 * Marque pour réexamen les documents déjà traités susceptibles d'appartenir
 * aux Opérations `operationIds` (créées / enrichies / requalifiées) — même
 * compte, Opérations « solo » liées par le prestataire ou un bien. Rend les
 * documents marqués. Aucune écriture métier, aucun appel IA.
 */
export async function requestRetroReconciliation(accountId: number, operationIds: readonly number[], limit = RETRO_MARK_LIMIT): Promise<number[]> {
  const ids = [...new Set(operationIds)].filter((n) => Number.isSafeInteger(n) && n > 0);
  if (!ids.length || limit <= 0) return [];
  const { pgClient } = await import('@/db');
  const r = (await pgClient.unsafe(
    `WITH cibles AS (
       SELECT o.id, NULLIF(lower(btrim(o.provider)), '') AS prov FROM business_operations o
        WHERE o.account_id = $1 AND o.id = ANY($2::bigint[]) AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
          AND ${RETRO_TYPES_SQL('o')}
     ), choisis AS (
       SELECT c.id FROM document_operation_candidates c
         JOIN business_operations x ON x.id = c.t3_operation_id AND x.account_id = c.account_id
        WHERE c.account_id = $1 AND c.status = 'ACTIVE' AND NOT c.t3_pending AND c.established
          AND c.t3_outcome IN ('CREATE_NEW', 'MATCH_AND_ENRICH') AND NOT (c.t3_operation_id = ANY($2::bigint[]))
          AND NOT (COALESCE(c.t3_detail, '{}'::jsonb) ? 'retroRequested')
          AND COALESCE(c.t3_detail->'retro'->>'status', '') <> 'PENDING'
          AND x.invalidated_at IS NULL AND x.merged_into_operation_id IS NULL AND ${RETRO_TYPES_SQL('x')}
          AND ${RETRO_ELIGIBLE_SQL} AND ${RETRO_SOLO_SQL}
          AND EXISTS (SELECT 1 FROM cibles k
                       WHERE (k.prov IS NOT NULL AND k.prov = lower(btrim(x.provider)))
                          OR EXISTS (SELECT 1 FROM business_operation_asset_links l1
                                       JOIN business_operation_asset_links l2 ON l2.asset_id = l1.asset_id AND l2.active AND l2.operation_id = x.id
                                      WHERE l1.operation_id = k.id AND l1.active))
        ORDER BY c.id LIMIT $3
     )
     UPDATE document_operation_candidates c
        SET t3_pending = true,
            t3_detail = COALESCE(c.t3_detail, '{}'::jsonb) || jsonb_build_object('retroRequested', jsonb_build_object('by', 'T3', 'at', now()))
       FROM choisis WHERE c.id = choisis.id AND c.account_id = $1
     RETURNING c.file_id`,
    [accountId, `{${ids.join(',')}}`, limit] as never[],
  )) as unknown as Array<{ file_id: number }>;
  return [...new Set(r.map((x) => Number(x.file_id)))].sort((a, b) => a - b);
}

/**
 * Prédicat SQL (alias `c`, `x`) : une AUTRE Opération active du même compte,
 * de type compatible, partage le prestataire ou un bien avec `x` — même
 * filtre que la migration 0398 (rattrapage initial).
 */
export const RETRO_NEIGHBOUR_SQL = `EXISTS (
    SELECT 1 FROM business_operations y
     WHERE y.account_id = x.account_id AND y.id <> x.id AND y.invalidated_at IS NULL AND y.merged_into_operation_id IS NULL
       AND ${RETRO_TYPES_SQL('y')}
       AND ((NULLIF(lower(btrim(y.provider)), '') = lower(btrim(x.provider)))
            OR EXISTS (SELECT 1 FROM business_operation_asset_links l1
                         JOIN business_operation_asset_links l2 ON l2.asset_id = l1.asset_id AND l2.active AND l2.operation_id = y.id
                        WHERE l1.operation_id = x.id AND l1.active)))`;

/**
 * Rattrapage d'un COMPTE entier (BO « Reconsolider ce compte », et même
 * prédicat que la migration 0398) : marque les échéances seules sur leur
 * Opération qui ont une voisine plausible. Idempotent (une marque posée ou un
 * examen en attente n'est pas reposé). Rend le nombre de documents marqués.
 */
export async function requestAccountRetroReconciliation(accountId: number, limit = 5_000): Promise<number> {
  const { pgClient } = await import('@/db');
  const r = (await pgClient.unsafe(
    `WITH choisis AS (
       SELECT c.id FROM document_operation_candidates c
         JOIN business_operations x ON x.id = c.t3_operation_id AND x.account_id = c.account_id
        WHERE c.account_id = $1 AND c.status = 'ACTIVE' AND c.established
          AND c.t3_outcome IN ('CREATE_NEW', 'MATCH_AND_ENRICH')
          AND NOT (COALESCE(c.t3_detail, '{}'::jsonb) ? 'retroRequested')
          AND COALESCE(c.t3_detail->'retro'->>'status', '') <> 'PENDING'
          AND x.invalidated_at IS NULL AND x.merged_into_operation_id IS NULL AND ${RETRO_TYPES_SQL('x')}
          AND ${RETRO_ELIGIBLE_SQL} AND ${RETRO_SOLO_SQL} AND ${RETRO_NEIGHBOUR_SQL}
        ORDER BY c.id LIMIT $2
     )
     UPDATE document_operation_candidates c
        SET t3_pending = true,
            t3_detail = COALESCE(c.t3_detail, '{}'::jsonb) || jsonb_build_object('retroRequested', jsonb_build_object('by', 'BO', 'at', now()))
       FROM choisis WHERE c.id = choisis.id AND c.account_id = $1
     RETURNING c.id`,
    [accountId, limit] as never[],
  )) as unknown as unknown[];
  return r.length;
}

/**
 * Lot 84E (CDC v5 O-6, §9.3, E28) — sélection CIBLÉE des documents récurrents
 * à réexaminer, sans retraiter le compte : candidats ACTIFS déjà consolidés,
 * porteurs d'une échéance (période facturée / INSTALLMENT) ou qualifiés
 * CONTRACT, dont l'Opération est active et de type compatible (contrat,
 * intervention, autre, non qualifiée), et qui répondent au SÉLECTEUR :
 *   · documents (`fileIds`) ou Opérations (`operationIds`) désignés ;
 *   · prestataire (`providers`, comparé comme la marque 55B :
 *     `lower(btrim(...))`) ;
 *   · références de service (`references` : `CONTRACT:X`, `POLICY:X`,
 *     `CUSTOMER:X`, valeurs normalisées) portées par le candidat ;
 *   · biens (`assetIds`) liés à son Opération.
 * Contrairement à la marque 55B, les FRAGMENTS d'une série (Opération à
 * plusieurs échéances) sont aussi repris : la décision T3 réunit deux
 * fragments d'une série ÉTABLIE (`recurrence.ts`), jamais une intervention
 * ponctuelle. Marque `retroRequested` (by `O6`) + `t3_pending` : même
 * reprise que le réexamen 55B (état porté par le candidat, aucune perte).
 * Borné (`limit`) ; idempotent (une marque posée ou un examen en attente
 * n'est pas reposé). Aucune écriture métier, aucun appel IA.
 */
export interface TargetedRetroSelector {
  fileIds?: readonly number[];
  operationIds?: readonly number[];
  providers?: readonly string[];
  references?: readonly string[];
  assetIds?: readonly number[];
}

export const TARGETED_RETRO_LIMIT = 200;

/**
 * Opération ACTUELLE d'un candidat (alias `c`) : celle de sa source documentaire
 * active (une fusion déplace la source, pas `t3_operation_id`), à défaut sa
 * dernière décision T3.
 */
export const OWN_OPERATION_SQL = `COALESCE((
    SELECT s.operation_id FROM business_operation_sources s
     WHERE s.account_id = c.account_id AND s.active AND s.source_kind = 'DOCUMENT'
       AND s.source_entity_key = c.file_id::text AND s.locator->>'candidateKey' = c.candidate_key
     ORDER BY s.id LIMIT 1), c.t3_operation_id)`;

const ints = (v: readonly number[] | undefined) => `{${[...new Set(v ?? [])].filter((n) => Number.isSafeInteger(n) && n > 0).join(',')}}`;
const texts = (v: readonly string[] | undefined) =>
  `{${[...new Set(v ?? [])].filter((x) => typeof x === 'string' && x.trim()).map((x) => `"${x.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;

export function targetedSelectorEmpty(s: TargetedRetroSelector): boolean {
  return !s.fileIds?.length && !s.operationIds?.length && !s.providers?.length && !s.references?.length && !s.assetIds?.length;
}

export async function requestTargetedRetroReconciliation(
  accountId: number, s: TargetedRetroSelector, opts: { limit?: number; by?: string; dryRun?: boolean } = {},
): Promise<number[]> {
  if (targetedSelectorEmpty(s)) return [];
  const limit = Math.max(1, Math.min(5_000, opts.limit ?? TARGETED_RETRO_LIMIT));
  const { pgClient } = await import('@/db');
  const choix = `
       SELECT c.id, c.file_id FROM document_operation_candidates c
         JOIN business_operations x ON x.account_id = c.account_id AND x.id = ${OWN_OPERATION_SQL}
        WHERE c.account_id = $1 AND c.status = 'ACTIVE' AND c.established AND NOT c.t3_pending
          AND c.t3_outcome IN ('CREATE_NEW', 'MATCH_AND_ENRICH')
          AND NOT (COALESCE(c.t3_detail, '{}'::jsonb) ? 'retroRequested')
          AND COALESCE(c.t3_detail->'retro'->>'status', '') <> 'PENDING'
          AND x.invalidated_at IS NULL AND x.merged_into_operation_id IS NULL AND ${RETRO_TYPES_SQL('x')}
          AND ${RETRO_ELIGIBLE_SQL}
          AND (c.file_id = ANY($2::int[]) OR x.id = ANY($3::bigint[])
               OR (cardinality($4::text[]) > 0 AND NULLIF(lower(btrim(c.payload->>'provider')), '') = ANY($4::text[]))
               OR (cardinality($4::text[]) > 0 AND NULLIF(lower(btrim(x.provider)), '') = ANY($4::text[]))
               OR (cardinality($5::text[]) > 0 AND EXISTS (
                     SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.payload->'businessReferences') = 'array' THEN c.payload->'businessReferences' ELSE '[]'::jsonb END) r
                      WHERE upper(r->>'kind') || ':' || regexp_replace(upper(translate(r->>'value', 'àâäéèêëîïôöùûüçÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ', 'aaaeeeeiioouuucAAAEEEEIIOOUUUC')), '[^A-Z0-9]', '', 'g') = ANY($5::text[])))
               OR EXISTS (SELECT 1 FROM business_operation_asset_links l WHERE l.operation_id = x.id AND l.active AND l.asset_id = ANY($6::int[])))
        ORDER BY c.id LIMIT $7`;
  const params = [accountId, ints(s.fileIds), ints(s.operationIds), texts((s.providers ?? []).map((p) => p.trim().toLowerCase())), texts(s.references), ints(s.assetIds), limit];
  if (opts.dryRun) {
    const r = (await pgClient.unsafe(choix, params as never[])) as unknown as Array<{ file_id: number }>;
    return [...new Set(r.map((x) => Number(x.file_id)))].sort((a, b) => a - b);
  }
  const r = (await pgClient.unsafe(
    `WITH choisis AS (${choix})
     UPDATE document_operation_candidates c
        SET t3_pending = true,
            t3_detail = COALESCE(c.t3_detail, '{}'::jsonb) || jsonb_build_object('retroRequested', jsonb_build_object('by', $8::text, 'at', now()))
       FROM choisis WHERE c.id = choisis.id AND c.account_id = $1
     RETURNING c.file_id`,
    [...params, opts.by ?? 'O6'] as never[],
  )) as unknown as Array<{ file_id: number }>;
  return [...new Set(r.map((x) => Number(x.file_id)))].sort((a, b) => a - b);
}
