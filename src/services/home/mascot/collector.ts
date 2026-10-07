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
import { classifyByRules } from '@/services/ai/agenda/rules/deterministic-classification';

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
  if (item.eventNature === 'HISTORICAL') return false;
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
         FROM asset_files
        WHERE account_id = $1 AND deleted_at IS NULL
          AND analysis_state IN ('UPLOADED', 'ANALYZING')
          AND COALESCE(upload_status, 'COMPLETED') = 'COMPLETED'
          AND COALESCE(updated_at, created_at) > NOW() - $2::interval
        ORDER BY at DESC LIMIT 20`,
      [accountId, fenetre],
    ),
    rows(
      `SELECT e.id, e.export_type AS "exportType", e.asset_id AS "assetId", a.name AS "assetName",
              e.created_at AS at
         FROM export_generation e
         JOIN assets a ON a.id = e.asset_id
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
          AND COALESCE(status, 'EN_SERVICE') NOT IN ('ARCHIVED', 'TRANSMIS')
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

async function readAgenda(accountId: number, today: string): Promise<MascotAgendaRow[]> {
  // 0223 appliquée : les échéances AUTOMATIQUES sont lues aussi, les faits
  // HISTORICAL jamais (D-14) — filtre de B. 0223 absente : automatiques
  // exclus hors prévisions, faute de nature pour écarter les faits passés.
  const filtreT4 = await upcomingDeadlinesSqlFilter('i');
  const t4 = filtreT4 !== '';
  const r = await rows(
    `SELECT i.id, i.title, to_char(i.start_date, 'YYYY-MM-DD') AS date,
            i.occurrence_nature AS "occurrenceNature", i.requires_qualification AS "requiresQualification",
            i.home_category AS "homeCategory", i.origin_type AS "originType",
            i.origin_field_key AS "originFieldKey",
            ${t4 ? 'i.event_nature AS "eventNature", i.business_type AS "businessType",' : ''}
            l.asset_id AS "assetId", a.name AS "assetName",
            a.category AS "assetCategory", a.subtype AS "assetSubtype"
       FROM agenda_items i
       LEFT JOIN LATERAL (
         SELECT asset_id FROM agenda_asset_links WHERE agenda_item_id = i.id ORDER BY asset_id LIMIT 1
       ) l ON TRUE
       LEFT JOIN assets a ON a.id = l.asset_id AND a.deleted_at IS NULL
      WHERE i.account_id = $1
        AND (i.manual_status IS NULL OR trim(i.manual_status) = '')
        ${t4 ? filtreT4 : "AND (i.is_automatic = FALSE OR i.occurrence_nature = 'FORECAST')"}
        AND i.start_date >= ($2::date - $3::int)
        AND i.start_date <= ($2::date + $4::int)
      ORDER BY i.start_date ASC, i.id ASC
      LIMIT 200`,
    [accountId, today, EXT_ACTION_LOOKBACK_DAYS, AGENDA_FORWARD_DAYS],
  );
  const classer = (i: Row): HomeAgendaItemForClassification => ({
    homeCategory: (i.homeCategory as string | null) ?? null,
    originType: String(i.originType ?? 'manual'),
    title: String(i.title ?? ''),
    eventNature: (i.eventNature as string | null | undefined) ?? null,
    businessType: (i.businessType as string | null | undefined) ?? null,
    originFieldKey: (i.originFieldKey as string | null | undefined) ?? null,
  });
  return r
    .filter((i) => isAgendaActionItemT4(classer(i)))
    .map((i) => ({
      id: Number(i.id),
      title: String(i.title),
      date: (i.date as string | null) ?? null,
      forecast: i.occurrenceNature === 'FORECAST',
      requiresQualification: Boolean(i.requiresQualification),
      assetId: i.assetId == null ? null : Number(i.assetId),
      assetName: (i.assetName as string | null) ?? null,
      assetCategory: (i.assetCategory as string | null) ?? null,
      assetSubtype: (i.assetSubtype as string | null) ?? null,
    }));
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
  const [processing, onboarding, toProcess, toProcessAgendaIds, agenda, acknowledgments, rights] = await Promise.all([
    safe('traitements', () => readProcessing(accountId)),
    safe('onboarding', () => readOnboarding(accountId)),
    // NFR-001 : tête de file seulement, dans l'ordre « Par priorité » du service.
    safe('à traiter', async () => (await getToProcessPage(accountId, {
      orderMode: 'BY_PRIORITY', limit: MASCOT_TO_PROCESS_LIMIT,
    })).actions),
    safe('à traiter (échéances)', () => readToProcessAgendaIds(accountId)),
    safe('agenda', () => readAgenda(accountId, today)),
    safe('acquittements', () => readAcknowledgments(accountId)),
    safe('droits', () => readRights(accountId)),
  ]);
  return {
    accountId, today, processing, onboarding, toProcess, agenda, acknowledgments,
    // Échéances d'actions ouvertes : en échec, la file lue suffit (repli sur `toProcess`).
    toProcessAgendaIds,
    rights,
  };
}
