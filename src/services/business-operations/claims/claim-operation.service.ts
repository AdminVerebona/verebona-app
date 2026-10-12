/**
 * ClaimOperationService — lecture / écriture des Sinistres d'un bien (lot 44,
 * O5 ; CDC Opérations V1 ch. 15, B14, C14, C19, C25 ; décisions PO Q2, Q3,
 * Q4, Q11).
 *
 * Point d'entrée des routes `/api/assets/[id]/claims*` : le Sinistre est une
 * Opération CLAIM (source de vérité) ; la fiche n'en voit que la forme
 * fonctionnelle (le mot « Opération » n'apparaît jamais, P09).
 *
 *   · `list`   : sinistres actifs du bien (plusieurs par bien, Q2), et
 *                l'ancienne saisie encore non reprise (lecture legacy, Q11) ;
 *                la migration C14.3 du bien est faite au passage si elle
 *                n'a pas encore eu lieu (idempotente) ;
 *   · `get`    : un sinistre, forme du formulaire + version (verrou optimiste) ;
 *   · `create` / `update` / `remove` : écritures sous le verrou Opération du
 *                compte (`withBusinessOperationWrite`), événements après
 *                commit, puis demande de passage T3 (documents en attente) ;
 *   · `resumeLegacy` : reprise explicite de l'ancienne saisie (« Reprendre »).
 *
 * Droits (Q3) : saisie ouverte à toutes les offres — les contrôles d'écriture
 * de la fiche (bien archivé / verrouillé, compte restreint) sont faits par la
 * route ; l'EXPORT du dossier reste Premium (moteur de dossiers).
 */
import { sql } from 'drizzle-orm';
import { db } from '@/db';
import { sanitizeSection, type AdditionalInfoSectionData, type NormalizedPatch } from '@/lib/assets/additional-infos';
import { withBusinessOperationWrite } from '../write';
import { emptyCardNeeds } from '../consolidation/card-needs';
import {
  ClaimFormError, createClaimInSession, patchClaimSection, removeClaimInSession, updateClaimInSession, type ClaimMutationResult,
} from '../consolidation/claim-form';
import { CLAIM_MIGRATION_VERSION, claimToSection, claimLabel, toClaimSummary, type ClaimCosts, type ClaimRecord, type ClaimSummaryDto } from './model';
import { loadAssetNames, loadClaimRecords } from './read';

export { ClaimFormError };

export interface ClaimDto {
  id: number;
  /** Sous-rubrique « Sinistre » (clés du formulaire historique). */
  claim: AdditionalInfoSectionData;
  version: number;
  label: string;
  assets: Array<{ id: number; name: string; primary: boolean }>;
  costs: ClaimCosts;
  /** Contrat d'assurance reconnu (libellé), si la police correspond à un contrat certain. */
  contractLabel: string | null;
  documented: boolean;
  closed: boolean;
  updatedAt: string;
}

export interface LegacyClaimDto {
  claim: AdditionalInfoSectionData;
  label: string;
  /** Pourquoi elle n'est pas devenue un sinistre : trop peu d'informations, ou plusieurs sinistres possibles. */
  reason: 'BELOW_THRESHOLD' | 'HOLD_AMBIGUOUS' | 'PENDING';
}

export interface ClaimListDto {
  claims: ClaimSummaryDto[];
  legacy: LegacyClaimDto | null;
  /** Biens du compte proposés comme « biens concernés » (Q2) : non supprimés, non archivés. */
  assetOptions: Array<{ id: number; name: string }>;
}

async function toDto(r: ClaimRecord): Promise<ClaimDto> {
  const names = await loadAssetNames(db, r.accountId, r.assets.map((a) => a.assetId));
  const claim = claimToSection(r);
  return {
    id: r.id,
    claim,
    version: r.version,
    label: claimLabel(claim),
    assets: r.assets.map((a) => ({ id: a.assetId, name: names.get(a.assetId) ?? `Bien ${a.assetId}`, primary: a.role === 'PRIMARY' })),
    costs: r.costs,
    contractLabel: r.contractLabel,
    documented: r.origin.documents > 0,
    closed: !!r.closedAt,
    updatedAt: r.updatedAt,
  };
}

