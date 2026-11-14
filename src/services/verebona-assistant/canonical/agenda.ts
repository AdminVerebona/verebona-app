/**
 * Agenda lu comme objet métier — CDC 15 T2-15, T2-26 (lot 15), D-14.
 *
 *  · `getCanonicalAgendaItem(accountId, id)` : titre, date, nature
 *    (HISTORICAL | DEADLINE), type métier, occurrence prévisionnelle,
 *    catégorie, biens liés, documents sources ;
 *  · `listUpcomingAgenda(accountId, opts)` : prochaines échéances dans une
 *    fenêtre paramétrable, triées, statut prévisionnel — les éléments
 *    HISTORICAL n'en font JAMAIS partie (D-14).
 *
 * Lot 113P (#715, décision PO du 06/11/2026) : un événement n'a PLUS de
 * statut — l'ancien « statut à 4 états » (`completed`, `not_completed`,
 * `unknown`, `not_proven`) et `overdue` sont SUPPRIMÉS du contrat lu par
 * l'assistant (T2) et par les exports : la date situe l'événement ; une date
 * passée ne dit ni réalisation ni retard.
 */
import { documentTitleJsonSql, withDocumentTitles } from '@/lib/documents/document-title-source';
import { pgClient } from '@/db';
import { resolveEventSemantics } from '@/services/agenda/agenda-functional-key';
import { agendaFunctionalColumnsReady } from '@/services/agenda/agenda-columns';
import { HISTORICAL_FIELD_KEYS, historicalSql } from '@/services/agenda/agenda-historical';
import { agendaDateRole, type AgendaDateRole } from '@/services/agenda/agenda-date-role';
import { situationOf, type AgendaSituation } from '@/lib/agenda/situation';
import type { RetrievedSource } from '../types/sources';

/** Champs du registre dont l'effet agenda est un fait passé (D-14) — règle partagée (lot 47B). */
export { HISTORICAL_FIELD_KEYS };

/**
 * Condition SQL « élément non historique » (D-14) : nature 0223, sinon
 * champ d'origine du registre, sinon type métier exclusivement historique —
 * jumeau SQL de la règle partagée `agenda-historical` (lot 47B). `$param` :
 * `HISTORICAL_FIELD_KEYS`.
 */
export const NOT_HISTORICAL = (col: boolean, param: string) => `NOT ${historicalSql('i', col, param)}`;

