/**
 * Agenda lu comme objet métier — CDC 15 T2-15, T2-26 (lot 15), D-14.
 *
 *  · `getCanonicalAgendaItem(accountId, id)` : titre, date, nature
 *    (HISTORICAL | DEADLINE), type métier, statut à 4 états, occurrence
 *    prévisionnelle, catégorie, biens liés, documents sources ;
 *  · `listUpcomingAgenda(accountId, opts)` : prochaines échéances dans une
 *    fenêtre paramétrable, triées, statut prévisionnel — les éléments
 *    HISTORICAL n'en font JAMAIS partie (D-14), ni les éléments clos.
 *
 * STATUT À 4 ÉTATS (T4-12, correspondance de A, arbitrage lot 15) :
 *   completed      marqué « réalisé » ;
 *   not_completed  marqué « annulé » (n'aura pas lieu) ;
 *   unknown        ouvert, date à venir (ou sans date) — rien ne peut encore
 *                  être établi —, ou date passée avec une carte « réalisée ? /
 *                  non réalisée ? » en attente de la réponse de l'utilisateur ;
 *   not_proven     ouvert, date PASSÉE, aucune preuve de réalisation ni carte
 *                  en attente — une date passée ne prouve rien (U2).
 */
import { pgClient } from '@/db';
import { resolveEventSemantics } from '@/services/agenda/agenda-functional-key';
import { agendaFunctionalColumnsReady } from '@/services/agenda/agenda-columns';
import { CANONICAL_FIELDS } from '@/services/canonical/registry';
import type { RetrievedSource } from '../types/sources';

/** Champs du registre dont l'effet agenda est un fait passé (D-14). */
export const HISTORICAL_FIELD_KEYS: readonly string[] = CANONICAL_FIELDS
  .filter((d) => d.agendaEffect?.nature === 'HISTORICAL').map((d) => d.key);

/**
 * Condition SQL « élément non historique » (D-14) : nature 0223, sinon
 * champ d'origine du registre. `$param` : `HISTORICAL_FIELD_KEYS`.
 */
export const NOT_HISTORICAL = (col: boolean, param: string) =>
  `coalesce(${col ? 'i.event_nature' : 'NULL::text'}, CASE WHEN i.origin_field_key = ANY(${param}::text[]) THEN 'HISTORICAL' END, '') <> 'HISTORICAL'`;

export type AgendaStatus4 = 'completed' | 'not_completed' | 'unknown' | 'not_proven';

export interface CanonicalAgendaItem {
  id: number;
  title: string;
  date: string | null;
  nature: 'HISTORICAL' | 'DEADLINE' | null;
  businessType: string | null;
  status: AgendaStatus4;
  /** `manual_status` brut (realise | annule | null). */
  manualStatus: string | null;
  /** Occurrence prévisionnelle (récurrence calculée, pas encore confirmée). */
  forecast: boolean;
  category: string | null;
  isAutomatic: boolean;
  /** Élément automatique modifié par l'utilisateur. */
  userModified: boolean;
  overdue: boolean;
  assets: Array<{ assetId: number; name: string }>;
  sources: Array<{ fileId: number; title: string; role: string | null }>;
}

