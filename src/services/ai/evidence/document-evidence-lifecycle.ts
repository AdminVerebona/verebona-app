/**
 * Cycle de vie des preuves au fil du document — CDC 15 T3-03 (lot 13).
 *
 * « À la réanalyse supersede les preuves précédentes ; au déplacement retract
 *   sur A puis projeter sur B ; à la suppression retract puis recalcul. »
 *
 * Point d'entrée UNIQUE des routes et services qui suppriment, détachent ou
 * déplacent un document (fichier unitaire, en masse, bien supprimé) : les
 * preuves ACTIVE concernées passent WITHDRAWN (avec la date), puis la
 * réconciliation T3 des biens touchés est mise en file — c'est elle qui,
 * par la phase négative (T3-04), retire ou remplace les valeurs automatiques
 * qui ne sont plus prouvées.
 *
 * Lot 16b-3 : commutateur `T3_NEGATIVE_RECONCILIATION` supprimé — transitions
 * et réconciliation des biens touchés toujours appliquées (comportement de
 * l'ancien `enabled`).
 *
 * DÉPLACEMENT A → B : retrait sur A ici ; la reprojection sur B reste celle
 * des routes (`projectDocumentKnowledgeToAsset` depuis `document_facts` quand
 * des faits T1 existent, réanalyse en file sinon). Choix : les faits persistés
 * suffisent — aucune relecture du fichier ni quota consommé (§5.6), et ils
 * portent la cible par fait (lot 12) ; la réanalyse reste le repli.
 *
 * Ne lève jamais : un document supprimé ou déplacé ne doit pas échouer parce
 * que le cycle de vie des preuves n'a pas pu suivre (journalisé).
 */
import {
  withdrawEvidence, listActiveEvidenceAssets, type EvidenceWithdrawalReason, type WithdrawEvidenceResult,
} from './field-evidence.service';
import type { DocumentAssetLink, UnlinkInput } from '@/services/documents/document-asset-links';

/** Accès à la relation N-N document ↔ bien (0221). */
export interface LinkDeps {
  list: (accountId: number, fileId: number) => Promise<DocumentAssetLink[]>;
  unlink: (input: UnlinkInput) => Promise<number>;
}

export interface LifecycleDeps {
  withdraw: typeof withdrawEvidence;
  enqueue: (input: { accountId: number; userId: number; assetIds: number[]; sourceFileId?: number | null; reason: string }) => Promise<unknown>;
  links?: LinkDeps;
  evidenceAssets?: (accountId: number, sourceId: number) => Promise<number[]>;
  /**
   * T4 (corpus §15 E2E-11 / E2E-19) : retrait des éléments d'agenda
   * AUTOMATIQUES intacts de la source sur le bien (`assetId`, ou tous les
   * biens si null). Les éléments modifiés par l'utilisateur sont conservés.
   */
  agenda?: (p: { accountId: number; sourceFileId: number; assetId: number | null }) => Promise<unknown>;
  /**
   * Lot 18 (R3) : équipements et pièces dont des preuves viennent d'être
   * retirées — réconciliation ciblée de leur fiche (retrait des valeurs
   * automatiques qui ne sont plus prouvées).
   */
  entityTargets?: (accountId: number, evidenceIds: number[]) => Promise<Array<{ type: 'EQUIPMENT' | 'ROOM'; id: number }>>;
  enqueueEntities?: (input: {
    accountId: number; userId: number; targets: Array<{ type: 'EQUIPMENT' | 'ROOM'; id: number }>;
    sourceFileId?: number | null; reason: string;
  }) => Promise<unknown>;
}

const defaultDeps: LifecycleDeps = {
  withdraw: withdrawEvidence,
  enqueue: async (input) => {
    const { enqueueT3ForAssets } = await import('../reconciliation/t3-queue');
    return enqueueT3ForAssets(input);
  },
  links: {
    list: async (a, f) => (await import('@/services/documents/document-asset-links')).listDocumentAssets(a, f),
    unlink: async (i) => (await import('@/services/documents/document-asset-links')).unlinkDocument(i),
  },
  evidenceAssets: listActiveEvidenceAssets,
  agenda: (p) => retirerAgendaDeLaSource(p),
  entityTargets: async (a, ids) => (await import('./entity-evidence')).listEvidenceEntityTargets(a, ids),
  enqueueEntities: async (input) => {
    const { enqueueT3ForEntities } = await import('../reconciliation/t3-queue');
    return enqueueT3ForEntities({ ...input, triggeredBy: 'document_linked' });
  },
};

