/**
 * Écriture et lecture des preuves — CDC §5.4.2, CDC 15 T1-04, T3-03, §14.4.
 *
 * Invariants :
 *  - une même preuve n'est jamais créée deux fois (CDC §5.7) : l'unicité porte
 *    sur (compte, bien, champ, source, localisation, valeur normalisée) — et,
 *    pour le contrat T1 enrichi, sur la cible et l'analyse ;
 *  - toute valeur appliquée automatiquement possède au moins une preuve
 *    (critère d'acceptation n°12) ;
 *  - une preuve n'est JAMAIS supprimée : une réanalyse la fait passer en
 *    SUPERSEDED (cycle de vie 0219), avec date et lien vers la remplaçante.
 *
 * Lecture « champ du bien » (`getActiveEvidence`) : uniquement les preuves
 * ACTIVE (cycle de vie) et `status = 'active'` (décision), portant sur le
 * bien lui-même — une preuve ciblée sur un équipement ou une pièce du bien
 * n'est pas une preuve du bien (T1-04).
 */
import { createHash } from 'crypto';
import { pgClient } from '@/db';
import type { FieldEvidence, FieldEvidenceInput, EvidenceStatus, EvidenceTargetType } from './evidence.types';
import { fieldEvidenceCanonicalReady } from './canonical-columns';

/** Vrai si l'entrée porte au moins une donnée du contrat enrichi (0219). */
export function hasCanonicalExtension(i: FieldEvidenceInput): boolean {
  return i.canonicalKey != null || i.canonicalUnit != null || i.rawValue != null || i.target != null
    || i.semanticEvent != null || i.recurrence != null || i.projectionOrigin != null
    || i.projectionRule != null || i.analysisRunId != null;
}

/** Une cible autre que « le bien lui-même » exige les colonnes 0219. */
function isNonAssetTarget(i: FieldEvidenceInput): boolean {
  return !!i.target && i.target.type !== 'ASSET';
}

export function evidenceFingerprint(i: FieldEvidenceInput): string {
  return createHash('sha256').update(JSON.stringify({
    a: i.accountId, as: i.assetId, f: i.fieldKey,
    st: i.sourceType, si: i.sourceId, sv: i.sourceVersion ?? null,
    loc: i.location, nv: i.normalizedValue ?? String(i.value),
    // Une observation visuelle et une lecture de la même valeur restent deux
    // preuves distinctes ; les empreintes des preuves lues sont inchangées.
    ...(i.evidenceOrigin === 'VISUAL_ANALYSIS' ? { o: 'VISUAL_ANALYSIS' } : {}),
    // Contrat T1 enrichi (CDC 15 T1-04) : deux cibles = deux preuves ; une
    // nouvelle analyse = une nouvelle preuve (l'ancienne passe SUPERSEDED avec
    // un lien vers celle-ci). Absents : empreinte historique inchangée.
    ...(i.target ? { tg: [i.target.type, i.target.entityId] } : {}),
    ...(i.analysisRunId != null ? { run: i.analysisRunId } : {}),
  })).digest('hex');
}

/** Erreur : preuve ciblée hors bien alors que la migration 0219 n'est pas appliquée. */
export class EvidenceSchemaNotReadyError extends Error {
  constructor(fieldKey: string) {
    super(`Preuve ciblée (${fieldKey}) non écrite : colonnes 0219 absentes de field_evidence (CDC 15 T1-04).`);
    this.name = 'EvidenceSchemaNotReadyError';
  }
}

/** Paramètres communs aux deux formes d'INSERT (ordre = $1…$21). */
function baseParams(input: FieldEvidenceInput, fingerprint: string): unknown[] {
  return [
    input.accountId, input.assetId, input.fieldKey,
    JSON.stringify(input.value), input.normalizedValue ?? null,
    input.sourceType, input.sourceId, input.sourceVersion ?? null,
    JSON.stringify(input.location), input.excerpt,
    input.documentType ?? null,
    // Même défaut que dans `job-lock` : le driver refuse un objet `Date` en
    // paramètre et lève ERR_INVALID_ARG_TYPE. L'erreur était rattrapée plus
    // haut et journalisée par champ — aucune preuve n'était enregistrée,
    // sans que rien n'échoue visiblement.
    input.documentDate ? new Date(input.documentDate).toISOString() : null,
    input.provider ?? null, input.model ?? null, input.promptVersion ?? null,
    input.confidence, input.authorityScore,
    input.operationTraceId ?? null, fingerprint,
    input.evidenceOrigin ?? 'TEXT_EXTRACTION',
    input.visualEvidence ? JSON.stringify(input.visualEvidence) : null,
  ];
}

