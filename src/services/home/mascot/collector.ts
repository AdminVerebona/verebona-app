/**
 * SignalCollector, lecture — CDC Mascotte §5, §7, NFR-001.
 *
 * Lit les sources de vérité existantes, en parallèle et bornées, sans rien
 * écrire (GEN-002). Chaque source est lue isolément : une source en panne
 * vaut `null`, jamais « rien à signaler » (§20, ERR-01).
 */
import { pgClient } from '@/db';
import { getToProcessPage } from '@/services/to-process/to-process-query.service';
import { getEntitlements } from '@/services/entitlements.service';
import type { MascotAgendaRow, MascotDocRow, MascotExportRow, MascotRawData, MascotRights } from './signals';
import { EXT_ACTION_LOOKBACK_DAYS, mascotRightsFrom } from './signals';
import { MAX_SECONDARIES, MAX_SUBJECTS } from './types';
import { upcomingDeadlinesSqlFilter } from '@/services/agenda/AgendaQueryService';
import { isHistoricalAgendaEvent } from '@/services/agenda/agenda-historical';
import { classifyByRules } from '@/services/ai/agenda/rules/deterministic-classification';
// Lot 34C : « en cours d'analyse » seulement si un traitement l'attend réellement.
import { effectiveAnalysisStateSql } from '@/services/ai/processing-status/effective-state-sql';
// Lot 50 : seule une analyse attendue par l'utilisateur est un sujet.
import { analysisVisibilityColumnReady, userVisibleAnalysisSql } from '@/services/ai/processing-status/processing-visibility';
import { agendaDateRole } from '@/services/agenda/agenda-date-role';
import { T6_RELEVANT_FACT_PATTERN, T6_ASSESSMENT_MAX_AGE_DAYS } from './t6-interpellation';

/** Un envoi ou une analyse bloqués depuis plus longtemps ne sont plus « en cours ». */
const PROCESSING_WINDOW_HOURS = 24;
/** Horizon de l'agenda lu pour la prochaine date. */
const AGENDA_FORWARD_DAYS = 730;
/**
 * NFR-001 : la mascotte n'utilise que la tête de la file « À traiter » — au
 * plus 2 sujets et 3 secondaires. Le double laisse la marge des doublons
 * écartés par la sélection ; au-delà, la page « À traiter » fait foi.
 */
export const MASCOT_TO_PROCESS_LIMIT = (MAX_SUBJECTS + MAX_SECONDARIES) * 2;
/** Échéances portées par des actions ouvertes : identifiants seuls, bornés. */
const TO_PROCESS_AGENDA_IDS_LIMIT = 500;

export function todayParis(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/** Élément d'agenda tel que lu par l'accueil et la mascotte. */
export interface HomeAgendaItemForClassification {
  homeCategory: string | null;
  originType: string;
  title: string;
  /** 0223 (lot 14) : HISTORICAL | DEADLINE, ou null (élément antérieur). */
  eventNature?: string | null;
  businessType?: string | null;
  originFieldKey?: string | null;
}

/**
 * Échéance « action » — CDC 15 T4-02, T4-11, D-14.
 * Plus aucune règle recopiée ici : la classification vient de l'élément
 * d'agenda lui-même, puis des règles partagées de T4.
 *   1. fait HISTORICAL (achat, entretien réalisé, DPE réalisé…) : information,
 *      jamais une action ni une échéance (D-14) ;
 *   2. catégorie posée par T4 ou par l'utilisateur (`home_category`) ;
 *   3. règles déterministes partagées (`ai/agenda/rules`) : registre (type
 *      métier + nature), règles métier stables, motifs de titre ;
 *   4. cas non tranché : action (catégorie prudente de T4 : on ne masque pas
 *      une démarche possible).
 */
export function isAgendaActionItemT4(item: HomeAgendaItemForClassification): boolean {
  // Lot 47B : règle partagée (nature 0223, sinon champ d'origine, sinon type
  // métier exclusivement historique) — un fait passé n'est jamais une action
  // ni « en retard » (accueil, mascotte, assistant).
  if (isHistoricalAgendaEvent(item)) return false;
  if (item.homeCategory === 'action') return true;
  if (item.homeCategory === 'information') return false;
  const nature = item.eventNature === 'DEADLINE' ? 'DEADLINE' as const : null;
  const cat = classifyByRules({
    title: item.title, originType: item.originType, originFieldKey: item.originFieldKey ?? null,
    businessType: item.businessType ?? null, nature,
  });
  return cat !== 'information';
}

type Row = Record<string, unknown>;
const rows = async (sql: string, params: unknown[]): Promise<Row[]> =>
  (await pgClient.unsafe(sql, params as never[])) as unknown as Row[];
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v ?? ''));