/**
 * Retrait T4 des éléments automatiques d'une source retirée (toujours actif
 * depuis le lot 16b-2, commutateur AI_T4_EFFECTS retiré).
 */
export async function retirerAgendaDeLaSource(p: { accountId: number; sourceFileId: number; assetId: number | null }): Promise<unknown> {
  const { removeAgendaItemsFromSource } = await import('@/services/agenda/agenda-write-primitive');
  // Événement dont un AUTRE document encore présent est aussi la source :
  // conservé ; seul le lien vers la source retirée disparaît.
  const partages = await detacherSourcePartagee(p);
  // Plus aucun autre élément de cette source n'est produit pour ce bien.
  return removeAgendaItemsFromSource({ ...p, keepKeys: [], keepIds: partages, analysisComplete: true });
}

/**
 * Éléments automatiques de la source `sourceFileId` (sur `assetId`, ou tous)
 * qui ont une AUTRE source encore présente (non supprimée). Le lien vers
 * `sourceFileId` leur est retiré. Rend leurs ids
 * (à conserver). Ne lève jamais : en cas d'échec, rien n'est conservé de plus.
 */
export async function detacherSourcePartagee(p: { accountId: number; sourceFileId: number; assetId: number | null }): Promise<number[]> {
  try {
    const { pgClient } = await import('@/db');
    const rows = (await pgClient.unsafe(
      `SELECT i.id FROM agenda_items i
        WHERE i.account_id = $1 AND i.is_automatic
          AND ((i.origin_ref_type = 'asset_file' AND i.origin_ref_id = $2)
               OR EXISTS (SELECT 1 FROM agenda_item_sources s WHERE s.agenda_item_id = i.id AND s.asset_file_id = $2
                           AND s.effect_type = 'linked' AND s.source_role = 'SOURCE'))
          AND ($3::int IS NULL OR EXISTS (SELECT 1 FROM agenda_asset_links l WHERE l.agenda_item_id = i.id AND l.asset_id = $3))
          AND EXISTS (SELECT 1 FROM agenda_item_sources s2 JOIN asset_files f ON f.id = s2.asset_file_id AND f.deleted_at IS NULL
                       WHERE s2.agenda_item_id = i.id AND s2.asset_file_id <> $2
                         AND s2.effect_type = 'linked' AND s2.source_role = 'SOURCE')`,
      [p.accountId, p.sourceFileId, p.assetId] as never[],
    )) as unknown as Array<{ id: number }>;
    const ids = rows.map((r) => Number(r.id));
    if (ids.length) {
      await pgClient.unsafe(`DELETE FROM agenda_item_sources WHERE agenda_item_id = ANY($1::int[]) AND asset_file_id = $2`, [ids, p.sourceFileId] as never[]);
      await pgClient.unsafe(`DELETE FROM agenda_file_links WHERE agenda_item_id = ANY($1::int[]) AND asset_file_id = $2`, [ids, p.sourceFileId] as never[]);
    }
    return ids;
  } catch (e) {
    console.error(`[t3-lifecycle] sources partagées de ${p.sourceFileId} :`, (e as Error).message);
    return [];
  }
}

/** Retrait T4 des éléments automatiques d'une source ; ne lève jamais. */
async function retirerAgenda(deps: LifecycleDeps, accountId: number, sourceFileIds: number[], assetId: number | null) {
  if (!deps.agenda) return;
  for (const sourceFileId of sourceFileIds) {
    try {
      await deps.agenda({ accountId, sourceFileId, assetId });
    } catch (e) {
      console.error(`[t3-lifecycle] agenda de la source ${sourceFileId} :`, (e as Error).message);
    }
  }
}

export interface LifecycleOutcome {
  withdrawn: number;
  assetIds: number[];
  dryRun: boolean;
}

