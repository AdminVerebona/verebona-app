/**
 * DocumentTitleService — titre MÉTIER des documents, commun à T1 et T3
 * (lot 33C, ticket « T1/T3 : garantir le renommage métier des documents »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL COMPOSANT, DEUX APPELANTS
 *
 *   · T1, en fin d'analyse (`pipeline.ts`, après persistance du run et de la
 *     base de connaissance) : mode `refresh` — le titre système est
 *     (re)construit depuis l'analyse, comme avant le lot 33C ;
 *   · T3, rattrapage horaire paginé (`document-title-sweep.ts`) et contrôle
 *     ciblé après une nouvelle connaissance T3 (document → bien, fait →
 *     équipement) : mode `repair`, depuis les données PERSISTÉES (run T1 de
 *     référence, sinon représentation durable, sinon colonnes du document)
 *     et l'état actuel du compte. Jamais d'OCR, d'extraction ni d'appel T1.
 *
 * Les deux passent par `ensureBusinessTitle` → `buildTitle` (règles
 * EXISTANTES de `document-title.ts`, inchangées) → `persistTitle`.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * GARANTIES
 *
 *   · `title_source = 'USER'` : jamais écrasé (lu au départ ET re-vérifié
 *     dans le UPDATE) ;
 *   · contrôle de concurrence : le UPDATE n'aboutit que si le titre et sa
 *     source sont ceux LUS (compare-and-set) — un renommage utilisateur entre
 *     la lecture et l'écriture gagne toujours ;
 *   · idempotence : titre valide (ou identique au titre reconstruit) → aucune
 *     écriture, aucun `updated_at`, aucun événement ;
 *   · données insuffisantes : `title_checked_at` posé (sans `updated_at`) —
 *     le balayage ne reprend le document qu'après une NOUVELLE analyse ;
 *   · le fichier stocké n'est jamais renommé (clé objet, `filename`,
 *     identifiants inchangés) : seul `retained_title` change.
 *
 * Observabilité : `document_title_events` (UPDATED, SKIP_USER_TITLE sur titre
 * non conforme, INSUFFICIENT_DATA, NO_CHANGE après un changement de contexte,
 * FAILED — origine T1/T3, ancien et nouveau titre, raison, version des règles,
 * empreinte du contexte, motif de déclenchement, date) + une ligne de journal
 * par issue. Un NO_CHANGE sur contexte inchangé n'est jamais écrit.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 34E — MOTEUR v2 (ticket « refondre le moteur de titre »)
 *
 *   · contexte ENRICHI depuis l'état ACTUEL du compte (`loadTitleAccountContext`) :
 *     bien rattaché, équipement / pièce identifié, période métier des faits,
 *     référence, nombre de biens, titres SYSTEM similaires — pour T1 comme
 *     pour T3 (T1 ne fait jamais confiance aveuglément au titre du modèle) ;
 *   · mode `repair` SANS « SKIP_VALID_TITLE » : contexte chargé → titre actuel
 *     évalué (`evaluateBusinessTitle`) → meilleur candidat construit
 *     (`planBusinessTitle`) → comparaison (`shouldReplaceSystemTitle`) ;
 *     issues NO_CHANGE | UPDATED | SKIP_USER_TITLE | INSUFFICIENT_DATA | FAILED ;
 *   · `title_rule_version` + `title_context_fingerprint` (0293) : même version
 *     et même empreinte → aucun retraitement, aucune écriture ; version
 *     inférieure → rattrapage automatique de TOUT l'existant SYSTEM.
 * ══════════════════════════════════════════════════════════════════════════
 */
import {
  DOCUMENT_TITLE_RULE_VERSION, evaluateBusinessTitle, isValidBusinessTitle, shouldReplaceSystemTitle,
  type TitleEvaluation, type TitleIdentifiers,
} from '@/lib/documents/document-title-rules';
import {
  planBusinessTitle, titleContextFingerprint, titleInputsFromAnalysis, type TitleContext, type TitleInputs, type TitlePlan,
} from '@/services/ai/source-analysis/document-title';
import { isExecutionCancelled, type ExecutionGuard } from '@/services/ai/queue/execution-control';