const BASE_COLUMNS = `account_id, asset_id, field_key, value_json, normalized_value,
       source_type, source_id, source_version, source_location, evidence_excerpt,
       document_type, document_date, provider, model, prompt_version,
       confidence, authority_score, status, operation_trace_id, fingerprint,
       evidence_origin, visual_evidence`;
const BASE_VALUES = `$1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9::jsonb,$10,$11,$12::timestamptz,$13,$14,$15,$16,$17,'active',$18,$19,$20,$21::jsonb`;

/**
 * Insère une preuve, ou renvoie l'existante si elle est strictement identique.
 *
 * Sans donnée du contrat enrichi : INSERT historique, octet pour octet.
 * Avec : colonnes 0219 en plus, si elles existent ; sinon repli sur l'INSERT
 * historique — sauf pour une cible équipement/pièce, refusée (elle serait
 * lue comme une preuve du bien parent).
 */
export async function recordEvidence(input: FieldEvidenceInput): Promise<number> {
  const fingerprint = evidenceFingerprint(input);
  const extended = hasCanonicalExtension(input) && await fieldEvidenceCanonicalReady();

  if (!extended) {
    if (isNonAssetTarget(input)) throw new EvidenceSchemaNotReadyError(input.fieldKey);
    // Lot 13 (T3-03) : une preuve RETIRÉE (document détaché puis rattaché de
    // nouveau, revalidation qui confirme) redevient courante quand elle est
    // reproduite à l'identique — cycle de vie SEUL, jamais `status` (T3).
    const reactivation = await fieldEvidenceCanonicalReady()
      ? `, lifecycle_status = 'ACTIVE', superseded_at = NULL, superseded_by_evidence_id = NULL`
      : '';
    const rows = await pgClient.unsafe(
      `INSERT INTO field_evidence (
       ${BASE_COLUMNS}
     ) VALUES (${BASE_VALUES})
     ON CONFLICT (fingerprint) DO UPDATE SET extracted_at = field_evidence.extracted_at${reactivation}
     RETURNING id`,
      baseParams(input, fingerprint) as never[],
    );
    return (rows as unknown as Array<{ id: number }>)[0].id;
  }

  const t = input.target ?? null;
  const rows = await pgClient.unsafe(
    `INSERT INTO field_evidence (
       ${BASE_COLUMNS},
       canonical_key, canonical_unit, raw_value,
       target_type, target_entity_id, target_entity_label, target_confidence,
       semantic_event_type, semantic_event_nature, recurrence,
       projection_origin, projection_rule, analysis_run_id, lifecycle_status
     ) VALUES (${BASE_VALUES},$22,$23,$24,$25,$26,$27,$28,$29,$30,$31::jsonb,$32,$33,$34,'ACTIVE')
     ON CONFLICT (fingerprint) DO UPDATE SET
       -- Même preuve reproduite par une analyse sans identifiant d'analyse :
       -- elle redevient courante (cycle de vie SEUL). \`status\` porte la
       -- décision T3 et n'est JAMAIS modifié ici (revue lot 12, 2c).
       lifecycle_status = 'ACTIVE',
       superseded_at = NULL,
       superseded_by_evidence_id = NULL
     RETURNING id`,
    [
      ...baseParams(input, fingerprint),
      input.canonicalKey ?? null, input.canonicalUnit ?? null, input.rawValue ?? null,
      t?.type ?? null, t?.entityId ?? null, t?.label ?? null, t?.confidence ?? null,
      input.semanticEvent?.type ?? null, input.semanticEvent?.nature ?? null,
      input.recurrence ? JSON.stringify(input.recurrence) : null,
      input.projectionOrigin ?? null, input.projectionRule ?? null, input.analysisRunId ?? null,
    ] as never[],
  );
  return (rows as unknown as Array<{ id: number }>)[0].id;
}

/** Cible demandée à `getActiveEvidence` ; absente = le bien lui-même. */
export interface EvidenceTargetFilter {
  type: Exclude<EvidenceTargetType, 'ASSET'>;
  entityId: number;
}

