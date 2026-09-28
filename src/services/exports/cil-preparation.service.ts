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
  cilBlockResolutions, assetFiles, equipments,
} from '@/db/schema';
import { eq, and } from 'drizzle-orm';

export type BlockStatus = 'complete' | 'not_applicable' | 'missing' | 'invalid' | 'unknown';

export interface MissingItem {
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
}

export interface CilReadiness {
  globalStatus: 'ready' | 'action_required';
  completion: { resolvedBlocks: number; applicableBlocks: number; totalBlocks: number; percentage: number };
  blocks: CilBlock[];
  /** Blocs qui empêchent la génération (B1, B3, B8 à compléter). */
  blockingBlocks: CilBlock[];
}

/** Code et message renvoyés quand la génération d'un CIL est refusée. */
export const CIL_ACTION_REQUIRED_CODE = 'CIL_ACTION_REQUIRED';
export const CIL_ACTION_REQUIRED_MESSAGE =
  'Le CIL ne peut pas encore être généré : complétez d’abord les informations requises (identification du logement, plans, diagnostic de performance énergétique).';

type CilAsset = { id: number; address: string | null; postalCode: string | null; city: string | null };

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
    .where(and(eq(assetFiles.assetId, assetId), eq(assetFiles.uploadStatus, 'COMPLETED')));

  // Équipements pour B6
  const equips = await db.select({ id: equipments.id }).from(equipments).where(and(eq(equipments.assetId, assetId)));

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
    blocks.push({ id: 'B1', label: 'Identification du logement', status: missingItems.length === 0 ? 'complete' : 'missing', blocking: true, missingItems });
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
    blocks.push({ id: 'B3', label: 'Plans et coupes', status, blocking: status === 'missing', missingItems });
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

  // B6 — Équipements énergétiques
  {
    const res = resolutionMap.get('B6');
    const missingItems: MissingItem[] = [];
    let status: BlockStatus;
    if (res === 'not_applicable') status = 'not_applicable';
    else if (equips.length > 0) status = 'complete';
    else {
      status = 'unknown';
      missingItems.push({ id: 'equipments', label: 'Équipements énergétiques (chauffage, ECS, ventilation…)', target: { type: 'equipments' }, actionLabel: 'Ajouter des équipements' });
    }
    blocks.push({ id: 'B6', label: 'Équipements à incidence énergétique', status, blocking: false, missingItems });
  }

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
    blocks.push({ id: 'B8', label: 'Documents de performance énergétique', status, blocking: true, missingItems });
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
  };
}