export type TitleOrigin = 'T1' | 'T3';
export type TitleMode = 'refresh' | 'repair';
export type TitleOutcome = 'UPDATED' | 'NO_CHANGE' | 'SKIP_USER_TITLE' | 'INSUFFICIENT_DATA' | 'FAILED';
export type TitleSource = 'SYSTEM' | 'USER';
/** Pourquoi le titre est (re)contrôlé (journal). */
export type TitleTrigger = 'RULE_VERSION_UPGRADE' | 'CONTEXT_CHANGED' | 'NEW_ANALYSIS';

export interface EnsureTitleResult {
  fileId: number;
  origin: TitleOrigin;
  outcome: TitleOutcome;
  reason: string | null;
  oldTitle: string | null;
  newTitle: string | null;
  /** Qualité du titre en place (lot 34E), quand elle a été évaluée. */
  evaluation?: TitleEvaluation;
  trigger?: TitleTrigger | null;
  contextFingerprint?: string | null;
}

interface TitleRow {
  id: number;
  account_id: number;
  retained_title: string | null;
  title_source: string | null;
  s3_key: string | null;
  public_id: string | null;
  document_type: string | null;
  supplier: string | null;
  document_date: string | null;
  last_analysis_at: Date | null;
  original_filename: string | null;
  filename: string | null;
  title_rule_version: number | null;
  title_context_fingerprint: string | null;
  title_checked_at: Date | null;
  /** Marque historique du tiroir (`user_edited_fields.retainedTitle`). */
  legacy_user_edit: boolean | null;
}

type Sql = typeof import('@/db').pgClient;
const sqlClient = async (): Promise<Sql> => (await import('@/db')).pgClient;

const idsOf = (r: Pick<TitleRow, 's3_key' | 'public_id'>): TitleIdentifiers => ({ s3Key: r.s3_key, publicId: r.public_id });

async function readRow(sql: Sql, fileId: number, accountId: number): Promise<TitleRow | null> {
  const rows = (await sql.unsafe(
    `SELECT id, account_id, retained_title, title_source, s3_key, public_id::text AS public_id,
            document_type, supplier, to_char(document_date, 'YYYY-MM-DD') AS document_date, last_analysis_at,
            original_filename, filename, title_rule_version, title_context_fingerprint, title_checked_at,
            COALESCE((user_edited_fields ->> 'retainedTitle') = 'true', false) AS legacy_user_edit
       FROM asset_files
      WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`,
    [fileId, accountId] as never[],
  )) as unknown as TitleRow[];
  return rows[0] ?? null;
}

/**
 * Meilleur titre métier constructible (moteur v2, `planBusinessTitle`), ou
 * `null` si les données ne suffisent pas à produire un titre conforme.
 */
export function buildTitle(inputs: TitleInputs | null, ids: TitleIdentifiers = {}): string | null {
  if (!inputs) return null;
  const t = planBusinessTitle(inputs.modelTitle, inputs.ctx).title?.trim() ?? null;
  return t && isValidBusinessTitle(t, ids) ? t : null;
}

/**
 * Entrées du titre relues des données PERSISTÉES (aucune analyse relancée) :
 *   1. run T1 de référence (`document_analysis_runs.raw_response_json`) —
 *      exactement les champs que T1 utilise ;
 *   2. sinon représentation durable (`document_extractions`, faits) ;
 *   3. sinon colonnes du document (type, fournisseur, date), si une analyse
 *      a eu lieu.
 * Le contexte du COMPTE (bien, équipement, période, titres similaires) est
 * ajouté par `loadTitleAccountContext`.
 */