interface EvidenceRow {
  id: number; accountId: number; assetId: number; fieldKey: string; valueJson: unknown;
  normalizedValue: string | null; sourceType: string; sourceId: number; sourceVersion: number | null;
  sourceLocation: unknown; evidenceExcerpt: string | null; evidenceOrigin: string | null;
  visualEvidence: unknown; documentType: string | null; documentDate: Date | string | null;
  provider: string | null; model: string | null; promptVersion: string | null; confidence: string;
  authorityScore: number; operationTraceId: string | null; status: string; extractedAt: Date | string;
  lifecycleStatus?: string | null;
  projectionRule?: string | null;
}

/**
 * Preuves actives d'un champ, de la plus autoritaire à la moins autoritaire.
 *
 * Filtres (CDC 15 §14.4, T1-04) — appliqués dès que la 0219 est en place :
 *  - cycle de vie ACTIVE (NULL = ligne antérieure à la 0219 = ACTIVE) ;
 *  - cible : par défaut le bien lui-même (`target_type` NULL ou ASSET) ;
 *    avec `opts.target`, l'équipement ou la pièce demandé.
 */
export async function getActiveEvidence(
  accountId: number, assetId: number, fieldKey: string,
  opts: { target?: EvidenceTargetFilter } = {},
): Promise<FieldEvidence[]> {
  const canonical = await fieldEvidenceCanonicalReady();
  if (!canonical && opts.target) return [];

  const params: unknown[] = [accountId, assetId, fieldKey];
  let extra = '';
  if (canonical) {
    extra += ` AND (lifecycle_status IS NULL OR lifecycle_status = 'ACTIVE')`;
    if (opts.target) {
      params.push(opts.target.type, opts.target.entityId);
      extra += ` AND target_type = $4 AND target_entity_id = $5`;
    } else {
      extra += ASSET_LEVEL('');
    }
  }

  // ⚠️ Projection EXPLICITE (jamais `SELECT *` ni `db.select()` sans liste) :
  // la requête reste valide que la 0219 soit appliquée ou non.
  const rows = (await pgClient.unsafe(
    `SELECT id, account_id AS "accountId", asset_id AS "assetId", field_key AS "fieldKey",
            value_json AS "valueJson", normalized_value AS "normalizedValue",
            source_type AS "sourceType", source_id AS "sourceId", source_version AS "sourceVersion",
            source_location AS "sourceLocation", evidence_excerpt AS "evidenceExcerpt",
            evidence_origin AS "evidenceOrigin", visual_evidence AS "visualEvidence",
            document_type AS "documentType", document_date AS "documentDate",
            provider, model, prompt_version AS "promptVersion", confidence,
            authority_score AS "authorityScore", operation_trace_id AS "operationTraceId",
            status, extracted_at AS "extractedAt"${canonical ? `, lifecycle_status AS "lifecycleStatus", projection_rule AS "projectionRule"` : ''}
       FROM field_evidence
      WHERE account_id = $1 AND asset_id = $2 AND field_key = $3 AND status = 'active'${extra}
      ORDER BY authority_score DESC, document_date DESC NULLS FIRST`,
    params as never[],
  )) as unknown as EvidenceRow[];

  // Correspondance explicite colonnes → `FieldEvidence` (les noms diffèrent :
  // `valueJson`, `evidenceExcerpt`, `sourceLocation`). Un renvoi brut avait
  // fait raisonner la réconciliation sur des preuves vides.
  return rows.map((r) => ({
    id: Number(r.id),
    accountId: r.accountId,
    assetId: r.assetId,
    fieldKey: r.fieldKey,
    value: r.valueJson,
    normalizedValue: r.normalizedValue ?? undefined,
    sourceType: r.sourceType as FieldEvidence['sourceType'],
    sourceId: r.sourceId,
    sourceVersion: r.sourceVersion ?? undefined,
    location: (r.sourceLocation ?? {}) as FieldEvidence['location'],
    excerpt: r.evidenceExcerpt ?? null,
    evidenceOrigin: (r.evidenceOrigin ?? 'TEXT_EXTRACTION') as FieldEvidence['evidenceOrigin'],
    visualEvidence: (r.visualEvidence ?? null) as FieldEvidence['visualEvidence'],
    documentType: r.documentType ?? undefined,
    documentDate: r.documentDate ? new Date(r.documentDate) : null,
    provider: r.provider ?? undefined,
    model: r.model ?? undefined,
    promptVersion: r.promptVersion ?? undefined,
    confidence: r.confidence as FieldEvidence['confidence'],
    authorityScore: r.authorityScore,
    operationTraceId: r.operationTraceId ?? undefined,
    status: r.status as FieldEvidence['status'],
    extractedAt: new Date(r.extractedAt),
    lifecycleStatus: (r.lifecycleStatus ?? 'ACTIVE') as FieldEvidence['lifecycleStatus'],
    // Règle de projection (D-M, lot 20 : preuve révisée par T4) — absente avant 0219.
    ...(r.projectionRule ? { projectionRule: r.projectionRule } : {}),
  }));
}

