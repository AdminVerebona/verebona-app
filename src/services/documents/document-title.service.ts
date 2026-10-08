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
 *   · T3, rattrapage horaire paginé (`document-title-sweep.ts`) : mode
 *     `repair` — seul un titre NON conforme est reconstruit, depuis les
 *     données PERSISTÉES (run T1 de référence, sinon représentation durable,
 *     sinon colonnes du document). Jamais d'OCR, d'extraction ni d'appel T1.
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
 * non conforme, SKIP_INSUFFICIENT_DATA, FAILED — origine T1/T3, ancien et
 * nouveau titre, raison, date) + une ligne de journal par issue.
 * SKIP_VALID_TITLE n'est jamais écrit en base (pas d'événement parasite).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { isValidBusinessTitle, type TitleIdentifiers } from '@/lib/documents/document-title-rules';
import { refineDocumentTitle, titleInputsFromAnalysis, type TitleInputs } from '@/services/ai/source-analysis/document-title';
import { isExecutionCancelled, type ExecutionGuard } from '@/services/ai/queue/execution-control';

export type TitleOrigin = 'T1' | 'T3';
export type TitleMode = 'refresh' | 'repair';
export type TitleOutcome = 'UPDATED' | 'SKIP_VALID_TITLE' | 'SKIP_USER_TITLE' | 'SKIP_INSUFFICIENT_DATA' | 'FAILED';
export type TitleSource = 'SYSTEM' | 'USER';

export interface EnsureTitleResult {
  fileId: number;
  origin: TitleOrigin;
  outcome: TitleOutcome;
  reason: string | null;
  oldTitle: string | null;
  newTitle: string | null;
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
            COALESCE((user_edited_fields ->> 'retainedTitle') = 'true', false) AS legacy_user_edit
       FROM asset_files
      WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`,
    [fileId, accountId] as never[],
  )) as unknown as TitleRow[];
  return rows[0] ?? null;
}

/**
 * Titre métier construit avec les règles EXISTANTES (`refineDocumentTitle`),
 * ou `null` si les données ne suffisent pas à produire un titre conforme.
 */
export function buildTitle(inputs: TitleInputs | null, ids: TitleIdentifiers = {}): string | null {
  if (!inputs) return null;
  const t = refineDocumentTitle(inputs.modelTitle, inputs.ctx)?.trim() ?? null;
  return t && isValidBusinessTitle(t, ids) ? t : null;
}

/**
 * Entrées du titre relues des données PERSISTÉES (aucune analyse relancée) :
 *   1. run T1 de référence (`document_analysis_runs.raw_response_json`) —
 *      exactement les champs que T1 utilise ;
 *   2. sinon représentation durable (`document_extractions`, faits) ;
 *   3. sinon colonnes du document (type, fournisseur, date), si une analyse
 *      a eu lieu.
 */
export async function loadPersistedTitleInputs(fileId: number, accountId: number, row?: TitleRow | null): Promise<TitleInputs | null> {
  const sql = await sqlClient();
  const runs = (await sql.unsafe(
    `SELECT raw_response_json AS raw FROM document_analysis_runs
      WHERE asset_file_id = $1 AND account_id = $2 AND status = 'completed' AND raw_response_json IS NOT NULL
      ORDER BY is_current_reference DESC, id DESC LIMIT 1`,
    [fileId, accountId] as never[],
  )) as unknown as Array<{ raw: string }>;
  if (runs[0]?.raw) {
    try {
      const parsed = JSON.parse(runs[0].raw) as Parameters<typeof titleInputsFromAnalysis>[0];
      if (parsed && typeof parsed === 'object' && parsed.document) return titleInputsFromAnalysis(parsed);
    } catch {
      // Run illisible : on se replie sur la représentation durable.
    }
  }
  const ext = (await sql.unsafe(
    `SELECT e.title, e.supplier_name, to_char(e.document_date, 'YYYY-MM-DD') AS document_date,
            e.metadata ->> 'legacyDocumentType' AS type_code,
            COALESCE((SELECT array_agg(s.subject ORDER BY s.id) FROM (
               SELECT id, subject FROM document_facts
                WHERE file_id = e.file_id AND extraction_id = e.id AND subject IS NOT NULL
                ORDER BY id LIMIT 50) s), '{}') AS subjects
       FROM document_extractions e
      WHERE e.file_id = $1 AND e.account_id = $2`,
    [fileId, accountId] as never[],
  )) as unknown as Array<{ title: string | null; supplier_name: string | null; document_date: string | null; type_code: string | null; subjects: string[] }>;
  const r = row === undefined ? await readRow(sql, fileId, accountId) : row;
  if (ext[0]) {
    const e = ext[0];
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
 * Écrit un titre SYSTÈME sous contrôle de concurrence : n'aboutit que si le
 * document a toujours le titre `expectedTitle` et la source SYSTEM. Retire
 * la marque historique `user_edited_fields.retainedTitle` (la source du titre
 * fait foi). Rend `true` si la ligne a été modifiée.
 */
export async function persistTitle(p: {
  fileId: number; accountId: number; expectedTitle: string | null; newTitle: string;
}): Promise<boolean> {
  const sql = await sqlClient();
  const rows = (await sql.unsafe(
    `UPDATE asset_files
        SET retained_title = $3, title_source = 'SYSTEM', title_checked_at = now(), updated_at = now(),
            user_edited_fields = CASE WHEN user_edited_fields ? 'retainedTitle'
                                      THEN user_edited_fields - 'retainedTitle' ELSE user_edited_fields END
      WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL
        AND title_source = 'SYSTEM'
        AND retained_title IS NOT DISTINCT FROM $4::text
      RETURNING id`,
    [p.fileId, p.accountId, p.newTitle, p.expectedTitle] as never[],
  )) as unknown as Array<{ id: number }>;
  return rows.length > 0;
}

async function markInsufficient(fileId: number, accountId: number): Promise<void> {
  const sql = await sqlClient();
  await sql.unsafe(
    `UPDATE asset_files SET title_checked_at = now() WHERE id = $1 AND account_id = $2`,
    [fileId, accountId] as never[],
  );
}

/** Événement d'observabilité (ne lève jamais). */
async function trace(accountId: number, r: EnsureTitleResult, persist: boolean): Promise<void> {
  const ligne = `[document-title] ${r.origin} fichier ${r.fileId} : ${r.outcome}${r.reason ? ` (${r.reason})` : ''}`
    + (r.outcome === 'UPDATED' ? ` « ${r.oldTitle ?? ''} » → « ${r.newTitle ?? ''} »` : '');
  if (r.outcome === 'FAILED') console.error(ligne);
  else if (r.outcome !== 'SKIP_VALID_TITLE') console.info(ligne);
  if (!persist) return;
  try {
    const sql = await sqlClient();
    await sql.unsafe(
      `INSERT INTO document_title_events (account_id, file_id, origin, outcome, reason, old_title, new_title)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [accountId, r.fileId, r.origin, r.outcome, r.reason, r.oldTitle, r.newTitle] as never[],
    );
  } catch (e) {
    console.error(`[document-title] événement non journalisé (fichier ${r.fileId}) :`, (e as Error).message);
  }
}