export async function loadPersistedTitleInputs(fileId: number, accountId: number, row?: TitleRow | null): Promise<TitleInputs | null> {
  const sql = await sqlClient();
  const [runs, ext] = await Promise.all([
    sql.unsafe(
      `SELECT raw_response_json AS raw FROM document_analysis_runs
        WHERE asset_file_id = $1 AND account_id = $2 AND status = 'completed' AND raw_response_json IS NOT NULL
        ORDER BY is_current_reference DESC, id DESC LIMIT 1`,
      [fileId, accountId] as never[],
    ) as unknown as Promise<Array<{ raw: string }>>,
    sql.unsafe(
      `SELECT e.title, e.supplier_name, to_char(e.document_date, 'YYYY-MM-DD') AS document_date,
              COALESCE(e.metadata ->> 'legacyDocumentType', e.document_type_code) AS type_code,
              COALESCE((SELECT array_agg(s.subject ORDER BY s.id) FROM (
                 SELECT id, subject FROM document_facts
                  WHERE file_id = e.file_id AND extraction_id = e.id AND subject IS NOT NULL AND status = 'active'
                  ORDER BY id LIMIT 50) s), '{}') AS subjects
         FROM document_extractions e
        WHERE e.file_id = $1 AND e.account_id = $2`,
      [fileId, accountId] as never[],
    ) as unknown as Promise<Array<{ title: string | null; supplier_name: string | null; document_date: string | null; type_code: string | null; subjects: string[] }>>,
  ]);
  const e = ext[0];
  if (runs[0]?.raw) {
    try {
      const parsed = JSON.parse(runs[0].raw) as Parameters<typeof titleInputsFromAnalysis>[0];
      if (parsed && typeof parsed === 'object' && parsed.document) {
        const inputs = titleInputsFromAnalysis(parsed);
        // Données structurées durables en complément (type, fournisseur, date).
        return {
          modelTitle: inputs.modelTitle ?? e?.title ?? null,
          ctx: {
            ...inputs.ctx,
            typeCode: inputs.ctx.typeCode ?? e?.type_code ?? null,
            supplier: inputs.ctx.supplier ?? e?.supplier_name ?? null,
            documentDate: inputs.ctx.documentDate ?? e?.document_date ?? null,
            subjects: inputs.ctx.subjects?.length ? inputs.ctx.subjects : (e?.subjects ?? []).filter((s) => typeof s === 'string' && s.length > 0),
          },
        };
      }
    } catch {
      // Run illisible : on se replie sur la représentation durable.
    }
  }
  const r = row === undefined ? await readRow(sql, fileId, accountId) : row;
  if (e) {
    return {
      modelTitle: e.title,
      ctx: {
        typeCode: e.type_code ?? r?.document_type ?? null,
        subjects: (e.subjects ?? []).filter((s) => typeof s === 'string' && s.length > 0),
        supplier: e.supplier_name ?? r?.supplier ?? null,
        documentDate: e.document_date ?? r?.document_date ?? null,
      },
    };
  }
  if (r && r.last_analysis_at) {
    return { modelTitle: null, ctx: { typeCode: r.document_type, subjects: [], supplier: r.supplier, documentDate: r.document_date } };
  }
  return null;
}

/**
 * Entrées en mémoire (T1) complétées par la représentation durable qui vient
 * d'être persistée (type documentaire, sujets, fournisseur, date) : le titre
 * ne dépend pas de la forme exacte du résultat du modèle (pure).
 */
export function withPersistedGaps(inputs: TitleInputs, persisted: TitleInputs | null): TitleInputs {
  if (!persisted) return inputs;
  const c = inputs.ctx;
  const d = persisted.ctx;
  return {
    modelTitle: inputs.modelTitle ?? persisted.modelTitle,
    ctx: {
      ...c,
      typeCode: c.typeCode ?? d.typeCode ?? null,
      subjects: c.subjects?.length ? c.subjects : d.subjects ?? [],
      supplier: c.supplier ?? d.supplier ?? null,
      documentDate: c.documentDate ?? d.documentDate ?? null,
    },
  };
}

/** Clés de faits portant une référence utile (dernier recours d'un doublon). */
const REFERENCE_FACT_KEYS = ['contractNumber', 'insuranceContractNumber', 'dpeAdemeNumber'];

/**
 * Contexte du titre lu dans l'état ACTUEL du compte (borné, aucune analyse) :
 * bien rattaché, équipement / pièce identifié (lien actif ou cible d'un fait,
 * seulement s'il est UNIQUE), période métier des faits, référence, nombre de
 * biens du compte.
 */
