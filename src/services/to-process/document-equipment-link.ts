/**
 * Rattachement ambigu document → équipement — règle « À traiter » LINK-ELT
 * (CDC V2 §10.4, CDC 15 T3-07, lot 13).
 *
 * T3 (moteur de liens, agent A) ne rattache JAMAIS automatiquement quand deux
 * équipements sont proches : il propose, l'utilisateur tranche depuis la
 * carte. Ce module fournit les deux bouts :
 *
 *   · `proposeDocumentEquipmentLink` — crée ou met à jour la carte (arbitrage,
 *     une proposition par équipement candidat), avec une EMPREINTE stable
 *     (document + ensemble trié des candidats) : rejouer la même proposition
 *     ne crée rien de plus, et une carte déclarée « Non applicable » ne
 *     revient pas sans nouveau candidat (§7.4) ;
 *   · `DOCUMENT_ELEMENT_WRITER` — écrivain de RELATION de la liste blanche
 *     (`resolveArbitration` / `undoArbitration`) : vérifie que l'équipement
 *     appartient au compte ET au bien du document, écrit
 *     `asset_files.equipment_id`, relit la valeur précédente pour
 *     l'annulation ; la trace est celle de `resolveArbitration`
 *     (`to_process_action_events`). Lien N-N `document_asset_links` : le
 *     déclencheur 0221 pose déjà un lien LEGACY_COLUMN depuis `equipment_id`
 *     dans la transaction ; le lien USER du service de C est demandé APRÈS
 *     la transaction et n'est créé que si aucun lien actif ne vise déjà
 *     l'équipement (un seul lien actif par cible, `canRefresh` ne remplace
 *     jamais un LEGACY_COLUMN). Non bloquant, rattrapable.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { assetFiles, assets, equipments } from '@/db/schema';
import type { DbClient } from './resolve-action.service';
import type { ActionProposal } from './action-model';
import { upsertAction, type UpsertActionResult } from './to-process-action.service';

export const LINK_ELT_RULE = 'LINK-ELT';
export const LINK_ELT_RELATION = 'elementId';

/** Écrivain d'une RELATION depuis une carte (liste blanche, comme `FieldWriter`). */
export interface RelationWriter {
  targetType: 'DOCUMENT';
  relationKey: string;
  /** Forme de la valeur (avant tout accès base). */
  validate: (value: unknown) => boolean;
  /** Contrôle d'appartenance EN BASE, dans la transaction ; faux → INVALID_VALUE. */
  check: (client: DbClient, targetId: number, accountId: number, value: unknown) => Promise<boolean>;
  write: (client: DbClient, targetId: number, accountId: number, value: unknown) => Promise<void>;
  read: (client: DbClient, targetId: number, accountId: number) => Promise<unknown>;
  /** Effet hors transaction, après validation (lien N-N) ; ne lève jamais. */
  afterCommit?: (p: { accountId: number; targetId: number; value: unknown; previousValue: unknown; undo: boolean }) => Promise<void>;
}

const asId = (v: unknown): number | null => {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
};

/** Bien porteur d'un document du compte (`asset_id`, sinon `linked_asset_id`), ou undefined s'il n'existe pas. */
async function documentAsset(client: DbClient, fileId: number, accountId: number): Promise<number | null | undefined> {
  const [f] = await client
    .select({ assetId: assetFiles.assetId, linkedAssetId: assetFiles.linkedAssetId })
    .from(assetFiles)
    .where(and(eq(assetFiles.id, fileId), eq(assetFiles.accountId, accountId), isNull(assetFiles.deletedAt)))
    .limit(1);
  if (!f) return undefined;
  return f.assetId ?? f.linkedAssetId ?? null;
}

/** Équipements du compte portés par `assetId` (bien non supprimé), parmi `ids`. */
async function equipmentsOfAsset(client: DbClient, accountId: number, assetId: number, ids: number[]) {
  if (ids.length === 0) return [];
  return client
    .select({ id: equipments.id, name: equipments.name })
    .from(equipments)
    .innerJoin(assets, eq(equipments.assetId, assets.id))
    .where(and(
      inArray(equipments.id, ids), eq(equipments.assetId, assetId),
      eq(assets.accountId, accountId), isNull(assets.deletedAt),
    ));
}

