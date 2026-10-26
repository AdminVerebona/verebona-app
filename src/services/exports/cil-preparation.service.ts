/**
 * État de préparation du CIL (blocs B1, B3-B9) — CDC Exports V12 §8 / §20.
 *
 * Extrait de `exports/cil/preparation/route.ts` pour que la génération
 * (`POST /api/assets/[id]/exports` et la relance) applique la même règle que
 * l'écran de préparation : CIL-RULE-002 — B1, B3 et B8 bloquent la
 * génération tant qu'ils sont à compléter. Le statut « action requise » était
 * calculé mais n'empêchait rien.
 */

import { db } from '@/db';
import {
  energyMaterials, energyWorks,
  cilBlockResolutions, assetFiles, equipments, equipmentCilSpecs,
} from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { documentInAssetsCondition } from '@/services/documents/asset-document-scope';
import { classifyCilEnergyEquipment, type CilEnergyEquipmentInput } from '@/lib/cil/energy-equipment';
import { isCilBlockingRuleBlock } from '@/lib/exports/cil-blocking';

type BlockStatus = 'complete' | 'not_applicable' | 'missing' | 'invalid' | 'unknown';

interface MissingItem {
  id: string;
  label: string;
  target: { type: string; filter?: string };
  actionLabel: string;
}

export interface CilBlock {
  id: string;
  label: string;
  status: BlockStatus;
  blocking: boolean;
  missingItems: MissingItem[];
  /**
   * Lot 75A : résolution utilisateur CONSERVÉE en base mais neutralisée dans
   * l'état effectif parce qu'elle contredit les données réelles (B6 déclaré
   * « Non applicable » alors que des équipements énergétiques sont retenus).
   */
  neutralizedResolution?: 'not_applicable';
  /** Information affichée à l'utilisateur (préparation) ; absente sinon. */
  notice?: string;
}

export interface CilReadiness {
  globalStatus: 'ready' | 'action_required';
  completion: { resolvedBlocks: number; applicableBlocks: number; totalBlocks: number; percentage: number };
  blocks: CilBlock[];
  /**
   * Blocs qui empêchent RÉELLEMENT la génération (sous-ensemble de la règle
   * CIL-RULE-002, `CIL_BLOCKING_BLOCK_IDS`) : seule source des messages.
   */
  blockingBlocks: CilBlock[];
  /**
   * Équipements retenus pour B6 (règle partagée `classifyCilEnergyEquipment`) :
   * le mappeur et le PDF reprennent EXACTEMENT cette liste. Absent dans un
   * état antérieur au lot 69 : le mappeur réapplique la même règle.
   */
  energyEquipmentIds?: number[];
}

/** Code et message renvoyés quand la génération d'un CIL est refusée. */
export const CIL_ACTION_REQUIRED_CODE = 'CIL_ACTION_REQUIRED';

type CilAsset = { id: number; address: string | null; postalCode: string | null; city: string | null };

/** Ligne d'équipement lue pour B6 (colonnes structurées seulement). */
export type CilEquipmentRow = CilEnergyEquipmentInput & { id: number };

/** Code et message du refus de « Non applicable » sur B6 (lot 75A). */
export const CIL_B6_NOT_APPLICABLE_REFUSED_CODE = 'CIL_B6_ENERGY_EQUIPMENT_PRESENT';
export function cilB6NotApplicableRefusedMessage(n: number): string {
  return `Ce bloc ne peut pas être déclaré non applicable : ${n > 1 ? `${n} équipements à incidence énergétique sont identifiés` : 'un équipement à incidence énergétique est identifié'} pour ce logement. `
    + 'Modifiez l’usage énergétique de ces équipements si nécessaire.';
}