export async function loadTitleAccountContext(fileId: number, accountId: number): Promise<Partial<TitleContext>> {
  const sql = await sqlClient();
  const [base, equipements, pieces, periode, reference] = await Promise.all([
    sql.unsafe(
      `SELECT (SELECT count(*)::int FROM assets a WHERE a.account_id = f.account_id AND a.deleted_at IS NULL) AS asset_count,
              pa.id AS asset_id, pa.name AS asset_name
         FROM asset_files f
         LEFT JOIN LATERAL (
           SELECT a.id, a.name FROM assets a
            WHERE a.account_id = f.account_id AND a.deleted_at IS NULL
              AND a.id = COALESCE(f.asset_id, f.linked_asset_id,
                    (SELECT l.asset_id FROM document_asset_links l
                      WHERE l.file_id = f.id AND l.status = 'ACTIVE' AND l.link_role = 'PRIMARY' AND l.asset_id IS NOT NULL
                      ORDER BY l.id LIMIT 1))) pa ON true
        WHERE f.id = $1 AND f.account_id = $2`,
      [fileId, accountId] as never[],
    ) as unknown as Promise<Array<{ asset_count: number; asset_id: number | null; asset_name: string | null }>>,
    sql.unsafe(
      `SELECT DISTINCT x.id, x.name FROM equipments x
         JOIN assets a ON a.id = x.asset_id AND a.account_id = $2 AND a.deleted_at IS NULL
        WHERE x.archived_at IS NULL AND x.id IN (
          SELECT l.equipment_id FROM document_asset_links l WHERE l.file_id = $1 AND l.status = 'ACTIVE' AND l.equipment_id IS NOT NULL
          UNION SELECT d.target_entity_id FROM document_facts d
                 WHERE d.file_id = $1 AND d.status = 'active' AND d.target_type = 'EQUIPMENT' AND d.target_entity_id IS NOT NULL)
        ORDER BY x.id LIMIT 2`,
      [fileId, accountId] as never[],
    ).catch(() => []) as unknown as Promise<Array<{ id: number; name: string }>>,
    sql.unsafe(
      `SELECT DISTINCT x.id, x.name FROM substructures x
         JOIN assets a ON a.id = x.asset_id AND a.account_id = $2 AND a.deleted_at IS NULL
        WHERE x.id IN (
          SELECT l.substructure_id FROM document_asset_links l WHERE l.file_id = $1 AND l.status = 'ACTIVE' AND l.substructure_id IS NOT NULL
          UNION SELECT d.target_entity_id FROM document_facts d
                 WHERE d.file_id = $1 AND d.status = 'active' AND d.target_type = 'ROOM' AND d.target_entity_id IS NOT NULL)
        ORDER BY x.id LIMIT 2`,
      [fileId, accountId] as never[],
    ).catch(() => []) as unknown as Promise<Array<{ id: number; name: string }>>,
    sql.unsafe(
      `SELECT to_char(period_start, 'YYYY-MM-DD') AS s, to_char(period_end, 'YYYY-MM-DD') AS e FROM document_facts
        WHERE file_id = $1 AND account_id = $2 AND status = 'active' AND (period_start IS NOT NULL OR period_end IS NOT NULL)
        ORDER BY (period_start IS NOT NULL AND period_end IS NOT NULL) DESC, id LIMIT 1`,
      [fileId, accountId] as never[],
    ) as unknown as Promise<Array<{ s: string | null; e: string | null }>>,
    sql.unsafe(
      `SELECT COALESCE(normalized_value, value_text) AS v FROM document_facts
        WHERE file_id = $1 AND account_id = $2 AND status = 'active' AND canonical_key = ANY($3::text[])
          AND COALESCE(normalized_value, value_text) IS NOT NULL
        ORDER BY id LIMIT 1`,
      [fileId, accountId, REFERENCE_FACT_KEYS] as never[],
    ).catch(() => []) as unknown as Promise<Array<{ v: string }>>,
  ]);
  const b = base[0];
  return {
    accountAssetCount: b ? Number(b.asset_count) : null,
    asset: b?.asset_id ? { id: Number(b.asset_id), name: String(b.asset_name) } : null,
    // Un SEUL équipement / une seule pièce identifié : sinon, ambigu, rien.
    equipment: equipements.length === 1 ? { id: Number(equipements[0].id), name: equipements[0].name } : null,
    room: equipements.length === 0 && pieces.length === 1 ? { id: Number(pieces[0].id), name: pieces[0].name } : null,
    period: periode[0] ? { start: periode[0].s, end: periode[0].e } : null,
    reference: reference[0]?.v ? String(reference[0].v).slice(0, 40) : null,
  };
}