export const DOCUMENT_ELEMENT_WRITER: RelationWriter = {
  targetType: 'DOCUMENT',
  relationKey: LINK_ELT_RELATION,
  validate: (v) => asId(v) !== null,
  // L'équipement doit appartenir au compte ET au bien du document : une carte
  // forgée ne rattache jamais un document à l'équipement d'un autre bien.
  check: async (client, fileId, accountId, value) => {
    const id = asId(value);
    if (id === null) return false;
    const bien = await documentAsset(client, fileId, accountId);
    if (!bien) return false;
    return (await equipmentsOfAsset(client, accountId, bien, [id])).length === 1;
  },
  read: async (client, fileId, accountId) => {
    const [row] = await client
      .select({ v: assetFiles.equipmentId })
      .from(assetFiles)
      .where(and(eq(assetFiles.id, fileId), eq(assetFiles.accountId, accountId)))
      .limit(1);
    return row?.v ?? null;
  },
  write: async (client, fileId, accountId, value) => {
    await client
      .update(assetFiles)
      .set({ equipmentId: value === null ? null : asId(value), updatedAt: new Date() })
      .where(and(eq(assetFiles.id, fileId), eq(assetFiles.accountId, accountId)));
  },
  afterCommit: async ({ accountId, targetId, value, previousValue, undo }) => {
    try {
      const { linkDocumentToAsset, unlinkDocument } = await import('@/services/documents/document-asset-links');
      if (undo) {
        // Annulation : le lien USER posé par la résolution est retiré ; l'ancien
        // équipement (s'il y en avait un) retrouve le sien.
        const posee = asId(previousValue);
        if (posee) await unlinkDocument({ accountId, fileId: targetId, target: { equipmentId: posee }, origins: ['USER'] });
        const restaure = asId(value);
        if (restaure) await linkDocumentToAsset({ accountId, fileId: targetId, target: { equipmentId: restaure }, role: 'SECONDARY', origin: 'USER' });
        return;
      }
      const id = asId(value);
      if (id) await linkDocumentToAsset({ accountId, fileId: targetId, target: { equipmentId: id }, role: 'SECONDARY', origin: 'USER' });
    } catch (e) {
      console.error(`[to-process] lien N-N document ${targetId} → équipement non posé :`, (e as Error).message);
    }
  },
};

const RELATION_WRITERS: RelationWriter[] = [DOCUMENT_ELEMENT_WRITER];

export function findRelationWriter(targetType: string, relationKey: string | null): RelationWriter | null {
  if (!relationKey) return null;
  return RELATION_WRITERS.find((w) => w.targetType === targetType && w.relationKey === relationKey) ?? null;
}

// ── Proposition (pour T3-07) ────────────────────────────────────────────────

export interface EquipmentCandidate {
  equipmentId: number;
  /** 0 → 1, jamais affiché (§11.2). */
  score: number;
  /** Raison lisible (journal / détail), jamais une preuve inventée. */
  reason: string;
}

/**
 * Empreinte de la carte : document + ensemble TRIÉ des équipements
 * candidats. Scores, raisons et ordre en sont exclus : ils varient sans que
 * la question change.
 */
export function documentEquipmentTriggerContext(fileId: number, equipmentIds: number[]): Record<string, unknown> {
  return { fileId, candidates: [...new Set(equipmentIds)].sort((a, b) => a - b) };
}

export type ProposeResult = UpsertActionResult & {
  /** Candidats écartés : équipement introuvable, d'un autre bien ou d'un autre compte. */
  rejected: number[];
};

/**
 * Propose à l'utilisateur de rattacher un document à l'un de plusieurs
 * équipements proches (arbitrage LINK-ELT). Les candidats sont REVÉRIFIÉS :
 * seuls les équipements du compte portés par `assetId` — le bien du
 * document — sont proposés. Moins de deux candidats valides : pas de carte
 * (un seul candidat n'est pas une ambiguïté ; c'est à T3 d'en décider).
 */
export async function proposeDocumentEquipmentLink(p: {
  accountId: number;
  fileId: number;
  assetId: number;
  candidates: Array<{ equipmentId: number; score: number; reason: string }>;
}): Promise<ProposeResult> {
  const bien = await documentAsset(db, p.fileId, p.accountId);
  const ids = [...new Set(p.candidates.map((c) => c.equipmentId).filter((id) => asId(id) !== null))];
  if (bien === undefined || bien !== p.assetId) {
    return { status: 'SKIPPED', reason: 'Document introuvable dans le compte ou porté par un autre bien.', rejected: ids };
  }
  const valides = await equipmentsOfAsset(db, p.accountId, p.assetId, ids);
  const noms = new Map(valides.map((e) => [e.id, e.name]));
  const rejected = ids.filter((id) => !noms.has(id));
  const retenus = p.candidates
    .filter((c) => noms.has(c.equipmentId))
    .reduce<EquipmentCandidate[]>((acc, c) => (acc.some((x) => x.equipmentId === c.equipmentId) ? acc : [...acc, c]), [])
    .sort((a, b) => b.score - a.score || a.equipmentId - b.equipmentId);
  if (retenus.length < 2) {
    return { status: 'SKIPPED', reason: 'Moins de deux équipements candidats valides : pas d’ambiguïté à arbitrer.', rejected };
  }
  const proposals: ActionProposal[] = retenus.map((c) => ({
    value: c.equipmentId,
    label: noms.get(c.equipmentId) ?? `Équipement ${c.equipmentId}`,
    confidence: Math.min(1, Math.max(0, c.score)),
    sourceContext: { label: c.reason.slice(0, 200), targetType: 'EQUIPMENT', targetId: c.equipmentId },
  }));
  const res = await upsertAction({
    accountId: p.accountId,
    targetType: 'DOCUMENT',
    targetId: p.fileId,
    relationKey: LINK_ELT_RELATION,
    actionKind: 'ARBITRATE',
    ruleCode: LINK_ELT_RULE,
    proposals,
    triggerContext: documentEquipmentTriggerContext(p.fileId, retenus.map((c) => c.equipmentId)),
  });
  return { ...res, rejected };
}