async function readProcessing(accountId: number): Promise<MascotRawData['processing']> {
  const fenetre = `${PROCESSING_WINDOW_HOURS} hours`;
  // Lot 50 : une réanalyse TECHNIQUE (correction, rattachement, déplacement,
  // reprise…) est réellement en cours — l'état effectif n'est pas modifié —
  // mais n'est jamais présentée comme un sujet (PROC-DOC-ANALYSIS). La
  // visibilité est portée par le traitement, jamais déduite ici d'une origine.
  const visible = userVisibleAnalysisSql('f', await analysisVisibilityColumnReady());
  const [uploads, analyses, exports] = await Promise.all([
    rows(
      `SELECT id, COALESCE(NULLIF(retained_title, ''), NULLIF(original_filename, ''), filename) AS title,
              COALESCE(updated_at, created_at) AS at
         FROM asset_files
        WHERE account_id = $1 AND deleted_at IS NULL AND is_web_link = FALSE
          AND upload_status IN ('UPLOADING', 'PENDING')
          AND COALESCE(updated_at, created_at) > NOW() - $2::interval
        ORDER BY at DESC LIMIT 20`,
      [accountId, fenetre],
    ),
    rows(
      `SELECT id, COALESCE(NULLIF(retained_title, ''), NULLIF(original_filename, ''), filename) AS title,
              COALESCE(updated_at, created_at) AS at
         FROM asset_files f
        WHERE account_id = $1 AND deleted_at IS NULL
          AND ${effectiveAnalysisStateSql('f')} IN ('UPLOADED', 'ANALYZING')
          AND ${visible}
          AND COALESCE(upload_status, 'COMPLETED') = 'COMPLETED'
          AND COALESCE(updated_at, created_at) > NOW() - $2::interval
        ORDER BY at DESC LIMIT 20`,
      [accountId, fenetre],
    ),
    rows(
      `SELECT e.id, e.export_type AS "exportType", e.asset_id AS "assetId", a.name AS "assetName",
              e.created_at AS at
         FROM export_generation e
         JOIN assets a ON a.id = e.asset_id AND a.account_id = e.account_id
        WHERE e.account_id = $1 AND e.status IN ('pending', 'queued', 'generating')
          AND e.created_at > NOW() - $2::interval AND a.deleted_at IS NULL
        ORDER BY e.created_at DESC LIMIT 5`,
      [accountId, fenetre],
    ),
  ]);
  const doc = (r: Row): MascotDocRow => ({ id: Number(r.id), title: String(r.title ?? 'Document'), at: iso(r.at) });
  return {
    uploads: uploads.map(doc),
    analyses: analyses.map(doc),
    exports: exports.map((r): MascotExportRow => ({
      id: Number(r.id), exportType: String(r.exportType), assetId: Number(r.assetId),
      assetName: String(r.assetName ?? ''), at: iso(r.at),
    })),
  };
}

async function readOnboarding(accountId: number): Promise<MascotRawData['onboarding']> {
  const [biens, [docs]] = await Promise.all([
    rows(
      `SELECT id, name, COUNT(*) OVER ()::int AS total
         FROM assets
        WHERE account_id = $1 AND deleted_at IS NULL
          AND COALESCE(status, 'EN_SERVICE') NOT IN ('ARCHIVED', 'TRANSMIS', 'VENDU')
        ORDER BY created_at ASC LIMIT 2`,
      [accountId],
    ),
    rows(
      // L'onboarding s'arrête dès le premier envoi réussi, sans attendre
      // l'analyse (ONB-002). Seule l'existence compte : pas de comptage.
      `SELECT EXISTS (
         SELECT 1 FROM asset_files
          WHERE account_id = $1 AND deleted_at IS NULL AND is_web_link = FALSE
            AND COALESCE(upload_status, 'COMPLETED') = 'COMPLETED'
       ) AS present`,
      [accountId],
    ),
  ]);
  return {
    activeAssets: biens.map((b) => ({ id: Number(b.id), name: String(b.name) })),
    activeAssetCount: biens.length ? Number(biens[0].total) : 0,
    documentCount: docs?.present ? 1 : 0,
  };
}