/** Titres SYSTEM d'autres documents du compte commençant comme `title` (bornés). */
async function loadSimilarTitles(fileId: number, accountId: number, title: string): Promise<string[]> {
  const premier = title.trim().split(/\s+/)[0]?.replace(/[\\%_]/g, (c) => `\\${c}`);
  if (!premier) return [];
  const sql = await sqlClient();
  const rows = (await sql.unsafe(
    `SELECT retained_title FROM asset_files
      WHERE account_id = $1 AND id <> $2 AND deleted_at IS NULL AND title_source = 'SYSTEM'
        AND retained_title ILIKE $3 || '%'
      ORDER BY id DESC LIMIT 50`,
    [accountId, fileId, premier] as never[],
  )) as unknown as Array<{ retained_title: string | null }>;
  return rows.map((r) => r.retained_title).filter((t): t is string => !!t);
}

/** Plan du titre (meilleur candidat + attentes + empreinte), titres similaires compris. */
export async function planTitleForDocument(fileId: number, accountId: number, inputs: TitleInputs): Promise<{ plan: TitlePlan; fingerprint: string }> {
  const ctx: TitleContext = { ...inputs.ctx, ...(await loadTitleAccountContext(fileId, accountId)) };
  let plan = planBusinessTitle(inputs.modelTitle, ctx);
  if (plan.title) {
    const similaires = await loadSimilarTitles(fileId, accountId, plan.title);
    if (similaires.length) plan = planBusinessTitle(inputs.modelTitle, { ...ctx, similarTitles: similaires });
  }
  return { plan, fingerprint: titleContextFingerprint(plan) };
}

/**
 * Écrit un titre SYSTÈME sous contrôle de concurrence : n'aboutit que si le
 * document a toujours le titre `expectedTitle` et la source SYSTEM. Retire
 * la marque historique `user_edited_fields.retainedTitle` (la source du titre
 * fait foi). Rend `true` si la ligne a été modifiée.
 */
export async function persistTitle(p: {
  fileId: number; accountId: number; expectedTitle: string | null; newTitle: string;
  contextFingerprint?: string | null; ruleVersion?: number;
}): Promise<boolean> {
  const sql = await sqlClient();
  const rows = (await sql.unsafe(
    `UPDATE asset_files
        SET retained_title = $3, title_source = 'SYSTEM', title_checked_at = now(), updated_at = now(),
            title_rule_version = $5::int, title_context_fingerprint = $6,
            user_edited_fields = CASE WHEN user_edited_fields ? 'retainedTitle'
                                      THEN user_edited_fields - 'retainedTitle' ELSE user_edited_fields END
      WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL
        AND title_source = 'SYSTEM'
        AND retained_title IS NOT DISTINCT FROM $4::text
      RETURNING id`,
    [p.fileId, p.accountId, p.newTitle, p.expectedTitle, p.ruleVersion ?? DOCUMENT_TITLE_RULE_VERSION, p.contextFingerprint ?? null] as never[],
  )) as unknown as Array<{ id: number }>;
  return rows.length > 0;
}

/**
 * Contrôle enregistré SANS renommage (version des règles et empreinte du
 * contexte) : jamais `updated_at`. N'écrit que si l'une des deux change —
 * un second contrôle identique n'écrit rien. Rend `true` si écrit.
 */
async function stampChecked(fileId: number, accountId: number, fingerprint: string | null): Promise<boolean> {
  const sql = await sqlClient();
  const rows = (await sql.unsafe(
    `UPDATE asset_files SET title_checked_at = now(), title_rule_version = $3::int, title_context_fingerprint = $4
      WHERE id = $1 AND account_id = $2
        AND (title_rule_version IS DISTINCT FROM $3::int OR title_context_fingerprint IS DISTINCT FROM $4 OR title_checked_at IS NULL)
      RETURNING id`,
    [fileId, accountId, DOCUMENT_TITLE_RULE_VERSION, fingerprint] as never[],
  )) as unknown as unknown[];
  return rows.length > 0;
}