/**
 * Contrôle et, si nécessaire, (re)construit et persiste le titre métier d'un
 * document. Ne lève jamais (sauf interruption de l'exécution par `guard`) :
 * une erreur rend FAILED.
 *
 * `inputs` : entrées déjà en mémoire (T1, résultat de l'analyse qui vient
 * d'être persistée) ; absentes → relues des données persistées (T3).
 */
export async function ensureBusinessTitle(p: {
  fileId: number;
  accountId: number;
  origin: TitleOrigin;
  mode: TitleMode;
  inputs?: TitleInputs | null;
  guard?: ExecutionGuard;
}): Promise<EnsureTitleResult> {
  const base = { fileId: p.fileId, origin: p.origin };
  let oldTitle: string | null = null;
  try {
    const sql = await sqlClient();
    const row = await readRow(sql, p.fileId, p.accountId);
    if (!row) {
      return { ...base, outcome: 'SKIP_INSUFFICIENT_DATA', reason: 'DOCUMENT_GONE', oldTitle: null, newTitle: null };
    }
    oldTitle = row.retained_title;
    const ids = idsOf(row);
    const valide = isValidBusinessTitle(row.retained_title, ids);
    const fin = async (outcome: TitleOutcome, reason: string | null, newTitle: string | null, persist: boolean) => {
      const r: EnsureTitleResult = { ...base, outcome, reason, oldTitle, newTitle };
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
    if (p.mode === 'repair' && valide) return fin('SKIP_VALID_TITLE', null, null, false);
    if (row.title_source === 'USER') return fin('SKIP_USER_TITLE', null, null, !valide);

    const inputs = p.inputs !== undefined && p.inputs !== null ? p.inputs : await loadPersistedTitleInputs(p.fileId, p.accountId, row);
    const titre = buildTitle(inputs, ids);
    if (!titre) {
      if (valide) return fin('SKIP_VALID_TITLE', 'NO_BETTER_TITLE', null, false);
      await p.guard?.assertActive('titre du document — données insuffisantes');
      await markInsufficient(p.fileId, p.accountId);
      return fin('SKIP_INSUFFICIENT_DATA', inputs ? 'NO_TITLE_FROM_DATA' : 'NO_ANALYSIS_DATA', null, true);
    }
    if (titre === row.retained_title?.trim()) return fin('SKIP_VALID_TITLE', null, null, false);

    await p.guard?.assertActive('titre du document');
    if (await persistTitle({ fileId: p.fileId, accountId: p.accountId, expectedTitle: row.retained_title, newTitle: titre })) {
      return fin('UPDATED', valide ? 'REFRESHED_FROM_ANALYSIS' : 'NON_COMPLIANT_TITLE', titre, true);
    }
    // Le document a changé entre la lecture et l'écriture.
    const apres = await readRow(sql, p.fileId, p.accountId);
    if (apres?.title_source === 'USER') return fin('SKIP_USER_TITLE', 'CONCURRENT_USER_RENAME', null, true);
    if (!apres || isValidBusinessTitle(apres.retained_title, idsOf(apres))) {
      oldTitle = apres?.retained_title ?? oldTitle;
      return fin('SKIP_VALID_TITLE', 'CONCURRENT_UPDATE', null, false);
    }
    return fin('FAILED', 'CONCURRENT_UPDATE', titre, true);
  } catch (e) {
    if (isExecutionCancelled(e)) throw e;
    const r: EnsureTitleResult = { ...base, outcome: 'FAILED', reason: ((e as Error).message ?? 'ERROR').slice(0, 300), oldTitle, newTitle: null };
    await trace(p.accountId, r, true);
    return r;
  }
}

/** Service commun T1 / T3 (AC4) : une seule implémentation. */
export const DocumentTitleService = {
  isValidBusinessTitle,
  buildTitle,
  loadPersistedTitleInputs,
  persistTitle,
  ensureBusinessTitle,
} as const;