/** Colonnes d'une échéance lue par la mascotte (alias `i`, bien `a`, lien `l`). */
const agendaColumns = (t4: boolean) => `i.id, i.title, to_char(i.start_date, 'YYYY-MM-DD') AS date,
            i.occurrence_nature AS "occurrenceNature", i.requires_qualification AS "requiresQualification",
            i.home_category AS "homeCategory", i.origin_type AS "originType",
            i.origin_field_key AS "originFieldKey",
            i.is_automatic AS "isAutomatic", i.projection_origin AS "projectionOrigin",
            to_char(i.start_time, 'HH24:MI') AS "startTime", i.series_key AS "seriesKey",
            ${t4 ? 'i.event_nature AS "eventNature", i.business_type AS "businessType",' : ''}
            l.asset_id AS "assetId", a.name AS "assetName",
            a.category AS "assetCategory", a.subtype AS "assetSubtype"`;

/**
 * Lot 49 (SEC-08, T6) : bien lié DU COMPTE seulement — une association
 * incorrecte en base n'apporte jamais à la mascotte le nom ou la catégorie
 * d'un bien d'un autre compte.
 */
const AGENDA_ASSET_JOIN = `LEFT JOIN LATERAL (
         SELECT x.asset_id FROM agenda_asset_links x
           JOIN assets b ON b.id = x.asset_id AND b.account_id = i.account_id
          WHERE x.agenda_item_id = i.id ORDER BY x.asset_id LIMIT 1
       ) l ON TRUE
       LEFT JOIN assets a ON a.id = l.asset_id AND a.account_id = i.account_id AND a.deleted_at IS NULL`;

/** Lignes lues → échéances « action » de la mascotte (classification T4 partagée). */
function agendaRowsOf(r: Row[]): MascotAgendaRow[] {
  const classer = (i: Row): HomeAgendaItemForClassification => ({
    homeCategory: (i.homeCategory as string | null) ?? null,
    originType: String(i.originType ?? 'manual'),
    title: String(i.title ?? ''),
    eventNature: (i.eventNature as string | null | undefined) ?? null,
    businessType: (i.businessType as string | null | undefined) ?? null,
    originFieldKey: (i.originFieldKey as string | null | undefined) ?? null,
  });
  return r.filter((i) => isAgendaActionItemT4(classer(i))).map(agendaRowOf);
}

/** Ligne lue → échéance de la mascotte (sans filtre) — lot 76A : partagée avec l'empreinte T6. */
function agendaRowOf(i: Row): MascotAgendaRow {
  return {
      id: Number(i.id),
      title: String(i.title),
      date: (i.date as string | null) ?? null,
      forecast: i.occurrenceNature === 'FORECAST',
      // Lot 50 : date à respecter (action à prévoir) ou événement réellement
      // planifié — données structurées de l'agenda, jamais le titre.
      dateRole: agendaDateRole({
        forecast: i.occurrenceNature === 'FORECAST',
        isAutomatic: Boolean(i.isAutomatic),
        originType: String(i.originType ?? 'manual'),
        projectionOrigin: (i.projectionOrigin as string | null) ?? null,
        eventNature: (i.eventNature as string | null | undefined) ?? null,
        startTime: (i.startTime as string | null) ?? null,
      }),
      requiresQualification: Boolean(i.requiresQualification),
      assetId: i.assetId == null ? null : Number(i.assetId),
      assetName: (i.assetName as string | null) ?? null,
      assetCategory: (i.assetCategory as string | null) ?? null,
      assetSubtype: (i.assetSubtype as string | null) ?? null,
      seriesKey: (i.seriesKey as string | null) ?? null,
      ...(i.longOverdue === true ? { t6LongOverdue: true } : {}),
      // Lot 75E (B) : curseur d'examen de la lecture complémentaire T6.
      ...(typeof i.selectionSignature === 'string' ? { t6SelectionSignature: i.selectionSignature, t6Due: i.due === true } : {}),
  };
}

