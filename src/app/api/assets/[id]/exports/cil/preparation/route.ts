/**
 * GET /api/assets/[id]/exports/cil/preparation
 * Retourne l'éligibilité CIL + l'état de complétude des blocs B1-B9 (CDC §6.3)
 */

import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import {
  assets, assetCilProfiles, energyMaterials, energyWorks,
  cilBlockResolutions, assetFiles, exportGenerations, equipments, agendaItems,
} from '@/db/schema';
import { eq, and, ne, desc } from 'drizzle-orm';

type BlockStatus = 'complete' | 'not_applicable' | 'missing' | 'invalid' | 'unknown';

interface MissingItem {
  id: string;
  label: string;
  target: { type: string; filter?: string };
  actionLabel: string;
}

interface CilBlock {
  id: string;
  label: string;
  status: BlockStatus;
  blocking: boolean;
  missingItems: MissingItem[];
}

const ELIGIBLE_SUBTYPES = [
  'Maison', 'maison', 'MAISON',
  'Appartement', 'appartement', 'APPARTEMENT',
  'Immeuble', 'immeuble', 'IMMEUBLE',
  'Mobil-home', 'mobil-home', 'MOBIL-HOME', 'Mobilhome', 'mobilhome',
];

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await SessionService.getSession(request);
    const { id } = await params;
    const assetId = parseInt(id);
    if (isNaN(assetId)) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });

    const [asset] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.userId, session.userId)))
      .limit(1);
    if (!asset) return NextResponse.json({ error: 'ASSET_NOT_FOUND' }, { status: 404 });

    // Eligibility check
    const isImmobilier = asset.category === 'IMMOBILIER';
    const subtypeLabel = asset.subtype ?? '';
    const isEligible = isImmobilier && ELIGIBLE_SUBTYPES.some(s =>
      subtypeLabel.toLowerCase().includes(s.toLowerCase())
    );

    if (!isEligible) {
      return NextResponse.json({
        assetId,
        eligible: false,
        eligibilityReason: 'not_eligible_asset_subtype',
      });
    }

    // Load related data
    const [cilProfile] = await db
      .select()
      .from(assetCilProfiles)
      .where(eq(assetCilProfiles.assetId, assetId))
      .limit(1);

    const materials = await db
      .select()
      .from(energyMaterials)
      .where(eq(energyMaterials.assetId, assetId));

    const works = await db
      .select()
      .from(energyWorks)
      .where(eq(energyWorks.assetId, assetId));

    const resolutions = await db
      .select()
      .from(cilBlockResolutions)
      .where(eq(cilBlockResolutions.assetId, assetId));

    const resolutionMap = new Map(resolutions.map(r => [r.blockId, r.resolution]));

    // Load documents for B3/B4/B8
    const docs = await db
      .select({
        id: assetFiles.id,
        retainedFunctionCode: assetFiles.retainedFunctionCode,
        documentType: assetFiles.documentType,
        cilRubricCodes: assetFiles.cilRubricCodes,
      })
      .from(assetFiles)
      .where(and(
        eq(assetFiles.assetId, assetId),
        eq(assetFiles.uploadStatus, 'COMPLETED'),
      ));

    // Load equipments for B6
    const equips = await db
      .select({ id: equipments.id })
      .from(equipments)
      .where(and(
        eq(equipments.assetId, assetId),
      ));

    const hasDoc = (code: string) =>
      docs.some(d =>
        d.retainedFunctionCode === code ||
        d.documentType === code ||
        (typeof d.cilRubricCodes === 'string' && (() => { try { return JSON.parse(d.cilRubricCodes as string); } catch { return []; } })().includes(code)) ||
        (Array.isArray(d.cilRubricCodes) && (d.cilRubricCodes as string[]).includes(code))
      );

    // Last export_generation CIL
    const [lastGen] = await db
      .select({ id: exportGenerations.id, publicId: exportGenerations.publicId, createdAt: exportGenerations.createdAt, status: exportGenerations.status })
      .from(exportGenerations)
      .where(and(
        eq(exportGenerations.assetId, assetId),
        eq(exportGenerations.exportType, 'CIL_REGLEMENTAIRE'),
        ne(exportGenerations.status, 'deleted'),
        ne(exportGenerations.status, 'cancelled'),
      ))
      .orderBy(desc(exportGenerations.createdAt))
      .limit(1);

    // ── Evaluate blocks ──────────────────────────────────────────────────────

    const blocks: CilBlock[] = [];

    // B1 — Identification
    {
      const missingItems: MissingItem[] = [];
      if (!asset.address) missingItems.push({ id: 'address', label: 'Adresse', target: { type: 'details', filter: 'address' }, actionLabel: 'Renseigner l\'adresse' });
      if (!asset.postalCode) missingItems.push({ id: 'postal_code', label: 'Code postal', target: { type: 'details', filter: 'address' }, actionLabel: 'Renseigner le code postal' });
      if (!asset.city) missingItems.push({ id: 'city', label: 'Ville', target: { type: 'details', filter: 'address' }, actionLabel: 'Renseigner la ville' });

      blocks.push({
        id: 'B1',
        label: 'Identification du logement',
        status: missingItems.length === 0 ? 'complete' : 'missing',
        blocking: true,
        missingItems,
      });
    }

    // B3 — Plans et coupes
    {
      const res = resolutionMap.get('B3');
      const hasPlan = hasDoc('PLAN_CONSTRUCTION');
      const missingItems: MissingItem[] = [];
      let status: BlockStatus;

      if (res === 'not_applicable') {
        status = 'not_applicable';
      } else if (hasPlan) {
        status = 'complete';
      } else {
        status = 'missing';
        missingItems.push({ id: 'plan_construction', label: 'Plans de construction / coupes', target: { type: 'documents', filter: 'PLAN_CONSTRUCTION' }, actionLabel: 'Ajouter les plans' });
      }

      blocks.push({ id: 'B3', label: 'Plans et coupes', status, blocking: status === 'missing', missingItems });
    }

    // B4 — Réseaux
    {
      const res = resolutionMap.get('B4');
      const networkCodes = ['RESEAU_EAU', 'RESEAU_ELECTRICITE', 'RESEAU_GAZ', 'RESEAU_AERATION'];
      const hasSomeNetwork = networkCodes.some(c => hasDoc(c));
      const missingItems: MissingItem[] = [];
      let status: BlockStatus;

      if (res === 'not_applicable') {
        status = 'not_applicable';
      } else if (hasSomeNetwork) {
        status = 'complete';
      } else {
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

      if (res === 'not_applicable') {
        status = 'not_applicable';
      } else if (materials.length > 0) {
        status = 'complete';
      } else {
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

      if (res === 'not_applicable') {
        status = 'not_applicable';
      } else if (equips.length > 0) {
        status = 'complete';
      } else {
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

      if (res === 'not_applicable') {
        status = 'not_applicable';
      } else if (works.length > 0) {
        const hasInvalidWork = works.some(w => !w.completedAt);
        if (hasInvalidWork) {
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
      const hasDpe = hasDoc('DPE');
      const missingItems: MissingItem[] = [];
      let status: BlockStatus;

      if (hasDpe) {
        status = 'complete';
      } else {
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

    // ── Global status ────────────────────────────────────────────────────────
    const applicableBlocks = blocks.filter(b => b.status !== 'not_applicable');
    const resolvedBlocks = blocks.filter(b => b.status === 'complete' || b.status === 'not_applicable');
    const percentage = applicableBlocks.length === 0
      ? 100
      : Math.round((resolvedBlocks.length / blocks.length) * 100);

    const hasBlocker = blocks.some(b => b.blocking && (b.status === 'missing' || b.status === 'invalid' || b.status === 'unknown'));
    const globalStatus = hasBlocker ? 'action_required' : 'ready';

    return NextResponse.json({
      assetId,
      eligible: true,
      eligibilityReason: 'maison_ou_appartement',
      globalStatus,
      completion: {
        resolvedBlocks: resolvedBlocks.length,
        applicableBlocks: applicableBlocks.length,
        totalBlocks: blocks.length,
        percentage,
      },
      blocks,
      lastGeneration: lastGen
        ? {
            id: lastGen.id,
            publicId: lastGen.publicId,
            createdAt: lastGen.createdAt,
            status: lastGen.status,
            downloadUrl: null,
          }
        : null,
      assetName: asset.name,
      assetAddress: [asset.address, asset.postalCode, asset.city].filter(Boolean).join(', '),
      assetSubtype: asset.subtype,
    });
  } catch (err: any) {
    console.error('[CIL preparation] error:', err);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