/** Ancienne saisie du bien encore non reprise (ou pas encore examinée). */
async function loadLegacy(accountId: number, assetId: number): Promise<{ claim: AdditionalInfoSectionData; outcome: string | null; stale: boolean } | null> {
  const [r] = (await db.execute(sql`
    SELECT ai.claim_json AS claim, m.outcome, (m.asset_id IS NULL OR m.data_fingerprint <> md5(ai.claim_json::text) OR m.account_id <> ai.account_id
                                               OR m.migration_version <> ${CLAIM_MIGRATION_VERSION}) AS stale
      FROM asset_additional_infos ai LEFT JOIN business_operation_claim_migration_marks m ON m.asset_id = ai.asset_id
     WHERE ai.asset_id = ${assetId} AND ai.account_id = ${accountId}`)) as unknown as Array<{ claim: unknown; outcome: string | null; stale: boolean }>;
  if (!r) return null;
  const claim = sanitizeSection('claim', typeof r.claim === 'string' ? JSON.parse(r.claim) : r.claim);
  if (!Object.keys(claim).length) return null;
  return { claim, outcome: r.outcome, stale: !!r.stale };
}

/** Demande de passage T3 (documents en attente rapprochés du sinistre saisi) + caches de l'assistant. Jamais bloquant. */
async function afterWrite(accountId: number, assetIds: readonly number[]): Promise<void> {
  try {
    const { notifyOperationsEvent } = await import('../consolidation/queue');
    for (const assetId of assetIds) notifyOperationsEvent(accountId, { trigger: 'asset_updated', assetId });
    const { emitBusinessEvent } = await import('@/services/verebona-assistant/events/business-events');
    for (const assetId of assetIds) await emitBusinessEvent({ type: 'ASSET_UPDATED', accountId, entityId: assetId });
  } catch (e) {
    console.error(`[claims] suites d'écriture du compte ${accountId} :`, (e as Error).message);
  }
}

async function syncCardsAfter(accountId: number, cards: ReturnType<typeof emptyCardNeeds>): Promise<void> {
  if (!cards.reviewedOperations.length && !cards.reviewedFiles.length) return;
  const { syncCards } = await import('../consolidation/consolidator');
  await syncCards(accountId, cards);
}

