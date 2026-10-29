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
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 87D — SERVICE DE NOMMAGE CENTRALISÉ (règles v3)
 *
 *   · données de nommage PERSISTÉES par document (`asset_files.title_basis`,
 *     0760) : période facturée, mois principal décidé par l'IA (point
 *     d'extension, demande 87D-mois-principal-factures), date d'émission,
 *     références de facture — avec leur provenance ; indexées par la
 *     recherche globale (numéro de facture recherchable) ;
 *   · convention PÉRIODIQUE (`title_convention = 'PERIODIC'`) : le titre
 *     canonique prévaut sur tout titre SYSTÈME différent (y compris un nom
 *     harmonisé par T3, qui ne nomme plus ces documents) ; un titre USER
 *     n'est jamais touché ;
 *   · désambiguïsation DÉTERMINISTE par groupe canonique
 *     (`title_canonical_key`) : quand un document entre dans un groupe ou en
 *     sort, les autres membres sont recontrôlés (`propagate`) ;
 *   · ancienne typographie du moteur v2 (« … _ Septembre 2026 ») normalisée
 *     sans perte d'information ;
 *   · origine `COHERENCE` : réparation du stock par le contrôle
 *     `COH-DOC-TITLES` (0761) — seul filet de convergence ; le balayage
 *     horaire paginé des titres est retiré.
 *
 * LOT 99C — REPRÉSENTATION TEMPORELLE : la période du titre périodique est
 * représentée selon la décision de la branche T3 DOCUMENT_NAMING
 * (`title_period_decision`, 0864, contrat `t3-naming-period-v1`), re-validée à
 * chaque composition ; sans décision valable : mois explicitement désigné par
 * le document, sinon période exacte — plus aucun « mois principal » imposé.
 * ══════════════════════════════════════════════════════════════════════════
 */
import {
  DOCUMENT_TITLE_RULE_VERSION, evaluateBusinessTitle, isValidBusinessTitle, normalizeTitle, shouldReplaceSystemTitle, titleHasPhrase,
  type TitleEvaluation, type TitleIdentifiers,
} from '@/lib/documents/document-title-rules';
import {
  billedPeriodFromAnalysis, hasLegacyTitleTypography, principalMonthFromAnalysis, type DisambiguationMember,
} from '@/lib/documents/document-title-convention';
import { readStoredPeriodDecision } from '@/lib/documents/document-title-period';
import {
  periodFactsOf, planBusinessTitle, titleContextFingerprint, titleInputsFromAnalysis, type BillingBasis, type TitleContext, type TitleInputs, type TitlePlan,
} from '@/services/ai/source-analysis/document-title';
import { isExecutionCancelled, type ExecutionGuard } from '@/services/ai/queue/execution-control';

/** Lot 87D : `COHERENCE` = réparation du stock par le contrôle COH-DOC-TITLES. */
type TitleOrigin = 'T1' | 'T3' | 'COHERENCE';
type TitleMode = 'refresh' | 'repair';
export type TitleOutcome = 'UPDATED' | 'NO_CHANGE' | 'SKIP_USER_TITLE' | 'INSUFFICIENT_DATA' | 'FAILED';
/** Pourquoi le titre est (re)contrôlé (journal). */
type TitleTrigger = 'RULE_VERSION_UPGRADE' | 'CONTEXT_CHANGED' | 'NEW_ANALYSIS';

interface EnsureTitleResult {
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
  /** Lot 87D (0760) : données de nommage, convention et clé du groupe canonique persistées. */
  title_basis: unknown;
  title_convention: string | null;
  title_canonical_key: string | null;
}

type Sql = typeof import('@/db').pgClient;
const sqlClient = async (): Promise<Sql> => (await import('@/db')).pgClient;

const idsOf = (r: Pick<TitleRow, 's3_key' | 'public_id'>): TitleIdentifiers => ({ s3Key: r.s3_key, publicId: r.public_id });