/** Information quand une ancienne déclaration « Non applicable » est neutralisée. */
function cilB6NeutralizedNotice(n: number): string {
  return `Une déclaration « Non applicable » avait été enregistrée pour ce bloc, mais ${n > 1 ? `${n} équipements à incidence énergétique sont désormais identifiés` : 'un équipement à incidence énergétique est désormais identifié'} : `
    + 'le bloc est donc considéré comme renseigné. La déclaration reste conservée ; elle redeviendrait effective si plus aucun équipement énergétique n’était retenu.';
}

/**
 * B6 — pur : même règle que le mappeur et le PDF. « Renseigné » si au moins
 * un équipement est classé à incidence énergétique ; un équipement
 * quelconque (télévision, portail) ne suffit plus (lot 69, §3.3).
 *
 * Lot 75A : un équipement énergétique RETENU rend B6 « Renseigné » même si
 * une résolution `not_applicable` existe (déclaration antérieure à l'ajout
 * d'une PAC, au changement de type…) : la résolution n'est ni supprimée ni
 * modifiée, elle est NEUTRALISÉE dans l'état effectif et signalée
 * (`neutralizedResolution`, `notice`). Sans équipement énergétique, la
 * déclaration s'applique de nouveau (recalcul à chaque évaluation).
 */
export function evaluateCilB6(equips: readonly CilEquipmentRow[], resolution: string | undefined): { block: CilBlock; energyEquipmentIds: number[] } {
  const energyEquipmentIds = equips.filter((e) => classifyCilEnergyEquipment(e) !== null).map((e) => e.id);
  const missingItems: MissingItem[] = [];
  const block: CilBlock = { id: 'B6', label: 'Équipements à incidence énergétique', status: 'unknown', blocking: false, missingItems };
  if (energyEquipmentIds.length > 0) {
    block.status = 'complete';
    if (resolution === 'not_applicable') {
      block.neutralizedResolution = 'not_applicable';
      block.notice = cilB6NeutralizedNotice(energyEquipmentIds.length);
    }
  } else if (resolution === 'not_applicable') {
    block.status = 'not_applicable';
  } else {
    missingItems.push(equips.length > 0
      // Des équipements existent mais aucun n'est caractérisé : on le dit (pas « aucun équipement »).
      ? { id: 'equipments_unclassified', label: 'Aucun équipement caractérisé comme énergétique (précisez l’usage énergétique ou le type de l’équipement)', target: { type: 'equipments' }, actionLabel: 'Préciser l’usage énergétique des équipements' }
      : { id: 'equipments', label: 'Équipements énergétiques (chauffage, ECS, ventilation…)', target: { type: 'equipments' }, actionLabel: 'Ajouter des équipements' });
  }
  return { block, energyEquipmentIds };
}

/**
 * Équipements lus pour B6 (données structurées, archivés exclus comme dans
 * l'export) — même lecture pour l'évaluation et pour le refus de « Non
 * applicable » (route des résolutions, lot 75A).
 */
export async function loadCilB6Equipments(assetId: number): Promise<CilEquipmentRow[]> {
  return db
    .select({
      id: equipments.id, energyUsage: equipments.energyUsage, type: equipments.type, category: equipments.category,
      energyType: equipmentCilSpecs.energyType, evacuationMode: equipmentCilSpecs.evacuationMode,
      heatNetworkDeliveryStation: equipmentCilSpecs.heatNetworkDeliveryStation,
    })
    .from(equipments)
    .leftJoin(equipmentCilSpecs, eq(equipmentCilSpecs.equipmentId, equipments.id))
    .where(and(eq(equipments.assetId, assetId), isNull(equipments.archivedAt)));
}

/** Identifiants des équipements retenus pour B6 (même règle que l'évaluation). */
export async function cilB6EnergyEquipmentIds(assetId: number): Promise<number[]> {
  return evaluateCilB6(await loadCilB6Equipments(assetId), undefined).energyEquipmentIds;
}

/** Un bloc bloquant qui n'est ni complet ni non applicable. */
export function isBlockBlocking(b: CilBlock): boolean {
  return b.blocking && (b.status === 'missing' || b.status === 'invalid' || b.status === 'unknown');
}