/** Marque des preuves comme dépassées lorsqu'une meilleure preuve est appliquée (décision T3). */
export async function supersedeEvidence(ids: number[], status: EvidenceStatus = 'superseded'): Promise<void> {
  if (ids.length === 0) return;
  await pgClient.unsafe(
    `UPDATE field_evidence SET status = $1 WHERE id = ANY($2::int[])`,
    [status, ids] as never[],
  );
}

// ── Filtre de lecture (CDC 15 §14.4, T1-04) ────────────────────────────────

/**
 * Fragment SQL à ajouter au WHERE d'une lecture de `field_evidence` :
 *  - cycle de vie ACTIVE (NULL = ligne antérieure à la 0219) ;
 *  - avec `assetLevel`, preuves du bien lui-même (sans cible ou cible ASSET) ;
 *    une preuve d'équipement ou de pièce n'est pas une preuve du bien.
 * Chaîne vide si la 0219 n'est pas appliquée (la requête reste valide).
 */
export async function evidenceReadFilter(opts: { alias?: string; assetLevel?: boolean } = {}): Promise<string> {
  if (!(await fieldEvidenceCanonicalReady())) return '';
  const a = opts.alias ? `${opts.alias}.` : '';
  return ` AND (${a}lifecycle_status IS NULL OR ${a}lifecycle_status = 'ACTIVE')`
    + (opts.assetLevel ? ASSET_LEVEL(a) : '');
}

/**
 * Preuve du bien LUI-MÊME (CDC 15 T1-04, lot 13 objectif 5) : sans cible
 * (historique), ou cible ASSET dont l'identifiant est ce bien. Un fait ciblé
 * sur un équipement, une pièce ou un AUTRE bien ne produit jamais de
 * proposition sur ce bien.
 */
function ASSET_LEVEL(a: string): string {
  return ` AND (${a}target_type IS NULL OR (${a}target_type = 'ASSET'`
    + ` AND (${a}target_entity_id IS NULL OR ${a}target_entity_id = ${a}asset_id)))`;
}

// ── Retrait (CDC 15 T3-03 : suppression, détachement, déplacement) ─────────

/** Motifs de retrait, journalisés (le cycle de vie ne porte que la date). */
export type EvidenceWithdrawalReason =
  | 'DOCUMENT_DELETED'
  | 'DOCUMENT_UNLINKED'
  | 'DOCUMENT_MOVED'
  | 'ASSET_DELETED'
  | 'FACT_REVALIDATED';

/**
 * Types de preuve dont `source_id` est un `asset_files.id` : un document, et
 * un lien web (ligne `asset_files` `is_web_link`, analysée avec
 * `sourceIds: [asset_files.id]` — CDC 15 R4, DOD-06).
 */
export const ASSET_FILE_SOURCE_TYPES = ['document', 'web_link'] as const;
export const ASSET_FILE_SOURCE_TYPES_SQL = ASSET_FILE_SOURCE_TYPES.map((t) => `'${t}'`).join(', ');

export interface WithdrawEvidenceInput {
  accountId: number;
  /** Sources `asset_files.id` (preuves `document` ET `web_link`, R4) dont les preuves sont retirées. */
  sourceIds?: number[];
  /** Restreint au bien porteur (détachement / déplacement : retrait sur A seulement). */
  assetId?: number | null;
  /** Restreint à ces champs (revalidation T2 : le champ revalidé seulement). */
  fieldKeys?: string[];
  reason: EvidenceWithdrawalReason;
  /**
   * Statut cible : WITHDRAWN (retrait) par défaut ; SUPERSEDED pour une
   * revalidation T2 (une nouvelle preuve du même document remplace).
   */
  lifecycle?: 'WITHDRAWN' | 'SUPERSEDED';
}