const RIEN = (): LifecycleOutcome => ({ withdrawn: 0, assetIds: [], dryRun: true });

async function transition(
  p: {
    accountId: number; userId: number; sourceIds: number[]; assetId?: number | null;
    reason: EvidenceWithdrawalReason; alsoReconcile?: number[];
  },
  deps: LifecycleDeps,
): Promise<LifecycleOutcome> {
  try {
    const r: WithdrawEvidenceResult = await deps.withdraw({
      accountId: p.accountId, sourceIds: p.sourceIds, assetId: p.assetId ?? null, reason: p.reason,
    });
    const assetIds = [...new Set([...r.assetIds, ...(p.alsoReconcile ?? [])])];
    if (assetIds.length) {
      await deps.enqueue({
        accountId: p.accountId, userId: p.userId, assetIds,
        sourceFileId: p.sourceIds.length === 1 ? p.sourceIds[0] : null, reason: p.reason,
      });
    }
    // Équipements et pièces dont des preuves sont retirées (lot 18, R3).
    if (r.evidenceIds.length && deps.entityTargets && deps.enqueueEntities) {
      try {
        const targets = await deps.entityTargets(p.accountId, r.evidenceIds);
        if (targets.length) {
          await deps.enqueueEntities({
            accountId: p.accountId, userId: p.userId, targets: targets.map((t) => ({ type: t.type, id: t.id })),
            sourceFileId: p.sourceIds.length === 1 ? p.sourceIds[0] : null, reason: p.reason,
          });
        }
      } catch (e) {
        console.error(`[t3-lifecycle] cibles équipement / pièce (sources ${p.sourceIds.join(',')}) :`, (e as Error).message);
      }
    }
    return { withdrawn: r.evidenceIds.length, assetIds, dryRun: r.dryRun };
  } catch (e) {
    console.error(`[t3-lifecycle] ${p.reason} (sources ${p.sourceIds.join(',')}) :`, (e as Error).message);
    return RIEN();
  }
}

/** Documents supprimés (unitaire, en masse) : retrait de TOUTES leurs preuves, sur tous les biens. */
export function onDocumentsDeleted(
  p: { accountId: number; userId: number; fileIds: number[] },
  deps: LifecycleDeps = defaultDeps,
): Promise<LifecycleOutcome> {
  if (p.fileIds.length === 0) return Promise.resolve(RIEN());
  return (async () => {
    const r = await transition({ accountId: p.accountId, userId: p.userId, sourceIds: p.fileIds, reason: 'DOCUMENT_DELETED' }, deps);
    await retirerAgenda(deps, p.accountId, p.fileIds, null);
    return r;
  })();
}

/**
 * Bien du document changé : détachement (`toAssetId` null) ou déplacement
 * A → B. Retrait des preuves portées par A ; B est réconcilié par la
 * reprojection de la route (voir l'en-tête).
 */