export interface CanonicalAgendaItem {
  id: number;
  title: string;
  date: string | null;
  nature: 'HISTORICAL' | 'DEADLINE' | null;
  businessType: string | null;
  /** Occurrence prévisionnelle (récurrence calculée, pas encore confirmée). */
  forecast: boolean;
  category: string | null;
  isAutomatic: boolean;
  /** Élément automatique modifié par l'utilisateur. */
  userModified: boolean;
  /**
   * Lot 53 (D27) : date à respecter (DEADLINE) ou événement saisi par
   * l'utilisateur (SCHEDULED_EVENT) — règle partagée avec la mascotte.
   */
  dateRole?: AgendaDateRole;
  /**
   * Lot 114V (#742) : « Situation de l'événement » qualifiée par l'utilisateur
   * (`A_PREVOIR` / `A_EU_LIEU`) ; `null` / absente : non qualifiée. Renseignée
   * par `getCanonicalAgendaItem` (élément ciblé).
   */
  situation?: AgendaSituation | null;
  assets: Array<{ assetId: number; name: string }>;
  sources: Array<{ fileId: number; title: string; role: string | null }>;
}

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/** Élément d'agenda du compte, lu comme objet métier ; `null` hors compte. */
export async function getCanonicalAgendaItem(accountId: number, itemId: number): Promise<CanonicalAgendaItem | null> {
  const col = await agendaFunctionalColumnsReady().catch(() => false);
  const [r] = (await pgClient.unsafe(
    `SELECT i.id, i.title, to_char(i.start_date, 'YYYY-MM-DD') AS date,
            i.occurrence_nature AS "occurrenceNature", i.home_category AS category, i.is_automatic AS "isAutomatic",
            i.is_automatic_modified AS "isAutomaticModified", i.origin_field_key AS "originFieldKey",
            i.origin_type AS "originType", to_jsonb(i) ->> 'projection_origin' AS "projectionOrigin",
            to_jsonb(i) ->> 'situation' AS situation,
            ${col ? 'i.event_nature' : 'NULL::text'} AS "eventNature", ${col ? 'i.business_type' : 'NULL::text'} AS "businessType"
       FROM agenda_items i WHERE i.id = $1 AND i.account_id = $2`,
    [itemId, accountId] as never[],
  )) as unknown as Array<{
    id: number; title: string; date: string | null; occurrenceNature: string | null; category: string | null;
    isAutomatic: boolean; isAutomaticModified: boolean; originFieldKey: string | null; eventNature: string | null; businessType: string | null;
    originType: string | null; projectionOrigin: string | null; situation: string | null;
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
  return {
    id: Number(r.id), title: r.title, date: r.date,
    nature: (r.eventNature as CanonicalAgendaItem['nature']) ?? sem.nature,
    businessType: r.businessType ?? sem.businessType,
    forecast: r.occurrenceNature === 'FORECAST',
    category: r.category, isAutomatic: r.isAutomatic, userModified: r.isAutomatic && r.isAutomaticModified,
    dateRole: agendaDateRole({
      forecast: r.occurrenceNature === 'FORECAST', isAutomatic: r.isAutomatic, originType: r.originType ?? 'manual',
      projectionOrigin: r.projectionOrigin, eventNature: r.eventNature,
    }),
    situation: situationOf(r.situation),
    assets, sources,
  };
}

/** Documents d'un élément : liens affichés et traces du service de liaison. */
async function agendaSourcesOf(accountId: number, itemId: number): Promise<CanonicalAgendaItem['sources']> {
  const rows = (await withDocumentTitles(pgClient.unsafe(
    `SELECT DISTINCT ON (f.id) f.id AS "fileId", ${documentTitleJsonSql('f')} AS title, s.role
       FROM (
         SELECT asset_file_id AS fid, NULL::text AS role FROM agenda_file_links WHERE agenda_item_id = $1
         UNION ALL
         SELECT asset_file_id, 'SOURCE'
           FROM agenda_item_sources WHERE agenda_item_id = $1 AND effect_type IN ('created', 'resolved_existing', 'linked')
       ) s
       JOIN asset_files f ON f.id = s.fid AND f.account_id = $2 AND f.deleted_at IS NULL
      ORDER BY f.id, s.role NULLS LAST`,
    [itemId, accountId] as never[],
  )).catch(() => [])) as unknown as Array<{ fileId: number; title: string; role: string | null }>;
  return rows;
}

export interface UpcomingAgendaRow {
  id: number;
  title: string;
  date: string;
  forecast: boolean;
  assetNames: string[];
  businessType: string | null;
  /** Lot 75J (#419 R02) : nature (HISTORICAL / DEADLINE) et champ d'origine — signification de la date. */
  nature?: string | null;
  originFieldKey?: string | null;
  /**
   * Lot 86C : provenance de l'échéance — champ métier qualifié (`FIELD`),
   * projection d'une fin de contrat ÉTABLIE (`OPERATION`), saisie de
   * l'utilisateur (`USER`), ou élément automatique sans provenance
   * contractuelle (`UNPROVEN`) : jamais présenté comme une fin certaine.
   */
  provenance?: AgendaDateProvenance;
}

type AgendaDateProvenance = 'FIELD' | 'OPERATION' | 'USER' | 'UNPROVEN';

/** Lot 86C : provenance d'une date d'agenda (pure, testée). */
export function agendaDateProvenance(r: { originFieldKey?: string | null; projectionOrigin?: string | null; isAutomatic?: boolean | null }): AgendaDateProvenance {
  if (r.originFieldKey) return 'FIELD';
  if (r.projectionOrigin === 'OPERATION') return 'OPERATION';
  if (r.isAutomatic === false) return 'USER';
  return 'UNPROVEN';
}

/**
 * Prochaines échéances (T2-15) : de `from` (défaut : aujourd'hui) à
 * `from + windowDays` (défaut 90, borné à 730) — lot 113P : plus de statut,
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
            i.is_automatic AS "isAutomatic", i.projection_origin AS "projectionOrigin",
            ${col ? 'i.event_nature' : 'NULL::text'} AS "eventNature",
            coalesce(array_remove(array_agg(DISTINCT a.name), NULL), '{}') AS "assetNames"
       FROM agenda_items i
       LEFT JOIN agenda_asset_links l ON l.agenda_item_id = i.id
       -- Lot 49 (SEC-08, T2) : bien du compte seulement.
       LEFT JOIN assets a ON a.id = l.asset_id AND a.account_id = i.account_id AND a.deleted_at IS NULL
      WHERE i.account_id = $1
        AND i.start_date >= $2::date
        AND ($3::int IS NULL OR i.start_date <= $2::date + $3::int)
        AND ($4::int[] IS NULL OR EXISTS (SELECT 1 FROM agenda_asset_links x WHERE x.agenda_item_id = i.id AND x.asset_id = ANY($4::int[])))
        AND ${NOT_HISTORICAL(col, '$6')}
        ${termSql ? `AND ${termSql}` : ''}
      GROUP BY i.id
      ORDER BY i.start_date ASC, i.id ASC
      LIMIT $5`,
    [accountId, from, jours, ids, Math.min(Math.max(opts.limit ?? 10, 1), 50), [...HISTORICAL_FIELD_KEYS], ...terms.map((t) => `%${t}%`)] as never[],
  )) as unknown as Array<UpcomingAgendaRow & { originFieldKey: string | null; eventNature: string | null; isAutomatic: boolean | null; projectionOrigin: string | null }>;
  return rows.map(({ id, title, date, forecast, assetNames, businessType, originFieldKey, eventNature, isAutomatic, projectionOrigin }) => {
    const sem = resolveEventSemantics({ originFieldKey, businessType: businessType ?? null, nature: (eventNature as never) ?? null });
    return {
      id: Number(id), title, date, forecast: !!forecast, assetNames,
      businessType: businessType ?? sem.businessType,
      nature: eventNature ?? sem.nature ?? null, originFieldKey: originFieldKey ?? null,
      provenance: agendaDateProvenance({ originFieldKey, projectionOrigin, isAutomatic }),
    };
  });
}

/** Nombre d'échéances à venir (mêmes règles que `listUpcomingAgenda`, sans fenêtre). */
export async function countUpcomingAgenda(accountId: number, opts: { assetIds?: number[]; from?: string } = {}): Promise<number> {
  const col = await agendaFunctionalColumnsReady().catch(() => false);
  const ids = opts.assetIds?.length ? opts.assetIds : null;
  const [r] = (await pgClient.unsafe(
    `SELECT count(*)::int AS n FROM agenda_items i
      WHERE i.account_id = $1 AND i.start_date >= $2::date
        AND ($3::int[] IS NULL OR EXISTS (SELECT 1 FROM agenda_asset_links x WHERE x.agenda_item_id = i.id AND x.asset_id = ANY($3::int[])))
        AND ${NOT_HISTORICAL(col, '$4')}`,
    [accountId, opts.from ?? today(), ids, [...HISTORICAL_FIELD_KEYS]] as never[],
  )) as unknown as Array<{ n: number }>;
  return Number(r?.n ?? 0);
}

/** Source d'un élément d'agenda (nature comprise ; lot 113P : aucun statut d'événement). */
export function canonicalAgendaSource(i: CanonicalAgendaItem): RetrievedSource {
  return {
    id: `agenda_${i.id}`, type: 'agenda_item', title: i.title,
    content: [i.date, i.nature === 'HISTORICAL' ? 'fait passé' : null, i.forecast ? 'date prévisionnelle' : null,
      i.assets.map((a) => a.name).join(', ') || null].filter(Boolean).join(' · '),
    relevanceScore: 1,
    meta: { date: i.date, nature: i.nature, forecast: i.forecast, businessType: i.businessType },
  };
}