export interface WithdrawEvidenceResult {
  evidenceIds: number[];
  /** Biens porteurs des preuves retirées — à réconcilier (T3). */
  assetIds: number[];
  /** Vrai si rien n'a été écrit (0219 absente). */
  dryRun: boolean;
}

/**
 * Fait passer en WITHDRAWN (ou SUPERSEDED) les preuves ACTIVE d'une ou
 * plusieurs sources, avec la date (`superseded_at` : date de SORTIE de l'état
 * ACTIVE, quel que soit le statut suivant). Aucune ligne supprimée ; `status`
 * (décision T3) intact. Lot 16b-3 : plus de mode observation
 * (`T3_NEGATIVE_RECONCILIATION` supprimé) — le retrait est toujours écrit.
 *
 * Sans 0219 : rien n'est lu ni écrit (résultat vide, `dryRun`).
 */
export async function withdrawEvidence(p: WithdrawEvidenceInput): Promise<WithdrawEvidenceResult> {
  const vide: WithdrawEvidenceResult = { evidenceIds: [], assetIds: [], dryRun: true };
  if ((!p.sourceIds || p.sourceIds.length === 0) && p.assetId == null) return vide;
  if (!(await fieldEvidenceCanonicalReady())) return vide;

  const params: unknown[] = [p.accountId];
  const conds = [`account_id = $1`, `(lifecycle_status IS NULL OR lifecycle_status = 'ACTIVE')`];
  if (p.sourceIds && p.sourceIds.length) {
    params.push(p.sourceIds);
    // `source_id` = asset_files.id : preuves `document` ET `web_link`. Un lien
    // web EST une ligne `asset_files` (`is_web_link`), analysée avec
    // `sourceIds: [asset_files.id]` (adaptateur web, R4) : même espace
    // d'identifiants. Les autres types (agenda, équipement…) restent exclus.
    conds.push(`source_type IN (${ASSET_FILE_SOURCE_TYPES_SQL}) AND source_id = ANY($${params.length}::int[])`);
  }
  if (p.assetId != null) { params.push(p.assetId); conds.push(`asset_id = $${params.length}`); }
  if (p.fieldKeys && p.fieldKeys.length) {
    params.push(p.fieldKeys);
    conds.push(`(field_key = ANY($${params.length}::text[]) OR canonical_key = ANY($${params.length}::text[]))`);
  }
  const where = conds.join(' AND ');

  const rows = (await pgClient.unsafe(
    `UPDATE field_evidence SET lifecycle_status = '${p.lifecycle ?? 'WITHDRAWN'}', superseded_at = now()
      WHERE ${where} RETURNING id, asset_id AS "assetId"`,
    params as never[],
  )) as unknown as Array<{ id: number; assetId: number }>;

  const out: WithdrawEvidenceResult = {
    evidenceIds: rows.map((r) => Number(r.id)),
    assetIds: [...new Set(rows.map((r) => Number(r.assetId)))],
    dryRun: false,
  };
  // Journal structuré (lu par l'exploitation).
  console.info(JSON.stringify({
    event: 't3.evidence_lifecycle', reason: p.reason, lifecycle: p.lifecycle ?? 'WITHDRAWN',
    accountId: p.accountId, sourceIds: p.sourceIds ?? null, assetId: p.assetId ?? null, fieldKeys: p.fieldKeys ?? null,
    evidenceIds: out.evidenceIds, assetIds: out.assetIds, dryRun: out.dryRun,
  }));
  return out;
}

/**
 * Relie des preuves sorties de l'état ACTIVE à leur remplaçante (même
 * source, même champ, même bien, ACTIVE) quand elle existe — revalidation T2.
 */