/**
 * Lot 76A (P1) — échéances DU compte par identifiant, lues comme par la
 * mascotte (mêmes colonnes, bien du compte, rôle de la date, série) : base
 * de l'empreinte courante hors préparation (reports, harnais). Lève en cas d'échec.
 */
export async function readAgendaRowsByIds(accountId: number, ids: readonly number[]): Promise<MascotAgendaRow[]> {
  if (ids.length === 0) return [];
  const t4 = (await upcomingDeadlinesSqlFilter('i')) !== '';
  const r = await rows(
    `SELECT ${agendaColumns(t4)} FROM agenda_items i ${AGENDA_ASSET_JOIN} WHERE i.account_id = $1 AND i.id = ANY($2::int[])`,
    [accountId, [...ids]],
  );
  return r.map(agendaRowOf);
}

/** Lecture principale de l'agenda de la mascotte : 200 échéances au plus, par date. */
const AGENDA_LIMIT = 200;

async function readAgenda(accountId: number, today: string): Promise<MascotAgendaRow[]> {
  // 0223 appliquée : les échéances AUTOMATIQUES sont lues aussi, les faits
  // HISTORICAL jamais (D-14) — filtre de B. 0223 absente : automatiques
  // exclus hors prévisions, faute de nature pour écarter les faits passés.
  const filtreT4 = await upcomingDeadlinesSqlFilter('i');
  const t4 = filtreT4 !== '';
  const r = await rows(
    `SELECT ${agendaColumns(t4)}
       FROM agenda_items i
       ${AGENDA_ASSET_JOIN}
      WHERE i.account_id = $1
        AND (i.manual_status IS NULL OR trim(i.manual_status) = '')
        ${t4 ? filtreT4 : "AND (i.is_automatic = FALSE OR i.occurrence_nature = 'FORECAST')"}
        AND i.start_date >= ($2::date - $3::int)
        AND i.start_date <= ($2::date + $4::int)
      ORDER BY i.start_date ASC, i.id ASC
      LIMIT ${AGENDA_LIMIT}`,
    [accountId, today, EXT_ACTION_LOOKBACK_DAYS, AGENDA_FORWARD_DAYS],
  );
  return agendaRowsOf(r);
}

/** Lot 71G : échéances lues pour T6 au-delà de la lecture principale (bornées). */
export const T6_AGENDA_EXTRA_LIMIT = 120;
/** Lot 75E (B) : échéances déjà décidées « à présenter » relues hors file d'examen (affichage). */
export const T6_AGENDA_SHOWN_LIMIT = 40;
/** Lot 71G (T6-02) : ancienneté maximale d'une échéance dépassée encore examinée. */
export const T6_OVERDUE_MAX_LOOKBACK_DAYS = 730;

/** Lot 75E (B) : table du curseur d'examen (0551) présente ? Lue une fois par processus. */
let examinations: Promise<boolean> | null = null;
export function t6ExaminationsReady(): Promise<boolean> {
  examinations ??= rows(`SELECT to_regclass('t6_candidate_examinations') IS NOT NULL AS ok`, [])
    // Absente (migration pas encore passée) : jamais mémorisée, relue au passage suivant.
    .then(([r]) => { if (r?.ok !== true) examinations = null; return r?.ok === true; })
    .catch(() => { examinations = null; return false; });
  return examinations;
}
/** Réservé aux tests. */
export function resetT6ExaminationsProbe(): void { examinations = null; }