/** Statut à 4 états (pur, testé). `date` / `today` : `AAAA-MM-JJ`. */
export function agendaStatus4(
  manualStatus: string | null,
  pendingStatusCard: boolean,
  date: string | null,
  today: string,
): AgendaStatus4 {
  if (manualStatus === 'realise') return 'completed';
  if (manualStatus === 'annule') return 'not_completed';
  if (!date || date >= today) return 'unknown';
  return pendingStatusCard ? 'unknown' : 'not_proven';
}

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/** Élément d'agenda du compte, lu comme objet métier ; `null` hors compte. */
export async function getCanonicalAgendaItem(accountId: number, itemId: number): Promise<CanonicalAgendaItem | null> {
  const col = await agendaFunctionalColumnsReady().catch(() => false);
  const [r] = (await pgClient.unsafe(
    `SELECT i.id, i.title, to_char(i.start_date, 'YYYY-MM-DD') AS date, i.manual_status AS "manualStatus",
            i.occurrence_nature AS "occurrenceNature", i.home_category AS category, i.is_automatic AS "isAutomatic",
            i.is_automatic_modified AS "isAutomaticModified", i.origin_field_key AS "originFieldKey",
            ${col ? 'i.event_nature' : 'NULL::text'} AS "eventNature", ${col ? 'i.business_type' : 'NULL::text'} AS "businessType",
            EXISTS (SELECT 1 FROM to_process_actions t WHERE t.account_id = i.account_id AND t.target_type = 'AGENDA_ITEM'
                     AND t.target_id = i.id AND t.field_key = 'manualStatus' AND t.resolved_at IS NULL) AS "pendingCard"
       FROM agenda_items i WHERE i.id = $1 AND i.account_id = $2`,
    [itemId, accountId] as never[],
  )) as unknown as Array<{
    id: number; title: string; date: string | null; manualStatus: string | null; occurrenceNature: string | null; category: string | null;
    isAutomatic: boolean; isAutomaticModified: boolean; originFieldKey: string | null; eventNature: string | null; businessType: string | null;
    pendingCard: boolean;
  }>;
  if (!r) return null;
  const [assets, sources] = await Promise.all([
    pgClient.unsafe(
      `SELECT a.id AS "assetId", a.name FROM agenda_asset_links l
         JOIN assets a ON a.id = l.asset_id AND a.account_id = $2 AND a.deleted_at IS NULL
        WHERE l.agenda_item_id = $1 ORDER BY a.name`,
      [itemId, accountId] as never[],
    ) as unknown as Promise<Array<{ assetId: number; name: string }>>,
    agendaSourcesOf(accountId, itemId),
  ]);
  const sem = resolveEventSemantics({ originFieldKey: r.originFieldKey, businessType: r.businessType });
  const status = agendaStatus4(r.manualStatus || null, r.pendingCard, r.date, today());
  return {
    id: Number(r.id), title: r.title, date: r.date,
    nature: (r.eventNature as CanonicalAgendaItem['nature']) ?? sem.nature,
    businessType: r.businessType ?? sem.businessType,
    status, manualStatus: r.manualStatus || null,
    forecast: r.occurrenceNature === 'FORECAST',
    category: r.category, isAutomatic: r.isAutomatic, userModified: r.isAutomatic && r.isAutomaticModified,
    overdue: !!r.date && r.date < today() && (status === 'not_proven' || status === 'unknown'),
    assets, sources,
  };
}

/** Documents d'un élément : liens affichés et traces du service de liaison. */
async function agendaSourcesOf(accountId: number, itemId: number): Promise<CanonicalAgendaItem['sources']> {
  const rows = (await pgClient.unsafe(
    `SELECT DISTINCT ON (f.id) f.id AS "fileId", coalesce(f.retained_title, f.original_filename, 'Document') AS title, s.role
       FROM (
         SELECT asset_file_id AS fid, NULL::text AS role FROM agenda_file_links WHERE agenda_item_id = $1
         UNION ALL
         SELECT asset_file_id, 'SOURCE'
           FROM agenda_item_sources WHERE agenda_item_id = $1 AND effect_type IN ('created', 'resolved_existing', 'linked')
       ) s
       JOIN asset_files f ON f.id = s.fid AND f.account_id = $2 AND f.deleted_at IS NULL
      ORDER BY f.id, s.role NULLS LAST`,
    [itemId, accountId] as never[],
  ).catch(() => [])) as unknown as Array<{ fileId: number; title: string; role: string | null }>;
  return rows;
}

export interface UpcomingAgendaRow {
  id: number;
  title: string;
  date: string;
  forecast: boolean;
  assetNames: string[];
  businessType: string | null;
}

/**
 * Prochaines échéances (T2-15) : de `from` (défaut : aujourd'hui) à
 * `from + windowDays` (défaut 90, borné à 730), éléments ouverts seulement,
 * HISTORICAL exclus (colonne 0223, sinon registre du champ d'origine),
 * triées par date. `assetIds` : liens `agenda_asset_links` (T2-16).
 */