export async function linkReplacements(accountId: number, evidenceIds: number[]): Promise<number> {
  if (evidenceIds.length === 0 || !(await fieldEvidenceCanonicalReady())) return 0;
  const rows = (await pgClient.unsafe(
    `UPDATE field_evidence o
        SET superseded_by_evidence_id = (
          SELECT n.id FROM field_evidence n
           WHERE n.account_id = o.account_id AND n.source_type = o.source_type AND n.source_id = o.source_id
             AND n.field_key = o.field_key AND n.asset_id = o.asset_id AND n.id <> o.id
             AND (n.lifecycle_status IS NULL OR n.lifecycle_status = 'ACTIVE')
           ORDER BY n.id DESC LIMIT 1)
      WHERE o.account_id = $1 AND o.id = ANY($2::int[]) AND o.lifecycle_status = 'SUPERSEDED'
      RETURNING o.id, o.superseded_by_evidence_id AS "by"`,
    [accountId, evidenceIds] as never[],
  )) as unknown as Array<{ id: number; by: number | null }>;
  return rows.filter((r) => r.by != null).length;
}

// ── Cycle de vie à la réanalyse (CDC 15 §14.4, T3-03) ──────────────────────

export interface SupersedeBySourceInput {
  accountId: number;
  sourceType: FieldEvidenceInput['sourceType'];
  sourceId: number;
  /**
   * Analyse COURANTE. Avec un identifiant, sont remplacées les preuves d'une
   * analyse strictement antérieure (ou sans analyse), et celles du MÊME run
   * absentes de `keepIds` (réanalyse dédupliquée qui réutilise l'identifiant :
   * un fait que le modèle ne reproduit plus ne reste pas actif) — et si une
   * analyse PLUS RÉCENTE a déjà écrit, ce sont les preuves courantes qui
   * cèdent la place (course entre deux analyses de la même source).
   */
  analysisRunId: number | null;
  /** Preuves écrites par l'analyse courante (utile sans identifiant d'analyse). */
  keepIds: number[];
  /**
   * Faux si l'analyse courante n'a pas pu écrire toutes ses preuves : seules
   * les anciennes preuves AYANT une remplaçante sont alors remplacées — une
   * écriture ratée ne doit pas effacer la seule preuve d'un champ.
   */
  complete: boolean;
}

export interface SupersedeBySourceResult {
  superseded: number;
  /** Dont reliées à une nouvelle preuve de même clé/cible. */
  linked: number;
  /** Biens porteurs des preuves remplacées — à réconcilier (T3). */
  assetIds: number[];
}

/** Clé de verrou consultatif (compte, source) — deux entiers 32 bits. */
export const supersedeLockKeys = (accountId: number, sourceId: number): [number, number] => [accountId | 0, sourceId | 0];

/**
 * Fait passer en SUPERSEDED les preuves ACTIVE antérieures d'une source
 * (même compte, même `source_type`/`source_id`).
 *
 *  - SÉRIALISÉ par source : `pg_advisory_xact_lock(compte, source)` dans une
 *    transaction — deux analyses concurrentes ne se remplacent pas en
 *    croisé ; la plus récente (plus grand `analysis_run_id`) gagne toujours ;
 *  - `superseded_at` = maintenant ; `superseded_by_evidence_id` = preuve de
 *    l'analyse retenue, de même champ et même cible EFFECTIVE (une preuve
 *    historique sans cible vaut cible ASSET = son `asset_id`) ;
 *  - `status` (décision T3) n'est JAMAIS modifié : le cycle de vie est porté
 *    par `lifecycle_status` seul, que les lecteurs filtrent
 *    (`evidenceReadFilter`) ;
 *  - aucune ligne supprimée.
 *
 * Exige la 0219 : sans elle, rien n'est modifié et le résultat vaut zéro.
 */