/**
 * Lot 71G (T6-02, T6-03) — échéances que la lecture principale (200 lignes,
 * 60 jours en arrière) ne voit pas, mais que T6 doit pouvoir évaluer :
 *   · dépassées depuis plus de 60 jours (deux ans au plus) dont une action
 *     reste IDENTIFIABLE : évaluation non close (SHOW_NOW / DEFER), report
 *     de l'utilisateur, ou — jamais évaluée — échéance « à préciser » (T4)
 *     ou fait documentaire pertinent. Jamais la seule date dépassée ;
 *   · au-delà des 200 premières : non encore évaluées, évaluation à revoir
 *     ou non close.
 * Hors échéances portées par « À traiter ». Données de T6 seulement : aucun
 * autre sujet de la mascotte ne les lit.
 *
 * Lot 75E (A, B) — SÉLECTION PROGRESSIVE ET ÉQUITABLE, REPRISE PERSISTANTE :
 *   · A : une échéance ÉCARTÉE (SUPPRESS), même dépassée depuis longtemps,
 *     redevient lisible dès que ses données changent (signature SQL de
 *     l'échéance, de ses documents et de ses faits pertinents ≠ celle de son
 *     dernier examen) — jamais une ancienne décision prise pour définitive ;
 *     inchangée, elle n'est pas relue (aucune réévaluation répétée) ;
 *   · B : FILE D'EXAMEN — d'abord les échéances DUES (jamais examinées,
 *     données changées, date de réexamen atteinte, report échu, évaluation à
 *     revoir), par priorité (report échu, dépassée, proche, documentée,
 *     autre) puis du plus anciennement examiné ; une échéance examinée
 *     (`t6_candidate_examinations`, écrit par la pré-génération du compte)
 *     laisse sa place à la suivante. Aucune n'occupe durablement la fenêtre ;
 *     `backlog` signale qu'il en reste au-delà (reprise durable) ;
 *   · à part, et bornées, les échéances non dues déjà décidées « à présenter »
 *     (l'affichage reste possible pendant la reprise).
 */