export async function listUpcomingAgenda(accountId: number, opts: {
  assetIds?: number[];
  from?: string;
  windowDays?: number | null;
  limit?: number;
  terms?: string[];
} = {}): Promise<UpcomingAgendaRow[]> {
  const col = await agendaFunctionalColumnsReady().catch(() => false);
  const from = opts.from ?? today();
  const jours = opts.windowDays === null ? null : Math.min(Math.max(opts.windowDays ?? 90, 1), 730);
  const ids = opts.assetIds?.length ? opts.assetIds : null;
  const terms = (opts.terms ?? []).filter((t) => t.length >= 3).slice(0, 6);
  const termSql = terms.map((_, i) => `unaccent(lower(i.title || ' ' || coalesce(i.description,''))) LIKE unaccent(lower($${i + 7}))`).join(' AND ');
  const rows = (await pgClient.unsafe(
    `SELECT i.id, i.title, to_char(i.start_date, 'YYYY-MM-DD') AS date, (i.occurrence_nature = 'FORECAST') AS forecast,
            i.origin_field_key AS "originFieldKey", ${col ? 'i.business_type' : 'NULL::text'} AS "businessType",
            coalesce(array_remove(array_agg(DISTINCT a.name), NULL), '{}') AS "assetNames"
       FROM agenda_items i
       LEFT JOIN agenda_asset_links l ON l.agenda_item_id = i.id
       LEFT JOIN assets a ON a.id = l.asset_id AND a.deleted_at IS NULL
      WHERE i.account_id = $1 AND (i.manual_status IS NULL OR i.manual_status = '')
        AND i.start_date >= $2::date
        AND ($3::int IS NULL OR i.start_date <= $2::date + $3::int)
        AND ($4::int[] IS NULL OR EXISTS (SELECT 1 FROM agenda_asset_links x WHERE x.agenda_item_id = i.id AND x.asset_id = ANY($4::int[])))
        AND ${NOT_HISTORICAL(col, '$6')}
        ${termSql ? `AND ${termSql}` : ''}
      GROUP BY i.id
      ORDER BY i.start_date ASC, i.id ASC
      LIMIT $5`,
    [accountId, from, jours, ids, Math.min(Math.max(opts.limit ?? 10, 1), 50), [...HISTORICAL_FIELD_KEYS], ...terms.map((t) => `%${t}%`)] as never[],
  )) as unknown as Array<UpcomingAgendaRow & { originFieldKey: string | null }>;
  return rows.map(({ id, title, date, forecast, assetNames, businessType, originFieldKey }) => ({
    id: Number(id), title, date, forecast: !!forecast, assetNames,
    businessType: businessType ?? resolveEventSemantics({ originFieldKey }).businessType,
  }));
}

/** Nombre d'échéances à venir (mêmes règles que `listUpcomingAgenda`, sans fenêtre). */
export async function countUpcomingAgenda(accountId: number, opts: { assetIds?: number[]; from?: string } = {}): Promise<number> {
  const col = await agendaFunctionalColumnsReady().catch(() => false);
  const ids = opts.assetIds?.length ? opts.assetIds : null;
  const [r] = (await pgClient.unsafe(
    `SELECT count(*)::int AS n FROM agenda_items i
      WHERE i.account_id = $1 AND (i.manual_status IS NULL OR i.manual_status = '') AND i.start_date >= $2::date
        AND ($3::int[] IS NULL OR EXISTS (SELECT 1 FROM agenda_asset_links x WHERE x.agenda_item_id = i.id AND x.asset_id = ANY($3::int[])))
        AND ${NOT_HISTORICAL(col, '$4')}`,
    [accountId, opts.from ?? today(), ids, [...HISTORICAL_FIELD_KEYS]] as never[],
  )) as unknown as Array<{ n: number }>;
  return Number(r?.n ?? 0);
}

/** Source d'un élément d'agenda (statut et nature compris). */
export function canonicalAgendaSource(i: CanonicalAgendaItem): RetrievedSource {
  const STATUT: Record<AgendaStatus4, string> = {
    completed: 'réalisé', not_completed: 'annulé', unknown: 'à venir ou réalisation à confirmer', not_proven: 'date passée, réalisation non prouvée',
  };
  return {
    id: `agenda_${i.id}`, type: 'agenda_item', title: i.title,
    content: [i.date, STATUT[i.status], i.nature === 'HISTORICAL' ? 'fait passé' : null, i.forecast ? 'date prévisionnelle' : null,
      i.assets.map((a) => a.name).join(', ') || null].filter(Boolean).join(' · '),
    relevanceScore: 1,
    meta: { date: i.date, status: i.status, nature: i.nature, forecast: i.forecast, businessType: i.businessType },
  };
}
