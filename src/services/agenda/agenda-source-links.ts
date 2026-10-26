/**
 * Liaison source ↔ agenda — service UNIQUE (CDC 15 T4-07, X-04, §11 ; lot 14).
 *
 * « Service unique de liaison source <-> agenda, utilisé par T4 et l'agenda
 * manuel. » « Depuis chaque document source, tous les événements automatiques
 * sont accessibles. »
 *
 * ÉCRITURE — `recordAgendaItemSources`, appelée par la primitive
 * (`upsertAgendaItem`) à chaque création ou mise à jour, pour l'automatique
 * comme pour le manuel :
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
 * liens `agenda_file_links` (lot 86D : seul modèle des associations ; les
 * traces `agenda_item_sources` et `origin_ref` restent l'historique).
 */
import { db } from '@/db';
import { agendaFileLinks, agendaItems } from '@/db/schema';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { agendaSourcesColumnsReady } from './agenda-columns';

export type AgendaSourceRole = 'SOURCE' | 'ATTACHMENT' | 'PROOF';

/** Document relié à un élément d'agenda. */
export interface AgendaSourceRef {
  fileId: number;
  role: AgendaSourceRole;
  /** Preuve `field_evidence` à l'origine du lien, si connue. */
  evidenceId?: number | null;
}

const valide = (s: AgendaSourceRef) => Number.isInteger(s.fileId) && s.fileId > 0;

/**
 * Inscrit les documents d'un élément (voir l'en-tête). `client` : la
 * transaction de l'écriture de l'élément. Idempotent.
 *
 * Lot 49 (SEC-07) : chaque document doit exister et appartenir au compte de
 * l'élément — sinon refus entier (`AgendaOwnershipError`), rien n'est écrit.
 */
export async function recordAgendaItemSources(
  client: any,
  agendaItemId: number,
  sources: AgendaSourceRef[],
  /** Lot 82D (CDC v5 §7.4) : provenance du lien Document ↔ Agenda (T4 : AI_DIRECT ; agenda manuel : MANUAL_DIRECT). */
  provenance: 'AI_DIRECT' | 'MANUAL_DIRECT' = 'AI_DIRECT',
): Promise<void> {
  const liste = sources.filter(valide);
  if (liste.length === 0) return;
  const fichiers = [...new Set(liste.map((s) => s.fileId))];
  const hors = (await client.execute(sql`
    SELECT x.id FROM unnest(${`{${fichiers.join(',')}}`}::int[]) AS x(id)
      LEFT JOIN agenda_items i ON i.id = ${agendaItemId}
      LEFT JOIN asset_files f ON f.id = x.id
     WHERE i.id IS NULL OR f.id IS NULL OR f.account_id IS DISTINCT FROM i.account_id`)) as unknown as unknown[];
  if (hors.length > 0) {
    const { AgendaOwnershipError } = await import('./write-agenda-item');
    throw new AgendaOwnershipError();
  }
  const { addFileLinkProvenance } = await import('@/services/business-operations/grouping/provenance');
  const { drizzleRunner } = await import('@/services/business-operations/grouping/runner');
  // Agenda manuel : seuls les liens absents sont créés (un lien propagé ou T4 garde ses justifications).
  await addFileLinkProvenance(drizzleRunner(client), agendaItemId, fichiers, provenance, { onlyNew: provenance === 'MANUAL_DIRECT' });
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

/**
 * Identifiants des éléments d'agenda liés à un document, du compte.
 *
 * Lot 86D (ticket « Documents / Agenda ») : seuls les liens
 * `agenda_file_links` valent association — modèle unique depuis 82D (un lien
 * n'existe que tant qu'une provenance le justifie). Les traces
 * `agenda_item_sources` et l'origine `origin_ref` d'un élément automatique
 * restent l'HISTORIQUE de production du lien : les lire ici rendait visible,
 * sans moyen de le retirer, un lien détaché par l'utilisateur ou retiré par le
 * contrôle de cohérence (cause racine des associations « qui restent »).
 */
export async function listAgendaItemIdsForSource(
  accountId: number,
  fileId: number,
): Promise<number[]> {
  const rows = await db.selectDistinct({ id: agendaFileLinks.agendaItemId })
    .from(agendaFileLinks)
    .innerJoin(agendaItems, and(eq(agendaItems.id, agendaFileLinks.agendaItemId), eq(agendaItems.accountId, accountId)))
    .where(eq(agendaFileLinks.assetFileId, fileId));
  return rows.map((r) => r.id);
}

/** Élément d'agenda lié à un document (lecture « depuis le document »). */
interface DocumentAgendaItem {
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
  opts: { accountId: number; automaticOnly?: boolean },
): Promise<DocumentAgendaItem[]> {
  const ids = await listAgendaItemIdsForSource(opts.accountId, fileId);
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