export async function readT6Agenda(accountId: number, today: string, horizonDays = 180): Promise<{ rows: MascotAgendaRow[]; backlog: boolean }> {
  const [ok] = await rows(`SELECT to_regclass('t6_interpellation_assessments') IS NOT NULL AND to_regclass('t6_reminder_preferences') IS NOT NULL AS ok`, []);
  if (!ok?.ok) return { rows: [], backlog: false };
  const filtreT4 = await upcomingDeadlinesSqlFilter('i');
  const t4 = filtreT4 !== '';
  const ex = await t6ExaminationsReady();
  const actif = `(i.manual_status IS NULL OR trim(i.manual_status) = '')
        ${t4 ? filtreT4 : "AND (i.is_automatic = FALSE OR i.occurrence_nature = 'FORECAST')"}`;
  const documents = `(SELECT l2.asset_file_id AS file_id FROM agenda_file_links l2 WHERE l2.agenda_item_id = i.id
                       UNION SELECT i.origin_ref_id WHERE i.origin_ref_type = 'asset_file' AND i.origin_ref_id IS NOT NULL)`;
  const r = await rows(
    `WITH principal AS (
       SELECT i.id FROM agenda_items i
        WHERE i.account_id = $1 AND ${actif}
          AND i.start_date >= ($2::date - $3::int) AND i.start_date <= ($2::date + $4::int)
        ORDER BY i.start_date ASC, i.id ASC LIMIT ${AGENDA_LIMIT}
     ),
     base AS (
       SELECT ${agendaColumns(t4)},
              (i.start_date < $2::date - $3::int) AS "longOverdue",
              (d.n > 0) AS "hasDocs", (k.faits IS NOT NULL) AS "hasFacts",
              t.id AS "assessmentId", t.decision AS "assessmentDecision",
              -- Lot 75E : logique à deux valeurs (une date absente n'efface jamais la ligne des deux groupes).
              (t.id IS NOT NULL AND (t.assessed_on < $2::date - ${T6_ASSESSMENT_MAX_AGE_DAYS} OR coalesce(t.reevaluate_on <= $2::date, FALSE) OR t.contract_version IS NULL)) AS "assessmentStale",
              EXISTS (SELECT 1 FROM t6_reminder_preferences p WHERE p.account_id = i.account_id AND p.agenda_item_id = i.id AND p.decision = 'SNOOZED') AS "snoozed",
              EXISTS (SELECT 1 FROM t6_reminder_preferences p WHERE p.account_id = i.account_id AND p.agenda_item_id = i.id AND p.decision = 'SNOOZED' AND p.remind_at <= $2::date) AS "snoozeDue",
              -- Lot 76A (P1) : mêmes données que le contexte transmis à EVALUATE — bien
              -- rattaché, rôle de la date, document d'origine, contenu des faits.
              md5(concat_ws('|', i.title, i.start_date::text, i.end_date::text, coalesce(i.description, ''), i.occurrence_nature,
                            i.requires_qualification::text, coalesce(i.series_key, ''), coalesce(d.docs, ''), coalesce(k.faits, ''),
                            coalesce(l.asset_id::text, ''), coalesce(a.name, ''), coalesce(a.category, ''),
                            coalesce(i.is_automatic::text, ''), coalesce(i.projection_origin, ''), coalesce(to_char(i.start_time, 'HH24:MI'), ''),
                            coalesce(i.origin_type, ''), coalesce(i.origin_field_key, ''), coalesce(i.origin_ref_type, '') || ':' || coalesce(i.origin_ref_id::text, '')
                            ${t4 ? ", coalesce(i.event_nature, '')" : ''})) AS "selectionSignature",
              ${ex ? 'x.examined_at AS "examinedAt", x.recheck_on AS "recheckOn", x.selection_signature AS "examinedSignature"'
                : 'NULL::timestamptz AS "examinedAt", NULL::date AS "recheckOn", NULL::text AS "examinedSignature"'},
              i.start_date AS sd
         FROM agenda_items i
         ${AGENDA_ASSET_JOIN}
         LEFT JOIN t6_interpellation_assessments t ON t.account_id = i.account_id AND t.agenda_item_id = i.id
         ${ex ? 'LEFT JOIN t6_candidate_examinations x ON x.account_id = i.account_id AND x.agenda_item_id = i.id' : ''}
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS n, string_agg(f.id::text || ':' || md5(coalesce(f.retained_title, '') || '|' || coalesce(f.original_filename, '')), ',' ORDER BY f.id) AS docs
             FROM asset_files f WHERE f.account_id = i.account_id AND f.deleted_at IS NULL AND f.id IN ${documents}
         ) d ON TRUE
         LEFT JOIN LATERAL (
           SELECT string_agg(x2.id::text || ':' || coalesce(x2.confidence, '') || ':' || md5(concat_ws('|', x2.label,
                    left(COALESCE(NULLIF(x2.normalized_value, ''), NULLIF(x2.value_text, ''), x2.value_number::text, x2.value_json::text), 200),
                    left(x2.excerpt, 400), x2.provenance)), ',' ORDER BY x2.id) AS faits
             FROM document_facts x2
             JOIN asset_files f2 ON f2.id = x2.file_id AND f2.account_id = i.account_id AND f2.deleted_at IS NULL
            WHERE x2.account_id = i.account_id AND x2.status = 'active' AND x2.file_id IN ${documents}
              AND (coalesce(x2.canonical_key, '') || ' ' || x2.fact_key || ' ' || coalesce(x2.label, '')) ~* $6
         ) k ON TRUE
        WHERE i.account_id = $1 AND ${actif}
          AND i.id NOT IN (SELECT id FROM principal)
          AND i.start_date >= ($2::date - $5::int) AND i.start_date <= ($2::date + $4::int)
          AND NOT EXISTS (SELECT 1 FROM to_process_actions x3 WHERE x3.account_id = i.account_id AND x3.resolved_at IS NULL
                           AND x3.target_type = 'AGENDA_ITEM' AND x3.target_id = i.id)
     ),
     eligibles AS (
       SELECT c.*,
              (c."examinedSignature" IS DISTINCT FROM c."selectionSignature") AS "changed",
              (c."examinedAt" IS NULL OR c."examinedSignature" IS DISTINCT FROM c."selectionSignature" OR coalesce(c."recheckOn" <= $2::date, FALSE) OR c."snoozeDue"
               OR (c."assessmentStale" AND NOT (c."longOverdue" AND c."assessmentDecision" IS NOT DISTINCT FROM 'SUPPRESS'))) AS "due"
         FROM base c
        WHERE (c."longOverdue" AND c."occurrenceNature" IS DISTINCT FROM 'FORECAST' AND (
                 c."assessmentDecision" IN ('SHOW_NOW', 'DEFER') OR c.snoozed
                 OR (c."assessmentId" IS NULL AND (c."requiresQualification" OR c."hasFacts"))
                 -- Lot 75E (A) : écartée, mais ses données ont changé depuis son dernier examen.
                 OR (c."assessmentDecision" = 'SUPPRESS' AND c."examinedSignature" IS DISTINCT FROM c."selectionSignature")))
           OR (NOT c."longOverdue" AND (c."assessmentId" IS NULL OR c."assessmentDecision" IS DISTINCT FROM 'SUPPRESS' OR c."assessmentStale" OR c.snoozed
                 OR c."examinedSignature" IS DISTINCT FROM c."selectionSignature"))
     )
     (SELECT *, TRUE AS "inQueue" FROM eligibles WHERE "due"
       ORDER BY CASE WHEN "snoozeDue" THEN 0
                     WHEN "longOverdue" THEN 1
                     WHEN sd <= $2::date + $7::int THEN 2
                     WHEN "hasDocs" THEN 3 ELSE 4 END,
                "examinedAt" ASC NULLS FIRST, sd ASC, id ASC
       LIMIT ${T6_AGENDA_EXTRA_LIMIT + 1})
     UNION ALL
     (SELECT *, FALSE FROM eligibles WHERE NOT "due" AND "assessmentDecision" = 'SHOW_NOW'
       ORDER BY sd ASC, id ASC LIMIT ${T6_AGENDA_SHOWN_LIMIT})`,
    [accountId, today, EXT_ACTION_LOOKBACK_DAYS, AGENDA_FORWARD_DAYS, T6_OVERDUE_MAX_LOOKBACK_DAYS, T6_RELEVANT_FACT_PATTERN, horizonDays],
  );
  const file = r.filter((x) => x.inQueue === true);
  const backlog = file.length > T6_AGENDA_EXTRA_LIMIT;
  const lues = backlog ? [...file.slice(0, T6_AGENDA_EXTRA_LIMIT), ...r.filter((x) => x.inQueue !== true)] : r;
  return { rows: agendaRowsOf(lues), backlog };
}