export async function supersedePriorSourceEvidence(p: SupersedeBySourceInput): Promise<SupersedeBySourceResult> {
  const vide = { superseded: 0, linked: 0, assetIds: [] as number[] };
  if (!(await fieldEvidenceCanonicalReady())) return vide;
  const effType = (a: string) => `coalesce(${a}.target_type, 'ASSET')`;
  const effId = (a: string) => `CASE WHEN coalesce(${a}.target_type, 'ASSET') = 'ASSET' THEN coalesce(${a}.target_entity_id, ${a}.asset_id) ELSE ${a}.target_entity_id END`;
  const actif = (a: string) => `(${a}.lifecycle_status IS NULL OR ${a}.lifecycle_status = 'ACTIVE')`;
  const memeSource = (a: string) => `${a}.account_id = $1 AND ${a}.source_type = $2 AND ${a}.source_id = $3`;
  const memeCible = `n.field_key = o.field_key AND ${effType('n')} = ${effType('o')} AND ${effId('n')} IS NOT DISTINCT FROM ${effId('o')}`;

  const avecRun = p.analysisRunId != null;
  // Avec analyse : l'analyse retenue est la plus récente présente (GREATEST
  // ignore NULL) ; tout ce qui est antérieur ou sans analyse est remplacé.
  // Sans analyse : repli sur les preuves écrites (`keepIds`), et seules les
  // preuves SANS analyse sont remplacées (jamais celles d'une analyse datée).
  const sql = avecRun
    ? `WITH retenue AS (
         SELECT GREATEST($4::int, (SELECT max(x.analysis_run_id) FROM field_evidence x WHERE ${memeSource('x')} AND ${actif('x')})) AS run
       ), remplacement AS (
         SELECT o.id AS old_id, r.run,
                (SELECT n.id FROM field_evidence n
                  WHERE ${memeSource('n')} AND ${actif('n')} AND n.analysis_run_id = r.run AND ${memeCible}
                    AND n.id <> o.id
                    -- Analyse courante retenue : seules ses preuves ÉCRITES
                    -- maintenant peuvent remplacer.
                    AND (r.run <> $4::int OR n.id = ANY($6::int[]))
                  ORDER BY n.authority_score DESC, n.id DESC LIMIT 1) AS new_id
           FROM field_evidence o, retenue r
          WHERE ${memeSource('o')} AND ${actif('o')}
            AND (o.analysis_run_id IS NULL OR o.analysis_run_id < r.run
                 -- Réanalyse dédupliquée (même analysis_run_id) : les preuves
                 -- de ce run que l'écriture courante n'a pas reproduites.
                 OR (r.run = $4::int AND o.analysis_run_id = $4::int AND NOT (o.id = ANY($6::int[]))))
       )
       UPDATE field_evidence fe
          SET lifecycle_status = 'SUPERSEDED', superseded_at = now(), superseded_by_evidence_id = rp.new_id
         FROM remplacement rp
        WHERE fe.id = rp.old_id
          AND ($5::boolean OR rp.run > $4::int OR rp.new_id IS NOT NULL)
       RETURNING fe.id, fe.asset_id AS "assetId", rp.new_id AS "newId"`
    : `WITH remplacement AS (
         SELECT o.id AS old_id,
                (SELECT n.id FROM field_evidence n
                  WHERE n.id = ANY($4::int[]) AND ${memeCible}
                  ORDER BY n.authority_score DESC, n.id DESC LIMIT 1) AS new_id
           FROM field_evidence o
          WHERE ${memeSource('o')} AND ${actif('o')}
            AND o.analysis_run_id IS NULL
            AND NOT (o.id = ANY($4::int[]))
       )
       UPDATE field_evidence fe
          SET lifecycle_status = 'SUPERSEDED', superseded_at = now(), superseded_by_evidence_id = rp.new_id
         FROM remplacement rp
        WHERE fe.id = rp.old_id
          AND ($5::boolean OR rp.new_id IS NOT NULL)
       RETURNING fe.id, fe.asset_id AS "assetId", rp.new_id AS "newId"`;

  const [k1, k2] = supersedeLockKeys(p.accountId, p.sourceId);
  let rows: Array<{ id: number; assetId: number; newId: number | null }> = [];
  await pgClient.begin(async (tx) => {
    await tx.unsafe('SELECT pg_advisory_xact_lock($1::int, $2::int)', [k1, k2] as never[]);
    rows = (await tx.unsafe(
      sql,
      (avecRun
        ? [p.accountId, p.sourceType, p.sourceId, p.analysisRunId, p.complete, p.keepIds]
        : [p.accountId, p.sourceType, p.sourceId, p.keepIds, p.complete]) as never[],
    )) as unknown as typeof rows;
  });
  return {
    superseded: rows.length,
    linked: rows.filter((r) => r.newId != null).length,
    assetIds: [...new Set(rows.map((r) => r.assetId))],
  };
}

/**
 * Valeurs des preuves d’un bien sorties de l’état ACTIVE
 * (retirée ou remplacée) — la phase négative T3-04 ne retire que ceux-là, et
 * seulement s’il ne leur reste aucune preuve active (`planRetractions`).
 * Preuves du bien lui-même seulement. Vide sans 0219.
 */
