/**
 * SignalCollector, lecture — CDC Mascotte §5, §7, NFR-001.
 *
 * Lit les sources de vérité existantes, en parallèle et bornées, sans rien
 * écrire (GEN-002). Chaque source est lue isolément : une source en panne
 * vaut `null`, jamais « rien à signaler » (§20, ERR-01).
 */
import { pgClient } from '@/db';
import { getToProcessPage } from '@/services/to-process/to-process-query.service';
import type { MascotAgendaRow, MascotDocRow, MascotExportRow, MascotRawData } from './signals';
import { EXT_ACTION_LOOKBACK_DAYS } from './signals';

/** Un envoi ou une analyse bloqués depuis plus longtemps ne sont plus « en cours ». */
const PROCESSING_WINDOW_HOURS = 24;
/** Horizon de l'agenda lu pour la prochaine date. */
const AGENDA_FORWARD_DAYS = 730;

export function todayParis(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/**
 * Échéance « action » (et non simple information) — même règle que le bloc
 * « Prochaines dates » de l'accueil, définie ici une seule fois.
 */
export function isAgendaActionItem(item: { homeCategory: string | null; originType: string; title: string }): boolean {
  if (item.homeCategory === 'action') return true;
  if (item.homeCategory === 'information') return false;
  // Non classée : les dates passives (fin d'assurance, reconduction tacite) sont de l'information.
  if (/fin.*(p.riode|contrat).*assurance|reconduction|renouvellement.*auto/i.test(item.title)) return false;
  return item.originType !== 'asset_field';
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
        WHERE e.account_id = $1 AND e.status IN ('pending', 'generating')
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
  const r = await rows(
    `SELECT i.id, i.title, to_char(i.start_date, 'YYYY-MM-DD') AS date,
            i.occurrence_nature AS "occurrenceNature", i.requires_qualification AS "requiresQualification",
            i.home_category AS "homeCategory", i.origin_type AS "originType",
            l.asset_id AS "assetId", a.name AS "assetName"
       FROM agenda_items i
       LEFT JOIN LATERAL (
         SELECT asset_id FROM agenda_asset_links WHERE agenda_item_id = i.id ORDER BY asset_id LIMIT 1
       ) l ON TRUE
       LEFT JOIN assets a ON a.id = l.asset_id AND a.deleted_at IS NULL
      WHERE i.account_id = $1
        AND (i.manual_status IS NULL OR trim(i.manual_status) = '')
        AND (i.is_automatic = FALSE OR i.occurrence_nature = 'FORECAST')
        AND i.start_date >= ($2::date - $3::int)
        AND i.start_date <= ($2::date + $4::int)
      ORDER BY i.start_date ASC, i.id ASC
      LIMIT 200`,
    [accountId, today, EXT_ACTION_LOOKBACK_DAYS, AGENDA_FORWARD_DAYS],
  );
  return r
    .filter((i) => isAgendaActionItem({
      homeCategory: (i.homeCategory as string | null) ?? null,
      originType: String(i.originType ?? 'manual'),
      title: String(i.title ?? ''),
    }))
    .map((i) => ({
      id: Number(i.id),
      title: String(i.title),
      date: (i.date as string | null) ?? null,
      forecast: i.occurrenceNature === 'FORECAST',
      requiresQualification: Boolean(i.requiresQualification),
      assetId: i.assetId == null ? null : Number(i.assetId),
      assetName: (i.assetName as string | null) ?? null,
    }));
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
  const [processing, onboarding, toProcess, agenda, acknowledgments] = await Promise.all([
    safe('traitements', () => readProcessing(accountId)),
    safe('onboarding', () => readOnboarding(accountId)),
    safe('à traiter', async () => (await getToProcessPage(accountId, { orderMode: 'BY_PRIORITY' })).actions),
    safe('agenda', () => readAgenda(accountId, today)),
    safe('acquittements', () => readAcknowledgments(accountId)),
  ]);
  return { accountId, today, processing, onboarding, toProcess, agenda, acknowledgments };
}
