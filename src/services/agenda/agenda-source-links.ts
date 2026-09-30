/**
 * Liaison source ↔ agenda — service UNIQUE (CDC 15 T4-07, X-04, §11 ; lot 14).
 *
 * « Service unique de liaison source <-> agenda, utilisé par T4 et l'agenda
 * manuel. » « Depuis chaque document source, tous les événements automatiques
 * sont accessibles. »
 *
 * ÉCRITURE — `recordAgendaItemSources`, appelée par la primitive
 * (`upsertAgendaItem`) à chaque création ou mise à jour, sous
 * AI_T4_EFFECTS=enabled, pour l'automatique comme pour le manuel :
 *   · `agenda_file_links`   lien affiché (élément ↔ document), idempotent ;
 *   · `agenda_item_sources` trace du lien : `effect_type = 'linked'`, rôle
 *     SOURCE (document qui a produit l'élément automatique), ATTACHMENT
 *     (pièce jointe d'un élément manuel) ou PROOF (preuve de réalisation),
 *     preuve `evidence_id` si connue, dernier run d'analyse du document s'il
 *     y en a un. Jamais 'created' : cette valeur reste celle du moteur
 *     d'analyse historique, que les indicateurs comptent « créée par l'IA ».
 *     Colonnes 0223 absentes : seuls les `agenda_file_links` sont écrits.
 *
 * LECTURE — `listAgendaItemsForDocument` / `listAgendaItemIdsForSource` :
 * liens `agenda_file_links`, traces `agenda_item_sources` (historiques
 * 'created' / 'resolved_existing' et 'linked') et, en enabled, éléments
 * automatiques dont la source d'origine est le document (`origin_ref`),
 * pour ceux créés avant ce lot.
 */
import { db } from '@/db';
import { agendaFileLinks, agendaItems, agendaItemSources } from '@/db/schema';
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { t4EffectsMode, type RolloutMode } from '@/services/canonical/rollout';
import { agendaSourcesColumnsReady } from './agenda-columns';

export type AgendaSourceRole = 'SOURCE' | 'ATTACHMENT' | 'PROOF';

/** Document relié à un élément d'agenda. */
export interface AgendaSourceRef {
  fileId: number;
  role: AgendaSourceRole;
  /** Preuve `field_evidence` à l'origine du lien, si connue. */
  evidenceId?: number | null;
}

/** Effets de trace lus comme « élément lié à ce document ». */
export const SOURCE_LINK_EFFECTS = ['created', 'resolved_existing', 'linked'] as const;

const valide = (s: AgendaSourceRef) => Number.isInteger(s.fileId) && s.fileId > 0;

/**
 * Inscrit les documents d'un élément (voir l'en-tête). `client` : la
 * transaction de l'écriture de l'élément. Idempotent.
 */
export async function recordAgendaItemSources(
  client: any,
  agendaItemId: number,
  sources: AgendaSourceRef[],
): Promise<void> {
  const liste = sources.filter(valide);
  if (liste.length === 0) return;
  const fichiers = [...new Set(liste.map((s) => s.fileId))];
  await client.insert(agendaFileLinks)
    .values(fichiers.map((assetFileId) => ({ agendaItemId, assetFileId })))
    .onConflictDoNothing();
  if (!(await agendaSourcesColumnsReady())) return;
  for (const s of liste) {
    await client.execute(sql`
      INSERT INTO agenda_item_sources (agenda_item_id, asset_file_id, run_id, effect_type, source_role, evidence_id)
      SELECT ${agendaItemId}, ${s.fileId},
             (SELECT r.id FROM document_analysis_runs r WHERE r.asset_file_id = ${s.fileId} ORDER BY r.id DESC LIMIT 1),
             'linked', ${s.role}, ${s.evidenceId ?? null}
       WHERE NOT EXISTS (SELECT 1 FROM agenda_item_sources x
                          WHERE x.agenda_item_id = ${agendaItemId} AND x.asset_file_id = ${s.fileId}
                            AND x.source_role = ${s.role})
      ON CONFLICT DO NOTHING`);
  }
}

/** Compatibilité : documents SOURCES d'un élément automatique. */
export async function linkAgendaItemToSources(client: any, agendaItemId: number, fileIds: number[]): Promise<void> {
  await recordAgendaItemSources(client, agendaItemId, fileIds.map((fileId) => ({ fileId, role: 'SOURCE' as const })));
}

/** Identifiants des éléments d'agenda liés à un document (voir l'en-tête). */
export async function listAgendaItemIdsForSource(
  accountId: number,
  fileId: number,
  mode: RolloutMode = t4EffectsMode(),
): Promise<number[]> {
  const [fileLinks, traces, origines] = await Promise.all([
    db.selectDistinct({ id: agendaFileLinks.agendaItemId })
      .from(agendaFileLinks)
      .where(eq(agendaFileLinks.assetFileId, fileId)),
    db.selectDistinct({ id: agendaItemSources.agendaItemId })
      .from(agendaItemSources)
      .where(and(
        isNotNull(agendaItemSources.agendaItemId),
        eq(agendaItemSources.assetFileId, fileId),
        inArray(agendaItemSources.effectType, [...SOURCE_LINK_EFFECTS]),
      )),
    mode === 'enabled'
      ? db.select({ id: agendaItems.id }).from(agendaItems).where(and(
        eq(agendaItems.accountId, accountId),
        eq(agendaItems.originRefType, 'asset_file'),
        eq(agendaItems.originRefId, fileId),
      ))
      : Promise.resolve([] as Array<{ id: number }>),
  ]);
  const ids = new Set<number>();
  fileLinks.forEach((r) => ids.add(r.id));
  traces.forEach((r) => { if (r.id !== null) ids.add(r.id); });
  origines.forEach((r) => ids.add(r.id));
  return [...ids];
}

/** Élément d'agenda lié à un document (lecture « depuis le document »). */
export interface DocumentAgendaItem {
  id: number;
  title: string;
  startDate: string | null;
  isAutomatic: boolean;
  isAutomaticModified: boolean;
  manualStatus: string | null;
  homeCategory: string | null;
  originFieldKey: string | null;
}

/**
 * Éléments d'agenda liés à un document, du compte, par date (T4-07, X-04).
 * `automaticOnly` : seulement les éléments automatiques.
 */
export async function listAgendaItemsForDocument(
  fileId: number,
  opts: { accountId: number; automaticOnly?: boolean; mode?: RolloutMode },
): Promise<DocumentAgendaItem[]> {
  const ids = await listAgendaItemIdsForSource(opts.accountId, fileId, opts.mode);
  if (ids.length === 0) return [];
  return db.select({
    id: agendaItems.id,
    title: agendaItems.title,
    startDate: agendaItems.startDate,
    isAutomatic: agendaItems.isAutomatic,
    isAutomaticModified: agendaItems.isAutomaticModified,
    manualStatus: agendaItems.manualStatus,
    homeCategory: agendaItems.homeCategory,
    originFieldKey: agendaItems.originFieldKey,
  })
    .from(agendaItems)
    .where(and(
      eq(agendaItems.accountId, opts.accountId),
      inArray(agendaItems.id, ids),
      ...(opts.automaticOnly ? [eq(agendaItems.isAutomatic, true)] : []),
    ))
    .orderBy(asc(agendaItems.startDate), asc(agendaItems.id));
}