export async function listRetiredEvidenceValues(
  accountId: number, assetId: number,
): Promise<Array<{ fieldKey: string; value: unknown }>> {
  if (!(await fieldEvidenceCanonicalReady())) return [];
  const rows = (await pgClient.unsafe(
    `SELECT DISTINCT field_key AS "fieldKey", value_json AS value FROM field_evidence
      WHERE account_id = $1 AND asset_id = $2
        AND lifecycle_status IN ('WITHDRAWN', 'SUPERSEDED')${ASSET_LEVEL('')}`,
    [accountId, assetId] as never[],
  )) as unknown as Array<{ fieldKey: string; value: unknown }>;
  return rows;
}

/**
 * Revalidation T2 (T2-29, relecture lot 13) : les preuves ACTIVE d'un champ,
 * pour un document et un bien, dont la valeur normalisée DIFFÈRE de
 * `keepValue` passent SUPERSEDED, reliées à la preuve de la valeur
 * revalidée — SEULEMENT si cette remplaçante existe (sinon rien : la
 * projection n'a pas abouti).
 */
export async function supersedeFieldEvidenceExcept(p: {
  accountId: number; sourceId: number; assetId: number; fieldKeys: string[]; keepValue: unknown;
}): Promise<{ superseded: number; replacementId: number | null }> {
  if (!(await fieldEvidenceCanonicalReady())) return { superseded: 0, replacementId: null };
  const { normalize } = await import('../reconciliation/decision/normalizers');
  const rows = (await pgClient.unsafe(
    `SELECT id, field_key AS "fieldKey", value_json AS value FROM field_evidence
      WHERE account_id = $1 AND source_type IN (${ASSET_FILE_SOURCE_TYPES_SQL}) AND source_id = $2 AND asset_id = $3
        AND (field_key = ANY($4::text[]) OR canonical_key = ANY($4::text[]))
        AND (lifecycle_status IS NULL OR lifecycle_status = 'ACTIVE')
      ORDER BY id DESC`,
    [p.accountId, p.sourceId, p.assetId, p.fieldKeys] as never[],
  )) as unknown as Array<{ id: number; fieldKey: string; value: unknown }>;
  const cle = p.fieldKeys[p.fieldKeys.length - 1];
  const cible = normalize(cle, p.keepValue);
  const remplacante = rows.find((r) => cible !== null && normalize(cle, r.value) === cible);
  if (!remplacante) return { superseded: 0, replacementId: null };
  const anciennes = rows.filter((r) => r.id !== remplacante.id && normalize(cle, r.value) !== cible).map((r) => Number(r.id));
  console.info(JSON.stringify({
    event: 't3.evidence_lifecycle', reason: 'FACT_REVALIDATED', lifecycle: 'SUPERSEDED',
    accountId: p.accountId, sourceIds: [p.sourceId], assetId: p.assetId, fieldKeys: p.fieldKeys,
    evidenceIds: anciennes, replacementId: Number(remplacante.id),
  }));
  if (anciennes.length === 0) return { superseded: 0, replacementId: Number(remplacante.id) };
  const upd = (await pgClient.unsafe(
    `UPDATE field_evidence SET lifecycle_status = 'SUPERSEDED', superseded_at = now(), superseded_by_evidence_id = $3
      WHERE account_id = $1 AND id = ANY($2::int[]) AND (lifecycle_status IS NULL OR lifecycle_status = 'ACTIVE')
      RETURNING id`,
    [p.accountId, anciennes, Number(remplacante.id)] as never[],
  )) as unknown as unknown[];
  return { superseded: upd.length, replacementId: Number(remplacante.id) };
}

/** Biens portant au moins une preuve ACTIVE d'un document ou d'un lien web (asset_files.id). Vide sans 0219. */
export async function listActiveEvidenceAssets(accountId: number, sourceId: number): Promise<number[]> {
  if (!(await fieldEvidenceCanonicalReady())) return [];
  const rows = (await pgClient.unsafe(
    `SELECT DISTINCT asset_id AS "assetId" FROM field_evidence
      WHERE account_id = $1 AND source_type IN (${ASSET_FILE_SOURCE_TYPES_SQL}) AND source_id = $2
        AND (lifecycle_status IS NULL OR lifecycle_status = 'ACTIVE')`,
    [accountId, sourceId] as never[],
  )) as unknown as Array<{ assetId: number }>;
  return rows.map((r) => Number(r.assetId));
}