/** Échéances dépassées lues au plus (au-delà : la présence suffit, jamais un total affiché). */
const OVERDUE_AGENDA_LIMIT = 200;

/**
 * Lot 53 (retour PO D25) : TOUTES les échéances « action » ouvertes dont la
 * date est dépassée — sans la fenêtre de 60 jours des sujets ni la limite
 * de deux sujets. La bulle ne dit jamais « aucune échéance dépassée » ou
 * « tout est à jour » tant qu'il en reste une (identifiants et dates seuls).
 */
async function readOverdueAgenda(accountId: number, today: string): Promise<Array<{ id: number; date: string }>> {
  const filtreT4 = await upcomingDeadlinesSqlFilter('i');
  const t4 = filtreT4 !== '';
  const r = await rows(
    `SELECT i.id, to_char(i.start_date, 'YYYY-MM-DD') AS date, i.title,
            i.home_category AS "homeCategory", i.origin_type AS "originType", i.origin_field_key AS "originFieldKey"
            ${t4 ? ', i.event_nature AS "eventNature", i.business_type AS "businessType"' : ''}
       FROM agenda_items i
      WHERE i.account_id = $1
        AND (i.manual_status IS NULL OR trim(i.manual_status) = '')
        ${t4 ? filtreT4 : "AND (i.is_automatic = FALSE OR i.occurrence_nature = 'FORECAST')"}
        AND coalesce(greatest(i.end_date, i.start_date), i.start_date) < $2::date
      ORDER BY i.start_date DESC, i.id DESC
      LIMIT ${OVERDUE_AGENDA_LIMIT}`,
    [accountId, today],
  );
  return r
    .filter((i) => isAgendaActionItemT4({
      homeCategory: (i.homeCategory as string | null) ?? null, originType: String(i.originType ?? 'manual'), title: String(i.title ?? ''),
      eventNature: (i.eventNature as string | null | undefined) ?? null, businessType: (i.businessType as string | null | undefined) ?? null,
      originFieldKey: (i.originFieldKey as string | null | undefined) ?? null,
    }))
    .map((i) => ({ id: Number(i.id), date: String(i.date) }));
}

/** ATP-004 : toutes les échéances déjà portées par une action ouverte (ids seuls). */
async function readToProcessAgendaIds(accountId: number): Promise<number[]> {
  const r = await rows(
    `SELECT DISTINCT target_id FROM to_process_actions
      WHERE account_id = $1 AND resolved_at IS NULL AND target_type = 'AGENDA_ITEM'
      LIMIT ${TO_PROCESS_AGENDA_IDS_LIMIT}`,
    [accountId],
  );
  return r.map((x) => Number(x.target_id));
}

/**
 * Lot 61 — échéances « réglées » par le moteur « À traiter »
 * (voir `MascotRawData.toProcessSettledAgendaIds`). Lot 72 (ATP-FIX-17) :
 * lecture COMMUNE `settled-obligations.ts` — clé rapprochée par le registre
 * (alias), issues lot 61, intervention tranchée par l'utilisateur quelle que
 * soit la date. Tables absentes (0418) : aucune (comportement antérieur).
 */