export async function evaluateCilReadiness(asset: CilAsset): Promise<CilReadiness> {
  const assetId = asset.id;

  const materials = await db.select().from(energyMaterials).where(eq(energyMaterials.assetId, assetId));
  const works = await db.select().from(energyWorks).where(eq(energyWorks.assetId, assetId));
  const resolutions = await db.select().from(cilBlockResolutions).where(eq(cilBlockResolutions.assetId, assetId));
  const resolutionMap = new Map(resolutions.map(r => [r.blockId, r.resolution]));

  // Documents pour B3/B4/B8
  const docs = await db
    .select({
      id: assetFiles.id,
      retainedFunctionCode: assetFiles.retainedFunctionCode,
      documentType: assetFiles.documentType,
      cilRubricCodes: assetFiles.cilRubricCodes,
    })
    .from(assetFiles)
    // Lot 32C (PO 9) : un document lié au bien (relation N-N) compte aussi.
    .where(and(documentInAssetsCondition([assetId]), eq(assetFiles.uploadStatus, 'COMPLETED')));

  // Équipements pour B6 : données structurées (règle partagée), équipements
  // archivés exclus comme dans l'export (avant le lot 69 : tout équipement
  // existant, archivé compris, rendait B6 « renseigné »).
  const equips = await loadCilB6Equipments(assetId);

  const hasDoc = (code: string) =>
    docs.some(d =>
      d.retainedFunctionCode === code ||
      d.documentType === code ||
      (typeof d.cilRubricCodes === 'string' && (() => { try { return JSON.parse(d.cilRubricCodes as string); } catch { return []; } })().includes(code)) ||
      (Array.isArray(d.cilRubricCodes) && (d.cilRubricCodes as string[]).includes(code))
    );

  const blocks: CilBlock[] = [];

  // B1 — Identification
  {
    const missingItems: MissingItem[] = [];
    if (!asset.address) missingItems.push({ id: 'address', label: 'Adresse', target: { type: 'details', filter: 'address' }, actionLabel: 'Renseigner l\'adresse' });
    if (!asset.postalCode) missingItems.push({ id: 'postal_code', label: 'Code postal', target: { type: 'details', filter: 'address' }, actionLabel: 'Renseigner le code postal' });
    if (!asset.city) missingItems.push({ id: 'city', label: 'Ville', target: { type: 'details', filter: 'address' }, actionLabel: 'Renseigner la ville' });
    blocks.push({ id: 'B1', label: 'Identification du logement', status: missingItems.length === 0 ? 'complete' : 'missing', blocking: isCilBlockingRuleBlock('B1'), missingItems });
  }

  // B3 — Plans et coupes
  {
    const res = resolutionMap.get('B3');
    const missingItems: MissingItem[] = [];
    let status: BlockStatus;
    if (res === 'not_applicable') status = 'not_applicable';
    else if (hasDoc('PLAN_CONSTRUCTION')) status = 'complete';
    else {
      status = 'missing';
      missingItems.push({ id: 'plan_construction', label: 'Plans de construction / coupes', target: { type: 'documents', filter: 'PLAN_CONSTRUCTION' }, actionLabel: 'Ajouter les plans' });
    }
    blocks.push({ id: 'B3', label: 'Plans et coupes', status, blocking: isCilBlockingRuleBlock('B3') && status === 'missing', missingItems });
  }

  // B4 — Réseaux
  {
    const res = resolutionMap.get('B4');
    const networkCodes = ['RESEAU_EAU', 'RESEAU_ELECTRICITE', 'RESEAU_GAZ', 'RESEAU_AERATION'];
    const missingItems: MissingItem[] = [];
    let status: BlockStatus;
    if (res === 'not_applicable') status = 'not_applicable';
    else if (networkCodes.some(c => hasDoc(c))) status = 'complete';
    else {
      status = 'unknown';
      missingItems.push({ id: 'reseau', label: 'Plans / schémas réseaux (eau, électricité, gaz, aération)', target: { type: 'documents', filter: 'reseau' }, actionLabel: 'Ajouter les plans réseaux' });
    }
    blocks.push({ id: 'B4', label: 'Réseaux', status, blocking: false, missingItems });
  }

  // B5 — Matériaux énergétiques
  {
    const res = resolutionMap.get('B5');
    const missingItems: MissingItem[] = [];
    let status: BlockStatus;
    if (res === 'not_applicable') status = 'not_applicable';
    else if (materials.length > 0) status = 'complete';
    else {
      status = 'unknown';
      missingItems.push({ id: 'energy_materials', label: 'Matériaux d\'isolation thermique', target: { type: 'energy_materials' }, actionLabel: 'Ajouter les matériaux' });
    }
    blocks.push({ id: 'B5', label: 'Matériaux à incidence énergétique', status, blocking: false, missingItems });
  }

  // B6 — Équipements énergétiques (règle partagée avec le mappeur et le PDF)
  const b6 = evaluateCilB6(equips, resolutionMap.get('B6'));
  blocks.push(b6.block);

  // B7 — Travaux de rénovation énergétique
  {
    const res = resolutionMap.get('B7');
    const missingItems: MissingItem[] = [];
    let status: BlockStatus;
    if (res === 'not_applicable') status = 'not_applicable';
    else if (works.length > 0) {
      if (works.some(w => !w.completedAt)) {
        status = 'invalid';
        missingItems.push({ id: 'work_date', label: 'Date de réalisation manquante sur certains travaux', target: { type: 'energy_works' }, actionLabel: 'Compléter les travaux' });
      } else {
        status = 'complete';
      }
    } else {
      status = 'unknown';
      missingItems.push({ id: 'energy_works', label: 'Travaux de rénovation énergétique', target: { type: 'agenda' }, actionLabel: 'Ajouter des travaux' });
    }
    blocks.push({ id: 'B7', label: 'Travaux de rénovation énergétique', status, blocking: false, missingItems });
  }

  // B8 — Documents de performance énergétique
  {
    const missingItems: MissingItem[] = [];
    let status: BlockStatus;
    if (hasDoc('DPE')) status = 'complete';
    else {
      status = 'missing';
      missingItems.push({ id: 'dpe_file', label: 'Diagnostic de performance énergétique (DPE)', target: { type: 'documents', filter: 'DPE' }, actionLabel: 'Ajouter un DPE' });
    }
    blocks.push({ id: 'B8', label: 'Documents de performance énergétique', status, blocking: isCilBlockingRuleBlock('B8'), missingItems });
  }

  // B9 — Documents annexes
  {
    const res = resolutionMap.get('B9');
    blocks.push({
      id: 'B9',
      label: 'Documents annexes',
      status: res === 'not_applicable' ? 'not_applicable' : docs.length > 0 ? 'complete' : 'unknown',
      blocking: false,
      missingItems: [],
    });
  }

  // ── Statut global ─────────────────────────────────────────────────────────
  const applicableBlocks = blocks.filter(b => b.status !== 'not_applicable');
  const resolvedBlocks = blocks.filter(b => b.status === 'complete' || b.status === 'not_applicable');
  const percentage = applicableBlocks.length === 0
    ? 100
    : Math.round((resolvedBlocks.length / blocks.length) * 100);

  const blockingBlocks = blocks.filter(isBlockBlocking);

  return {
    globalStatus: blockingBlocks.length > 0 ? 'action_required' : 'ready',
    completion: {
      resolvedBlocks: resolvedBlocks.length,
      applicableBlocks: applicableBlocks.length,
      totalBlocks: blocks.length,
      percentage,
    },
    blocks,
    blockingBlocks,
    energyEquipmentIds: b6.energyEquipmentIds,
  };
}