export async function onDocumentAssetChanged(
  p: { accountId: number; userId: number; fileId: number; fromAssetId: number | null; toAssetId: number | null },
  deps: LifecycleDeps = defaultDeps,
): Promise<LifecycleOutcome & { unlinked: number }> {
  if (!p.fromAssetId || p.fromAssetId === p.toAssetId) return { ...RIEN(), unlinked: 0 };
  const from = p.fromAssetId;

  // ── Relation N-N (0221, X-01) ─────────────────────────────────────────────
  // Les liens LEGACY_COLUMN suivent `asset_files` (déclencheur). Les liens
  // USER, AI et MIGRATION qui visent A (le bien, ses pièces, ses équipements)
  // sont retirés (REMOVED) : le document n'appartient plus à A. Aucun écran
  // ni décision ne lit encore cette table ; ne lève jamais.
  let unlinked = 0;
  let linksAfter: DocumentAssetLink[] | null = null;
  if (deps.links) {
    try {
      const avant = await deps.links.list(p.accountId, p.fileId);
      for (const l of avant.filter((x) => x.assetId === from && x.origin !== 'LEGACY_COLUMN')) {
        unlinked += await deps.links.unlink({
          accountId: p.accountId, fileId: p.fileId,
          // D-G (lot 20) : une pièce est une sous-structure — sans `substructureId`,
          // le lien d'une pièce n'était plus retiré au déplacement du document.
          target: { assetId: l.assetId, roomId: l.roomId, equipmentId: l.equipmentId, substructureId: l.substructureId },
          origins: [l.origin as Exclude<typeof l.origin, 'LEGACY_COLUMN'>],
        });
      }
      linksAfter = await deps.links.list(p.accountId, p.fileId);
    } catch (e) {
      console.error(`[t3-lifecycle] liens N-N du document ${p.fileId} :`, (e as Error).message);
    }
  }

  const principal = await transition({
    accountId: p.accountId, userId: p.userId, sourceIds: [p.fileId], assetId: from,
    reason: p.toAssetId ? 'DOCUMENT_MOVED' : 'DOCUMENT_UNLINKED',
    // A est réconcilié même sans preuve retirée (valeur prouvée par ce seul document).
    alsoReconcile: [from],
  }, deps);
  // Agenda : les événements automatiques de ce document portés par A partent
  // avec lui (B les reçoit par la reprojection / réanalyse de la route).
  await retirerAgenda(deps, p.accountId, [p.fileId], from);

  // ── Biens SECONDAIRES qui ne sont plus liés ───────────────────────────────
  // Un bien qui porte encore des preuves de ce document mais n'a plus AUCUN
  // lien actif vers lui (ni vers ses pièces / équipements), et n'est pas la
  // nouvelle cible : ses preuves sont retirées. Seulement si la relation N-N
  // est renseignée pour ce document (au moins un lien actif) — sans elle, on
  // ne sait rien et on ne retire rien (documents non rattrapés).
  let secondaires: LifecycleOutcome = RIEN();
  if (linksAfter && linksAfter.length > 0 && deps.evidenceAssets) {
    try {
      const lies = new Set(linksAfter.map((l) => l.assetId).filter((a): a is number => a != null));
      if (p.toAssetId) lies.add(p.toAssetId);
      const orphelins = (await deps.evidenceAssets(p.accountId, p.fileId)).filter((a) => a !== from && !lies.has(a));
      for (const assetId of orphelins) {
        const r = await transition({
          accountId: p.accountId, userId: p.userId, sourceIds: [p.fileId], assetId,
          reason: 'DOCUMENT_UNLINKED', alsoReconcile: [assetId],
        }, deps);
        secondaires = { ...r, withdrawn: secondaires.withdrawn + r.withdrawn, assetIds: [...secondaires.assetIds, ...r.assetIds] };
      }
    } catch (e) {
      console.error(`[t3-lifecycle] biens secondaires du document ${p.fileId} :`, (e as Error).message);
    }
  }

  return {
    ...principal,
    withdrawn: principal.withdrawn + secondaires.withdrawn,
    assetIds: [...new Set([...principal.assetIds, ...secondaires.assetIds])],
    unlinked,
  };
}

/**
 * Bien supprimé : ses documents disparaissent avec lui. Leurs preuves portées
 * par D'AUTRES biens (document multi-biens, faits ciblés) sont retirées, et
 * ces biens réconciliés ; celles du bien supprimé aussi (plus rien ne les lit).
 */
export function onAssetDeleted(
  p: { accountId: number; userId: number; assetId: number; fileIds: number[] },
  deps: LifecycleDeps = defaultDeps,
): Promise<LifecycleOutcome> {
  return (async () => {
    const docs = p.fileIds.length
      ? await transition({ accountId: p.accountId, userId: p.userId, sourceIds: p.fileIds, reason: 'ASSET_DELETED' }, {
        ...deps,
        // Le bien supprimé n'est plus à réconcilier.
        enqueue: (i) => deps.enqueue({ ...i, assetIds: i.assetIds.filter((a) => a !== p.assetId) }),
      })
      : RIEN();
    try {
      const own = await deps.withdraw({ accountId: p.accountId, assetId: p.assetId, reason: 'ASSET_DELETED' });
      return { ...docs, withdrawn: docs.withdrawn + own.evidenceIds.length };
    } catch (e) {
      console.error(`[t3-lifecycle] ASSET_DELETED (bien ${p.assetId}) :`, (e as Error).message);
      return docs;
    }
  })();
}