async function readRow(sql: Sql, fileId: number, accountId: number): Promise<TitleRow | null> {
  const rows = (await sql.unsafe(
    `SELECT id, account_id, retained_title, title_source, s3_key, public_id::text AS public_id,
            document_type, supplier, to_char(document_date, 'YYYY-MM-DD') AS document_date, last_analysis_at,
            original_filename, filename, title_rule_version, title_context_fingerprint, title_checked_at,
            COALESCE((user_edited_fields ->> 'retainedTitle') = 'true', false) AS legacy_user_edit,
            title_basis, title_convention, title_canonical_key
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
async function loadTitleAccountContext(fileId: number, accountId: number): Promise<Partial<TitleContext>> {
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
    // Lot 87D : la période des faits n'est retenue que si elle est UNIQUE
    // (deux périodes différentes : ambiguïté, jamais tranchée par le code).
    sql.unsafe(
      `SELECT DISTINCT to_char(period_start, 'YYYY-MM-DD') AS s, to_char(period_end, 'YYYY-MM-DD') AS e FROM document_facts
        WHERE file_id = $1 AND account_id = $2 AND status = 'active' AND period_start IS NOT NULL AND period_end IS NOT NULL
        LIMIT 2`,
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
    period: periode.length === 1 ? { start: periode[0].s, end: periode[0].e } : null,
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

/** Plan du titre (meilleur candidat + attentes + empreinte), titres similaires ou groupe canonique compris. */
export async function planTitleForDocument(fileId: number, accountId: number, inputs: TitleInputs): Promise<{ plan: TitlePlan; fingerprint: string; basis: BillingBasis }> {
  const billing = await loadBillingBasis(fileId, accountId, inputs.ctx.documentDate ?? null);
  const ctx: TitleContext = { ...inputs.ctx, ...(await loadTitleAccountContext(fileId, accountId)), selfId: fileId, billing };
  let plan = planBusinessTitle(inputs.modelTitle, ctx);
  if (plan.convention === 'PERIODIC' && plan.canonicalKey) {
    // Lot 87D : désambiguïsation déterministe dans le groupe canonique.
    const membres = await loadCanonicalGroup(fileId, accountId, plan.canonicalKey);
    if (membres.length) plan = planBusinessTitle(inputs.modelTitle, { ...ctx, periodicSiblings: membres });
  } else if (plan.title) {
    const similaires = await loadSimilarTitles(fileId, accountId, plan.title);
    if (similaires.length) plan = planBusinessTitle(inputs.modelTitle, { ...ctx, similarTitles: similaires });
  }
  return { plan, fingerprint: titleContextFingerprint(plan), basis: billing };
}

// ── Lot 87D : données de nommage persistées ─────────────────────────────────

/** Clé alphanumérique d'une référence (comparaison, jamais affichée). */
const refKey = (r: string) => r.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const isoDay = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

/**
 * Données de facturation d'un document (pure) depuis la connaissance T1
 * PERSISTÉE : candidats Opération actifs (`businessReferences[kind=INVOICE]`,
 * `financialHints[].periodStart / periodEnd`), périodes des faits, résultat
 * du run T1 de référence (mois principal, point d'extension). Une période
 * n'est retenue que si elle est UNIQUE ; rien n'est déduit ni inventé.
 */
export function billingBasisFrom(p: {
  candidatePayloads: readonly unknown[];
  factPeriods: ReadonlyArray<{ s: string | null; e: string | null }>;
  analysisResult: unknown;
  issueDate: string | null;
}): BillingBasis {
  const refs = new Map<string, string>();
  const echeances = new Map<string, { start: string; end: string }>();
  const couts = new Map<string, { start: string; end: string }>();
  for (const brut of p.candidatePayloads) {
    const c = (brut && typeof brut === 'object' ? brut : {}) as { businessReferences?: unknown; financialHints?: unknown };
    for (const r of Array.isArray(c.businessReferences) ? c.businessReferences as Array<Record<string, unknown>> : []) {
      const v = typeof r?.value === 'string' ? r.value.trim().slice(0, 60) : '';
      if (r?.kind === 'INVOICE' && refKey(v).length > 0 && !refs.has(refKey(v))) refs.set(refKey(v), v);
    }
    for (const h of Array.isArray(c.financialHints) ? c.financialHints as Array<Record<string, unknown>> : []) {
      const start = isoDay(h?.periodStart);
      const end = isoDay(h?.periodEnd);
      if (!start || !end) continue;
      if (h.amountScope === 'INSTALLMENT') echeances.set(`${start}|${end}`, { start, end });
      else if (h.role === 'REALIZED_COST' || h.role === 'FORECAST_COST') couts.set(`${start}|${end}`, { start, end });
    }
  }
  const faits = new Map(p.factPeriods.filter((f) => isoDay(f.s) && isoDay(f.e)).map((f) => [`${f.s}|${f.e}`, { start: isoDay(f.s)!, end: isoDay(f.e)! }]));
  const unique = <T>(m: Map<string, T>): T | null => (m.size === 1 ? [...m.values()][0] : null);
  // Lot 99C : la période facturée de T1 (`document.billingPeriod`, 97A) n'est lue qu'à défaut de
  // TOUTE autre période (jamais pour trancher une ambiguïté entre échéances, coûts ou faits).
  const t1 = echeances.size === 0 && couts.size === 0 && faits.size === 0 ? billedPeriodFromAnalysis(p.analysisResult) : null;
  const billedPeriod = unique(echeances) ? { ...unique(echeances)!, source: 'T1_INSTALLMENT' as const }
    : echeances.size === 0 && unique(couts) ? { ...unique(couts)!, source: 'T1_COST_PERIOD' as const }
      : echeances.size === 0 && couts.size === 0 && unique(faits) ? { ...unique(faits)!, source: 'T1_FACT' as const }
        : t1 ? { start: t1.start, end: t1.end, source: 'T1_BILLING_PERIOD' as const }
          : null;
  return {
    billedPeriod,
    principalMonth: principalMonthFromAnalysis(p.analysisResult),
    invoiceReferences: [...refs.values()].sort((a, b) => refKey(a).localeCompare(refKey(b))),
    issueDate: isoDay(p.issueDate),
  };
}

/**
 * Lot 99C — coupure d'urgence des décisions de représentation temporelle T3 :
 * `T3_NAMING_PERIOD_ENABLED=0` → le nommage ignore les décisions persistées
 * (repli prudent) et la phase T3 n'en demande plus. Pure.
 */
export const namingPeriodDecisionsEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  (env.T3_NAMING_PERIOD_ENABLED ?? '1').trim() !== '0';

/** Décision T3 persistée (`title_period_decision`, 0864) ; colonne absente : null. */
async function loadPeriodDecision(sql: Sql, fileId: number, accountId: number): Promise<BillingBasis['periodDecision']> {
  if (!namingPeriodDecisionsEnabled()) return null;
  try {
    const rows = (await sql.unsafe(
      `SELECT title_period_decision AS d FROM asset_files WHERE id = $1 AND account_id = $2`,
      [fileId, accountId] as never[],
    )) as unknown as Array<{ d: unknown }>;
    return readStoredPeriodDecision(rows[0]?.d ?? null);
  } catch {
    return null;
  }
}

/** Données de facturation PERSISTÉES d'un document (lecture seule, bornée). */
async function loadBillingBasis(fileId: number, accountId: number, issueDate: string | null): Promise<BillingBasis> {
  const sql = await sqlClient();
  const [cands, faits, run, decision] = await Promise.all([
    sql.unsafe(
      `SELECT payload FROM document_operation_candidates
        WHERE file_id = $1 AND account_id = $2 AND status = 'ACTIVE' ORDER BY id LIMIT 20`,
      [fileId, accountId] as never[],
    ).catch(() => []) as unknown as Promise<Array<{ payload: unknown }>>,
    sql.unsafe(
      `SELECT DISTINCT to_char(period_start, 'YYYY-MM-DD') AS s, to_char(period_end, 'YYYY-MM-DD') AS e FROM document_facts
        WHERE file_id = $1 AND account_id = $2 AND status = 'active' AND period_start IS NOT NULL AND period_end IS NOT NULL
        LIMIT 3`,
      [fileId, accountId] as never[],
    ) as unknown as Promise<Array<{ s: string | null; e: string | null }>>,
    // Mois principal (point d'extension) : le résultat n'est relu que s'il porte le bloc.
    sql.unsafe(
      `SELECT raw_response_json AS raw FROM document_analysis_runs
        WHERE asset_file_id = $1 AND account_id = $2 AND status = 'completed' AND raw_response_json IS NOT NULL
          AND strpos(raw_response_json, '"billingPeriod"') > 0
        ORDER BY is_current_reference DESC, id DESC LIMIT 1`,
      [fileId, accountId] as never[],
    ) as unknown as Promise<Array<{ raw: string }>>,
    loadPeriodDecision(sql, fileId, accountId),
  ]);
  let resultat: unknown = null;
  try { resultat = run[0]?.raw ? JSON.parse(run[0].raw) : null; } catch { resultat = null; }
  const payloads = cands.map((c) => (typeof c.payload === 'string' ? safeJson(c.payload) : c.payload));
  const basis = billingBasisFrom({ candidatePayloads: payloads, factPeriods: faits, analysisResult: resultat, issueDate });
  return decision ? { ...basis, periodDecision: decision } : basis;
}
const safeJson = (s: string): unknown => { try { return JSON.parse(s); } catch { return null; } };

/**
 * Données de nommage à persister (`asset_files.title_basis`) — forme stable,
 * versionnée. Lot 99C (v2) : mois explicitement désigné (`statedMonth`) et
 * REPRÉSENTATION TEMPORELLE retenue avec son fondement et ses preuves
 * (`periodRepresentation` : décision T3 ou repli prudent) — lue par le
 * diagnostic global.
 */
export function titleBasisRecord(plan: TitlePlan, basis: BillingBasis, supplier: string | null): Record<string, unknown> {
  const facts = periodFactsOf(basis);
  const choix = plan.convention ? plan.periodChoice ?? null : null;
  return {
    v: 2,
    nature: plan.nature,
    supplier: plan.supplier ?? supplier ?? null,
    billedPeriod: basis.billedPeriod,
    principalMonth: basis.principalMonth,
    statedMonth: facts.statedMonth?.value ?? null,
    issueDate: basis.issueDate,
    invoiceReferences: basis.invoiceReferences,
    convention: plan.convention,
    period: plan.convention ? plan.period : null,
    disambiguator: plan.convention ? plan.reference : null,
    periodRepresentation: choix ? {
      representation: choix.representation, source: choix.source, label: choix.label, basis: choix.basis, evidence: choix.evidence,
      decisionIgnored: choix.decisionIgnored ?? null,
      decidedBy: choix.source === 'T3_DECISION' ? 'T3' : 'RULE',
      ...(choix.source === 'T3_DECISION' && basis.periodDecision
        ? { promptVersion: basis.periodDecision.promptVersion, traceId: basis.periodDecision.traceId, decidedAt: basis.periodDecision.decidedAt, reason: basis.periodDecision.reason }
        : {}),
    } : null,
  };
}

/** Autres documents du compte de même clé canonique (bornés) : références et émission persistées. */
async function loadCanonicalGroup(fileId: number, accountId: number, key: string): Promise<DisambiguationMember[]> {
  const sql = await sqlClient();
  const rows = (await sql.unsafe(
    `SELECT id, title_basis FROM asset_files
      WHERE account_id = $1 AND id <> $2 AND deleted_at IS NULL AND grouped_into_file_id IS NULL
        AND title_canonical_key = $3
      ORDER BY id LIMIT 50`,
    [accountId, fileId, key] as never[],
  )) as unknown as Array<{ id: number; title_basis: unknown }>;
  return rows.map((r) => {
    const b = (typeof r.title_basis === 'string' ? safeJson(r.title_basis) : r.title_basis) as { invoiceReferences?: unknown; issueDate?: unknown } | null;
    return {
      id: Number(r.id),
      invoiceReferences: Array.isArray(b?.invoiceReferences) ? (b!.invoiceReferences as unknown[]).filter((x): x is string => typeof x === 'string') : [],
      issueDate: isoDay(b?.issueDate),
    };
  });
}

/** Membres d'un ou deux groupes canoniques (recontrôle après entrée / sortie d'un document). */
async function canonicalGroupIds(fileId: number, accountId: number, keys: ReadonlyArray<string | null>): Promise<number[]> {
  const cles = [...new Set(keys.filter((k): k is string => !!k))];
  if (!cles.length) return [];
  const sql = await sqlClient();
  const rows = (await sql.unsafe(
    `SELECT id FROM asset_files
      WHERE account_id = $1 AND id <> $2 AND deleted_at IS NULL AND grouped_into_file_id IS NULL
        AND title_canonical_key = ANY($3::text[])
      ORDER BY id LIMIT 20`,
    [accountId, fileId, cles] as never[],
  )) as unknown as Array<{ id: number }>;
  return rows.map((r) => Number(r.id));
}

/**
 * Données de nommage persistées SANS toucher au titre (titre utilisateur,
 * nom protégé) : jamais `updated_at`. N'écrit que si quelque chose change.
 */
async function persistNamingMetadata(fileId: number, accountId: number, record: Record<string, unknown>, convention: string | null, key: string | null): Promise<boolean> {
  const sql = await sqlClient();
  const rows = (await sql.unsafe(
    `UPDATE asset_files SET title_basis = $3::jsonb, title_convention = $4, title_canonical_key = $5
      WHERE id = $1 AND account_id = $2
        AND (title_basis IS DISTINCT FROM $3::jsonb OR title_convention IS DISTINCT FROM $4 OR title_canonical_key IS DISTINCT FROM $5)
      RETURNING id`,
    [fileId, accountId, JSON.stringify(record), convention, key] as never[],
  )) as unknown as unknown[];
  return rows.length > 0;
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
  /** Lot 87D : données de nommage, convention et clé du groupe canonique (même écriture). */
  metadata?: { record: Record<string, unknown>; convention: string | null; key: string | null } | null;
}): Promise<boolean> {
  const sql = await sqlClient();
  const meta = p.metadata ?? null;
  const rows = (await sql.unsafe(
    `UPDATE asset_files
        SET retained_title = $3, title_source = 'SYSTEM', title_checked_at = now(), updated_at = now(),
            title_rule_version = $5::int, title_context_fingerprint = $6,
            title_basis = CASE WHEN $7::boolean THEN $8::jsonb ELSE title_basis END,
            title_convention = CASE WHEN $7::boolean THEN $9::text ELSE title_convention END,
            title_canonical_key = CASE WHEN $7::boolean THEN $10::text ELSE title_canonical_key END,
            user_edited_fields = CASE WHEN user_edited_fields ? 'retainedTitle'
                                      THEN user_edited_fields - 'retainedTitle' ELSE user_edited_fields END
      WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL
        AND title_source = 'SYSTEM'
        AND retained_title IS NOT DISTINCT FROM $4::text
      RETURNING id`,
    [p.fileId, p.accountId, p.newTitle, p.expectedTitle, p.ruleVersion ?? DOCUMENT_TITLE_RULE_VERSION, p.contextFingerprint ?? null,
      meta !== null, meta ? JSON.stringify(meta.record) : null, meta?.convention ?? null, meta?.key ?? null] as never[],
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

/**
 * Lot 61 : le titre en place est-il le dernier nom écrit par l'harmonisation
 * T3 (`document_rename_events`, APPLIED) ? Table absente : non.
 */
async function isHarmonizedTitle(sql: Sql, fileId: number, accountId: number, title: string | null): Promise<boolean> {
  if (!title) return false;
  try {
    const rows = (await sql.unsafe(
      `SELECT applied_name FROM document_rename_events
        WHERE account_id = $1 AND file_id = $2 AND outcome = 'APPLIED' ORDER BY id DESC LIMIT 1`,
      [accountId, fileId] as never[],
    )) as unknown as Array<{ applied_name: string | null }>;
    return (rows[0]?.applied_name ?? '').trim() === title.trim();
  } catch {
    return false;
  }
}

/** Lot 87D : le titre en place est-il un nom harmonisé par T3 (lecture seule, contrôle de cohérence) ? */
export async function isHarmonizedDocumentTitle(fileId: number, accountId: number, title: string | null): Promise<boolean> {
  return isHarmonizedTitle(await sqlClient(), fileId, accountId, title);
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
 * Contrôle et, si le candidat est RÉELLEMENT meilleur — ou, lot 87D, s'il est
 * le titre CANONIQUE d'une convention —, persiste le titre métier d'un
 * document. Ne lève jamais (sauf interruption de l'exécution par `guard`) :
 * une erreur rend FAILED.
 *
 * `inputs` : entrées déjà en mémoire (T1, résultat de l'analyse qui vient
 * d'être persistée) ; absentes → relues des données persistées (T3, contrôle
 * de cohérence). `trigger` : motif explicite (défaut : déduit — version des
 * règles, nouvelle analyse, contexte modifié). `propagate` (défaut : vrai) :
 * recontrôle des autres membres du groupe canonique quand ce document y entre
 * ou en sort (désambiguïsation déterministe) ; faux pour ces recontrôles.
 */
export async function ensureBusinessTitle(p: {
  fileId: number;
  accountId: number;
  origin: TitleOrigin;
  mode: TitleMode;
  inputs?: TitleInputs | null;
  guard?: ExecutionGuard;
  trigger?: TitleTrigger;
  propagate?: boolean;
}): Promise<EnsureTitleResult> {
  const base = { fileId: p.fileId, origin: p.origin };
  let oldTitle: string | null = null;
  let trigger: TitleTrigger | null = p.trigger ?? null;
  let fingerprint: string | null = null;
  let groupes: Array<string | null> = [];
  const res = await (async (): Promise<EnsureTitleResult> => {
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

      const inputs = p.inputs !== undefined && p.inputs !== null
        ? withPersistedGaps(p.inputs, await loadPersistedTitleInputs(p.fileId, p.accountId, row))
        : await loadPersistedTitleInputs(p.fileId, p.accountId, row);

      // Titre utilisateur : jamais touché (T1, T3, contrôle, rattachement).
      // Lot 87D : ses données de nommage sont tenues à jour (recherche,
      // groupe canonique), sans jamais écrire le titre.
      if (row.title_source === 'USER') {
        if (inputs) {
          const { plan, basis } = await planTitleForDocument(p.fileId, p.accountId, inputs);
          await p.guard?.assertActive('titre du document — données de nommage');
          if (await persistNamingMetadata(p.fileId, p.accountId, titleBasisRecord(plan, basis, inputs.ctx.supplier ?? null), plan.convention, plan.canonicalKey)
              && row.title_canonical_key !== plan.canonicalKey) {
            groupes = [row.title_canonical_key, plan.canonicalKey];
          }
        }
        return fin('SKIP_USER_TITLE', 'USER_TITLE_PROTECTED', null, !valide);
      }

      if (!inputs) {
        await p.guard?.assertActive('titre du document — données insuffisantes');
        // Empreinte sentinelle : repris seulement si le contexte change (nouvelle analyse…).
        const ecrit = await stampChecked(p.fileId, p.accountId, 'NO_ANALYSIS_DATA');
        return fin(valide ? 'NO_CHANGE' : 'INSUFFICIENT_DATA', valide ? 'NO_BETTER_TITLE' : 'NO_ANALYSIS_DATA', null, !valide && ecrit);
      }
      const { plan, fingerprint: fp, basis } = await planTitleForDocument(p.fileId, p.accountId, inputs);
      fingerprint = fp;
      const meta = { record: titleBasisRecord(plan, basis, inputs.ctx.supplier ?? null), convention: plan.convention, key: plan.canonicalKey };
      const cleModifiee = row.title_canonical_key !== plan.canonicalKey;
      if (cleModifiee) groupes = [row.title_canonical_key, plan.canonicalKey];
      const metaAJour = row.title_convention === plan.convention && !cleModifiee && sameJson(row.title_basis, meta.record);
      const candidat = plan.title && isValidBusinessTitle(plan.title, ids) ? plan.title.trim() : null;
      const canonique = plan.convention !== null && candidat !== null;

      // Même version des règles, même contexte, titre en place conforme (et,
      // pour une convention, égal au titre canonique), données de nommage à
      // jour : aucun retraitement, aucune écriture.
      if (p.mode === 'repair' && row.title_rule_version === DOCUMENT_TITLE_RULE_VERSION && row.title_context_fingerprint === fp
        && valide && row.title_checked_at !== null && metaAJour && (!canonique || row.retained_title?.trim() === candidat)) {
        return fin('NO_CHANGE', null, null, false);
      }
      const evaluation = evaluateBusinessTitle(row.retained_title, plan.expectations, ids);
      const contexteModifie = row.title_context_fingerprint != null && row.title_context_fingerprint !== fp;
      const sansRenommage = async (outcome: TitleOutcome, reason: string | null, persistIf: (ecrit: boolean) => boolean) => {
        await p.guard?.assertActive('titre du document — contrôle');
        const ecrit = await stampChecked(p.fileId, p.accountId, fp);
        await persistNamingMetadata(p.fileId, p.accountId, meta.record, meta.convention, meta.key);
        return fin(outcome, reason, null, persistIf(ecrit), evaluation);
      };

      if (!candidat) {
        if (valide) return sansRenommage('NO_CHANGE', 'NO_BETTER_TITLE', (e) => e && contexteModifie);
        return sansRenommage('INSUFFICIENT_DATA', 'NO_TITLE_FROM_DATA', (e) => e);
      }

      let decision: { replace: boolean; reason: string };
      if (canonique) {
        // Lot 87D : convention — le titre canonique prévaut sur tout titre
        // SYSTÈME différent (nom harmonisé par T3 compris).
        decision = row.retained_title?.trim() === candidat
          ? { replace: false, reason: 'NO_BETTER_TITLE' }
          : { replace: true, reason: plan.reference && normalizeTitle(row.retained_title).startsWith(normalizeTitle(candidat.replace(/\s*\([^)]*\)$/, ''))) ? 'DUPLICATE_DISAMBIGUATED' : 'CONVENTION_APPLIED' };
      } else {
        // Lot 61 : nom harmonisé par T3 (famille documentaire, décision IA) et
        // toujours en place — le rattrapage déterministe ne le remplace pas
        // (sinon les deux mécanismes se renommeraient l'un l'autre). T1 (mode
        // `refresh`, nouvelle analyse) reste libre de nommer.
        if (p.mode === 'repair' && valide && await isHarmonizedTitle(sql, p.fileId, p.accountId, row.retained_title)) {
          return sansRenommage('NO_CHANGE', 'HARMONIZED_TITLE', () => false);
        }
        // Premier titrage : titre encore égal au nom du fichier déposé.
        const premier = row.title_rule_version == null && row.title_context_fingerprint == null
          && !!row.retained_title && [row.original_filename, row.filename].some((n) => n && n.trim() === row.retained_title!.trim());
        decision = premier && valide && candidat !== row.retained_title?.trim()
          ? { replace: true, reason: 'FIRST_TITLE' }
          : shouldReplaceSystemTitle(row.retained_title, candidat, plan.expectations, ids);
        // Lot 87D : ancienne typographie du moteur (« … _ Septembre 2026 ») →
        // composition v3 des MÊMES informations (jamais de perte).
        if (!decision.replace && valide && hasLegacyTitleTypography(row.retained_title) && !titleLosesInformation(row.retained_title!, candidat, plan)) {
          decision = { replace: true, reason: 'TYPOGRAPHY_NORMALIZED' };
        }
      }
      if (!decision.replace) return sansRenommage('NO_CHANGE', 'NO_BETTER_TITLE', (e) => e && contexteModifie);

      await p.guard?.assertActive('titre du document');
      if (await persistTitle({ fileId: p.fileId, accountId: p.accountId, expectedTitle: row.retained_title, newTitle: candidat, contextFingerprint: fp, metadata: meta })) {
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
  })();

  // Lot 87D : le document est entré dans un groupe canonique ou en est sorti —
  // les autres membres sont recontrôlés (désambiguïsation symétrique). Un seul
  // niveau : ces recontrôles ne propagent pas à leur tour.
  if (p.propagate !== false && groupes.some(Boolean)) {
    for (const id of await canonicalGroupIds(p.fileId, p.accountId, groupes).catch(() => [] as number[])) {
      await p.guard?.assertActive('titre du document — groupe canonique');
      await ensureBusinessTitle({ fileId: id, accountId: p.accountId, origin: p.origin, mode: 'repair', guard: p.guard, propagate: false });
    }
  }
  return res;
}

/** Deux valeurs JSON égales (forme normalisée par PostgreSQL : ordre des clés indifférent). */
function sameJson(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => {
    const x = typeof v === 'string' ? safeJson(v) : v;
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([k1], [k2]) => k1.localeCompare(k2)).map(([k, w]) => [k, norm(w)]));
    return x ?? null;
  };
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/** Le candidat perdrait-il une information portée par le titre actuel (fournisseur, cible) ? Pure (lot 87D). */
export function titleLosesInformation(current: string, candidate: string, plan: TitlePlan): boolean {
  return (!!plan.supplier && titleHasPhrase(current, plan.supplier) && !titleHasPhrase(candidate, plan.supplier))
    || (!!plan.target && titleHasPhrase(current, plan.target.name) && !titleHasPhrase(candidate, plan.target.name));
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
  // Lot 87D : données de nommage persistées.
  billingBasisFrom,
  // Lot 99C : représentation temporelle (décision T3, coupure d'urgence).
  namingPeriodDecisionsEnabled,
  loadBillingBasis,
  titleBasisRecord,
} as const;