export const ClaimOperationService = {
  /** Sinistres du bien (survenue décroissante) et ancienne saisie non reprise. */
  async list(accountId: number, assetId: number): Promise<ClaimListDto> {
    let legacy = await loadLegacy(accountId, assetId);
    if (legacy?.stale) {
      // Migration C14.3 au passage (idempotente, même service que la tâche interne).
      try {
        const { migrateAssetClaim } = await import('../consolidation/claim-migration');
        await migrateAssetClaim(accountId, assetId);
      } catch (e) {
        console.error(`[claims] migration du bien ${assetId} :`, (e as Error).message);
      }
      legacy = await loadLegacy(accountId, assetId);
    }
    const records = await loadClaimRecords(db, accountId, { assetId });
    const names = await loadAssetNames(db, accountId, records.flatMap((r) => r.assets.map((a) => a.assetId)));
    const nonReprise = legacy && (legacy.stale || legacy.outcome === 'BELOW_THRESHOLD' || legacy.outcome === 'HOLD_AMBIGUOUS' || legacy.outcome === 'ERROR');
    const options = (await db.execute(sql`
      SELECT id, name FROM assets WHERE account_id = ${accountId} AND deleted_at IS NULL AND status <> 'ARCHIVED'
       ORDER BY (id = ${assetId}) DESC, name, id LIMIT 200`)) as unknown as Array<{ id: number; name: string }>;
    return {
      assetOptions: options.map((a) => ({ id: Number(a.id), name: String(a.name) })),
      claims: records.map((r) => toClaimSummary(r, assetId, names)),
      legacy: legacy && nonReprise
        ? { claim: legacy.claim, label: claimLabel(legacy.claim), reason: legacy.outcome === 'HOLD_AMBIGUOUS' ? 'HOLD_AMBIGUOUS' : legacy.outcome === 'BELOW_THRESHOLD' ? 'BELOW_THRESHOLD' : 'PENDING' }
        : null,
    };
  },

  async get(accountId: number, assetId: number, claimId: number): Promise<ClaimDto | null> {
    const [r] = await loadClaimRecords(db, accountId, { ids: [claimId] });
    if (!r || !r.assets.some((a) => a.assetId === assetId)) return null;
    return toDto(r);
  },

  /** Nouveau sinistre sur le bien (et, si demandé, d'autres biens du compte). */
  async create(accountId: number, userId: number, assetId: number, p: { patch: NormalizedPatch | null; assetIds?: readonly number[] }): Promise<ClaimDto> {
    let cards = emptyCardNeeds();
    const r: ClaimMutationResult = await withBusinessOperationWrite(accountId, (_repo, session) => {
      cards = emptyCardNeeds();
      const section = p.patch ? patchClaimSection({}, p.patch) : {};
      return createClaimInSession(session, accountId, { primaryAssetId: assetId, assetIds: p.assetIds ?? [assetId], section, cards });
    }, { actorUserId: userId });
    await syncCardsAfter(accountId, cards);
    await afterWrite(accountId, r.assets.length ? r.assets : [assetId]);
    return (await this.get(accountId, assetId, r.claimId))!;
  },

  /** Correctif (champ par champ, listes en bloc) ; CONFLICT si `expectedVersion` est dépassée. */
  async update(accountId: number, userId: number, assetId: number, claimId: number, p: {
    patch: NormalizedPatch | null; expectedVersion: number | null; assetIds?: readonly number[] | null;
  }): Promise<ClaimDto | null> {
    let cards = emptyCardNeeds();
    const r = await withBusinessOperationWrite(accountId, (_repo, session) => {
      cards = emptyCardNeeds();
      return updateClaimInSession(session, accountId, { assetId, claimId, patch: p.patch, expectedVersion: p.expectedVersion, assetIds: p.assetIds, cards });
    }, { actorUserId: userId });
    await syncCardsAfter(accountId, cards);
    await afterWrite(accountId, r.assets.length ? r.assets : [assetId]);
    const dto = await this.get(accountId, assetId, claimId);
    if (dto) return dto;
    // Bien retiré du sinistre par cette modification : lu depuis un bien encore concerné.
    const [rec] = await loadClaimRecords(db, accountId, { ids: [claimId] });
    return rec ? toDto(rec) : null;
  },

  /** Suppression (« annulation » logique) ; `remains` : le sinistre reste établi par des documents. */
  async remove(accountId: number, userId: number, assetId: number, claimId: number): Promise<{ removed: true; remains: boolean }> {
    let cards = emptyCardNeeds();
    const r = await withBusinessOperationWrite(accountId, (_repo, session) => {
      cards = emptyCardNeeds();
      return removeClaimInSession(session, accountId, { assetId, claimId, cards });
    }, { actorUserId: userId });
    await syncCardsAfter(accountId, cards);
    await afterWrite(accountId, r.assets.length ? r.assets : [assetId]);
    return { removed: true, remains: !!r.remains };
  },

  /** Reprise explicite de l'ancienne saisie du bien (« Reprendre ») : sans seuil. */
  async resumeLegacy(accountId: number, assetId: number): Promise<ClaimDto | null> {
    const { migrateAssetClaim } = await import('../consolidation/claim-migration');
    const r = await migrateAssetClaim(accountId, assetId, { force: true });
    await afterWrite(accountId, [assetId]);
    return r.operationId ? this.get(accountId, assetId, r.operationId) : null;
  },
};
