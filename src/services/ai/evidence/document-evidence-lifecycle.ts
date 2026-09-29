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
 * Commutateur `T3_NEGATIVE_RECONCILIATION` (ces transitions changent des
 * décisions) :
 *   legacy   rien (comportement historique) ;
 *   shadow   journal structuré de ce qui SERAIT retiré (`t3.evidence_lifecycle`,
 *            dryRun), sans écriture ni mise en file ;
 *   enabled  transitions et réconciliation des biens touchés.
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
import { t3NegativeMode } from '@/services/canonical/rollout';
import type { RolloutMode } from '@/services/canonical/rollout';
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
  mode: () => RolloutMode;
  withdraw: typeof withdrawEvidence;
  enqueue: (input: { accountId: number; userId: number; assetIds: number[]; sourceFileId?: number | null; reason: string }) => Promise<unknown>;
  links?: LinkDeps;
  evidenceAssets?: (accountId: number, sourceId: number) => Promise<number[]>;
}

const defaultDeps: LifecycleDeps = {
  mode: () => t3NegativeMode(),
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
};

export interface LifecycleOutcome {
  mode: RolloutMode;
  withdrawn: number;
  assetIds: number[];
  dryRun: boolean;
}

const RIEN = (mode: RolloutMode): LifecycleOutcome => ({ mode, withdrawn: 0, assetIds: [], dryRun: true });

async function transition(
  p: {
    accountId: number; userId: number; sourceIds: number[]; assetId?: number | null;
    reason: EvidenceWithdrawalReason; alsoReconcile?: number[];
  },
  deps: LifecycleDeps,
): Promise<LifecycleOutcome> {
  const mode = deps.mode();
  if (mode === 'legacy') return RIEN(mode);
  try {
    const r: WithdrawEvidenceResult = await deps.withdraw({
      accountId: p.accountId, sourceIds: p.sourceIds, assetId: p.assetId ?? null, reason: p.reason, mode,
    });
    const assetIds = [...new Set([...r.assetIds, ...(p.alsoReconcile ?? [])])];
    if (mode === 'enabled' && assetIds.length) {
      await deps.enqueue({
        accountId: p.accountId, userId: p.userId, assetIds,
        sourceFileId: p.sourceIds.length === 1 ? p.sourceIds[0] : null, reason: p.reason,
      });
    }
    return { mode, withdrawn: r.evidenceIds.length, assetIds, dryRun: r.dryRun };
  } catch (e) {
    console.error(`[t3-lifecycle] ${p.reason} (sources ${p.sourceIds.join(',')}) :`, (e as Error).message);
    return RIEN(mode);
  }
}

/** Documents supprimés (unitaire, en masse) : retrait de TOUTES leurs preuves, sur tous les biens. */
export function onDocumentsDeleted(
  p: { accountId: number; userId: number; fileIds: number[] },
  deps: LifecycleDeps = defaultDeps,
): Promise<LifecycleOutcome> {
  if (p.fileIds.length === 0) return Promise.resolve(RIEN(deps.mode()));
  return transition({ accountId: p.accountId, userId: p.userId, sourceIds: p.fileIds, reason: 'DOCUMENT_DELETED' }, deps);
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
  if (!p.fromAssetId || p.fromAssetId === p.toAssetId) return { ...RIEN(deps.mode()), unlinked: 0 };
  const from = p.fromAssetId;

  // ── Relation N-N (0221, X-01) — HORS commutateur ─────────────────────────
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
          target: { assetId: l.assetId, roomId: l.roomId, equipmentId: l.equipmentId },
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

  // ── Biens SECONDAIRES qui ne sont plus liés (sous le commutateur) ──────────
  // Un bien qui porte encore des preuves de ce document mais n'a plus AUCUN
  // lien actif vers lui (ni vers ses pièces / équipements), et n'est pas la
  // nouvelle cible : ses preuves sont retirées. Seulement si la relation N-N
  // est renseignée pour ce document (au moins un lien actif) — sans elle, on
  // ne sait rien et on ne retire rien (documents non rattrapés).
  let secondaires: LifecycleOutcome = RIEN(principal.mode);
  if (principal.mode !== 'legacy' && linksAfter && linksAfter.length > 0 && deps.evidenceAssets) {
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
      : RIEN(deps.mode());
    const mode = deps.mode();
    if (mode === 'legacy') return docs;
    try {
      const own = await deps.withdraw({ accountId: p.accountId, assetId: p.assetId, reason: 'ASSET_DELETED', mode });
      return { ...docs, withdrawn: docs.withdrawn + own.evidenceIds.length };
    } catch (e) {
      console.error(`[t3-lifecycle] ASSET_DELETED (bien ${p.assetId}) :`, (e as Error).message);
      return docs;
    }
  })();
}