/** Événement d'observabilité (ne lève jamais). */
async function trace(accountId: number, r: EnsureTitleResult, persist: boolean): Promise<void> {
  const ligne = `[document-title] ${r.origin} fichier ${r.fileId} : ${r.outcome}${r.reason ? ` (${r.reason})` : ''}`
    + (r.trigger ? ` [${r.trigger}]` : '')
    + (r.outcome === 'UPDATED' ? ` « ${r.oldTitle ?? ''} » → « ${r.newTitle ?? ''} »` : '');
  if (r.outcome === 'FAILED') console.error(ligne);
  else if (r.outcome !== 'NO_CHANGE' || persist) console.info(ligne);
  if (!persist) return;
  try {
    const sql = await sqlClient();
    await sql.unsafe(
      `INSERT INTO document_title_events (account_id, file_id, origin, outcome, reason, old_title, new_title,
                                          rule_version, context_fingerprint, trigger_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [accountId, r.fileId, r.origin, r.outcome, r.reason, r.oldTitle, r.newTitle,
       DOCUMENT_TITLE_RULE_VERSION, r.contextFingerprint ?? null, r.trigger ?? null] as never[],
    );
  } catch (e) {
    console.error(`[document-title] événement non journalisé (fichier ${r.fileId}) :`, (e as Error).message);
  }
}

/**
 * Contrôle et, si le candidat est RÉELLEMENT meilleur, persiste le titre
 * métier d'un document. Ne lève jamais (sauf interruption de l'exécution
 * par `guard`) : une erreur rend FAILED.
 *
 * `inputs` : entrées déjà en mémoire (T1, résultat de l'analyse qui vient
 * d'être persistée) ; absentes → relues des données persistées (T3).
 * `trigger` : motif explicite (défaut : déduit — version des règles,
 * nouvelle analyse, contexte modifié).
 */
export async function ensureBusinessTitle(p: {
  fileId: number;
  accountId: number;
  origin: TitleOrigin;
  mode: TitleMode;
  inputs?: TitleInputs | null;
  guard?: ExecutionGuard;
  trigger?: TitleTrigger;
}): Promise<EnsureTitleResult> {
  const base = { fileId: p.fileId, origin: p.origin };
  let oldTitle: string | null = null;
  let trigger: TitleTrigger | null = p.trigger ?? null;
  let fingerprint: string | null = null;
  try {
    const sql = await sqlClient();
    const row = await readRow(sql, p.fileId, p.accountId);
    if (!row) {
      return { ...base, outcome: 'INSUFFICIENT_DATA', reason: 'DOCUMENT_GONE', oldTitle: null, newTitle: null };
    }
    oldTitle = row.retained_title;
    const ids = idsOf(row);
    const valide = isValidBusinessTitle(row.retained_title, ids);
    trigger = trigger ?? (row.title_rule_version !== DOCUMENT_TITLE_RULE_VERSION ? 'RULE_VERSION_UPGRADE'
      : p.origin === 'T1' ? 'NEW_ANALYSIS' : 'CONTEXT_CHANGED');
    const fin = async (outcome: TitleOutcome, reason: string | null, newTitle: string | null, persist: boolean, evaluation?: TitleEvaluation) => {
      const r: EnsureTitleResult = { ...base, outcome, reason, oldTitle, newTitle, trigger, contextFingerprint: fingerprint, ...(evaluation ? { evaluation } : {}) };
      await trace(p.accountId, r, persist);
      return r;
    };

    // Reprise de l'historique (règle prudente de la 0282, appliquée ici avec
    // la règle exacte) : titre marqué « modifié » par le tiroir avant le lot
    // 33C ET conforme → titre utilisateur, promu USER sans autre écriture.
    // Marqué mais TECHNIQUE (« <uuid>.pdf » réenregistré par le tiroir) →
    // reste SYSTEM, donc réparable.
    if (row.title_source !== 'USER' && row.legacy_user_edit && valide) {
      await p.guard?.assertActive('titre du document — reprise d\'un titre utilisateur');
      await sql.unsafe(
        `UPDATE asset_files SET title_source = 'USER'
          WHERE id = $1 AND account_id = $2 AND title_source = 'SYSTEM' AND retained_title IS NOT DISTINCT FROM $3::text`,
        [p.fileId, p.accountId, row.retained_title] as never[],
      );
      return fin('SKIP_USER_TITLE', 'LEGACY_USER_EDIT', null, false);
    }
    // Titre utilisateur : jamais touché (T1, T3, sweep, rattachement).
    if (row.title_source === 'USER') return fin('SKIP_USER_TITLE', 'USER_TITLE_PROTECTED', null, !valide);

    const inputs = p.inputs !== undefined && p.inputs !== null
      ? withPersistedGaps(p.inputs, await loadPersistedTitleInputs(p.fileId, p.accountId, row))
      : await loadPersistedTitleInputs(p.fileId, p.accountId, row);
    if (!inputs) {
      await p.guard?.assertActive('titre du document — données insuffisantes');
      // Empreinte sentinelle : repris seulement si le contexte change (nouvelle analyse…).
      const ecrit = await stampChecked(p.fileId, p.accountId, 'NO_ANALYSIS_DATA');
      return fin(valide ? 'NO_CHANGE' : 'INSUFFICIENT_DATA', valide ? 'NO_BETTER_TITLE' : 'NO_ANALYSIS_DATA', null, !valide && ecrit);
    }
    const { plan, fingerprint: fp } = await planTitleForDocument(p.fileId, p.accountId, inputs);
    fingerprint = fp;
    // Même version des règles, même contexte, titre en place conforme et déjà
    // contrôlé : aucun retraitement, aucune écriture.
    if (p.mode === 'repair' && row.title_rule_version === DOCUMENT_TITLE_RULE_VERSION && row.title_context_fingerprint === fp
      && valide && row.title_checked_at !== null) {
      return fin('NO_CHANGE', null, null, false);
    }
    const evaluation = evaluateBusinessTitle(row.retained_title, plan.expectations, ids);
    const candidat = plan.title && isValidBusinessTitle(plan.title, ids) ? plan.title.trim() : null;
    const contexteModifie = row.title_context_fingerprint != null && row.title_context_fingerprint !== fp;

    if (!candidat) {
      await p.guard?.assertActive('titre du document — données insuffisantes');
      const ecrit = await stampChecked(p.fileId, p.accountId, fp);
      if (valide) return fin('NO_CHANGE', 'NO_BETTER_TITLE', null, ecrit && contexteModifie, evaluation);
      return fin('INSUFFICIENT_DATA', 'NO_TITLE_FROM_DATA', null, ecrit, evaluation);
    }

    // Premier titrage : titre encore égal au nom du fichier déposé.
    const premier = row.title_rule_version == null && row.title_context_fingerprint == null
      && !!row.retained_title && [row.original_filename, row.filename].some((n) => n && n.trim() === row.retained_title!.trim());
    const decision = premier && valide && candidat !== row.retained_title?.trim()
      ? { replace: true, reason: 'FIRST_TITLE' as const }
      : shouldReplaceSystemTitle(row.retained_title, candidat, plan.expectations, ids);
    if (!decision.replace) {
      await p.guard?.assertActive('titre du document — contrôle');
      const ecrit = await stampChecked(p.fileId, p.accountId, fp);
      return fin('NO_CHANGE', 'NO_BETTER_TITLE', null, ecrit && contexteModifie, evaluation);
    }

    await p.guard?.assertActive('titre du document');
    if (await persistTitle({ fileId: p.fileId, accountId: p.accountId, expectedTitle: row.retained_title, newTitle: candidat, contextFingerprint: fp })) {
      return fin('UPDATED', decision.reason, candidat, true, evaluation);
    }
    // Le document a changé entre la lecture et l'écriture.
    const apres = await readRow(sql, p.fileId, p.accountId);
    if (apres?.title_source === 'USER') return fin('SKIP_USER_TITLE', 'CONCURRENT_USER_RENAME', null, true);
    if (!apres || isValidBusinessTitle(apres.retained_title, idsOf(apres))) {
      oldTitle = apres?.retained_title ?? oldTitle;
      return fin('NO_CHANGE', 'CONCURRENT_UPDATE', null, false);
    }
    return fin('FAILED', 'CONCURRENT_UPDATE', candidat, true);
  } catch (e) {
    if (isExecutionCancelled(e)) throw e;
    const r: EnsureTitleResult = { ...base, outcome: 'FAILED', reason: ((e as Error).message ?? 'ERROR').slice(0, 300), oldTitle, newTitle: null, trigger, contextFingerprint: fingerprint };
    await trace(p.accountId, r, true);
    return r;
  }
}

/** Service commun T1 / T3 (AC4) : une seule implémentation. */
export const DocumentTitleService = {
  isValidBusinessTitle,
  evaluateBusinessTitle,
  shouldReplaceSystemTitle,
  buildTitle,
  loadPersistedTitleInputs,
  loadTitleAccountContext,
  planTitleForDocument,
  persistTitle,
  ensureBusinessTitle,
} as const;