async function readToProcessSettledAgendaIds(accountId: number, today: string): Promise<number[]> {
  const { toProcessSettledAgendaIds } = await import('@/services/to-process/settled-obligations');
  return toProcessSettledAgendaIds(accountId, today, TO_PROCESS_AGENDA_IDS_LIMIT);
}

/**
 * REC-005 : droits effectifs et volumes comptés comme les gardes serveur
 * (`POST /api/assets` : tous les biens du compte ; `files/presign` : documents
 * non supprimés, envoi terminé).
 */
async function readRights(accountId: number): Promise<MascotRights> {
  const [ent, [c]] = await Promise.all([
    getEntitlements(accountId),
    rows(
      `SELECT (SELECT COUNT(*) FROM assets WHERE account_id = $1)::int AS assets,
              (SELECT COUNT(*) FROM asset_files
                WHERE account_id = $1 AND deleted_at IS NULL
                  AND COALESCE(upload_status, 'COMPLETED') = 'COMPLETED')::int AS documents`,
      [accountId],
    ),
  ]);
  return mascotRightsFrom(ent, { assets: Number(c?.assets ?? 0), documents: Number(c?.documents ?? 0) });
}

async function readAcknowledgments(accountId: number): Promise<Array<{ occurrenceKey: string; cycleKey: string }>> {
  const r = await rows(
    `SELECT occurrence_key AS "occurrenceKey", cycle_key AS "cycleKey"
       FROM home_mascot_acknowledgments
      WHERE account_id = $1 AND undone_at IS NULL`,
    [accountId],
  );
  return r.map((a) => ({ occurrenceKey: String(a.occurrenceKey), cycleKey: String(a.cycleKey) }));
}

/** Lit toutes les sources, en parallèle ; une source en échec vaut `null`. */
export async function collectMascotData(accountId: number, now: Date = new Date()): Promise<MascotRawData> {
  const today = todayParis(now);
  const safe = async <T>(nom: string, f: () => Promise<T>): Promise<T | null> => {
    try {
      return await f();
    } catch (e) {
      console.error(`[mascotte] source « ${nom} » indisponible :`, (e as Error).message);
      return null;
    }
  };
  const [processing, onboarding, toProcess, toProcessAgendaIds, agenda, acknowledgments, rights, overdueAgenda, settled, t6Agenda] = await Promise.all([
    safe('traitements', () => readProcessing(accountId)),
    safe('onboarding', () => readOnboarding(accountId)),
    // NFR-001 : tête de file seulement, dans l'ordre « Par priorité » du service.
    safe('à traiter', () => getToProcessPage(accountId, {
      orderMode: 'BY_PRIORITY', limit: MASCOT_TO_PROCESS_LIMIT,
    })),
    safe('à traiter (échéances)', () => readToProcessAgendaIds(accountId)),
    safe('agenda', () => readAgenda(accountId, today)),
    safe('acquittements', () => readAcknowledgments(accountId)),
    safe('droits', () => readRights(accountId)),
    safe('échéances dépassées', () => readOverdueAgenda(accountId, today)),
    // Lot 61 : décisions « À traiter » que T6 ne doit pas contredire.
    safe('à traiter (décisions)', () => readToProcessSettledAgendaIds(accountId, today)),
    // Lot 71G : échéances que seule l'évaluation T6 examine (anciennes, lointaines, reprise).
    safe('échéances T6', () => readT6Agenda(accountId, today)),
  ]);
  return {
    accountId, today, processing, onboarding, agenda, acknowledgments,
    // Lot 32 (MASC2) : la tête de file ET son total (= pastille, = page).
    toProcess: toProcess?.actions ?? null,
    toProcessTotal: toProcess?.total ?? null,
    // Échéances d'actions ouvertes : en échec, la file lue suffit (repli sur `toProcess`).
    toProcessAgendaIds,
    toProcessSettledAgendaIds: settled,
    rights,
    overdueAgenda,
    t6Agenda: t6Agenda ? t6Agenda.rows : null,
    // Lot 75E (B) : file d'examen T6 plus longue que la lecture (reprise durable).
    t6AgendaBacklog: t6Agenda?.backlog ?? false,
  };
}
