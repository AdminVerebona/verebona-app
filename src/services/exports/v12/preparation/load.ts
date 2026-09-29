/**
 * Orchestration serveur des API `prepare` et `estimate` (CDC V12 §17.1) :
 * contrôles d'accès métier (éligibilité, offre), lecture des données du bien
 * (`loadExportSource`, même lecture que la génération), dernière génération
 * (PREP-HEA-005/006), puis calcul PUR (`prepare.ts`, `estimate.ts`).
 *
 * Aucune écriture (§15.1 « déterministe, sans mutation ») : les
 * informations complémentaires sont enregistrées par leur propre API.
 * L'accès au bien (compte courant, Duo compris — DRH-001/002) est vérifié
 * par la route (`findAccessibleAssetForExport`).
 */

import { db } from '@/db';
import { exportGenerations, users } from '@/db/schema';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { isCilEligible, CIL_NOT_ELIGIBLE_MESSAGE } from '@/lib/asset-capabilities';
import { canUsePremiumFeature } from '@/services/entitlements.service';
import {
  familyIneligibilityMessage, isDossierEligibleForFamily, normalizeExportCode, LEGACY_EXPORT_CODE_MAP, type DossierCode,
} from '@/services/exports/catalog';
import { EXPORT_ERROR_MESSAGES } from '@/services/exports/export-errors';
import type { AccessibleAsset } from '@/services/exports/export-access';
import { loadExportSource } from '../data/source';
import { parseChoicesPayload, type ExportChoices } from '../data/choices';
import { parisDate } from '../generation/clock';
import { toGenerationDto } from '../generation/status';
import { buildPreparation, estimateMessages } from './prepare';
import { estimateSelection } from './estimate';
import type { EstimateResponse, PreparationDto } from './types';

export type PrepResult<T> = { ok: true; body: T } | { ok: false; status: number; code: string; message: string; extra?: Record<string, unknown> };

/** Type de dossier et droits (§17.3 : INVALID_EXPORT_TYPE 400, NOT_ELIGIBLE 422, offre 403). */
async function checkDossier(asset: AccessibleAsset, rawType: unknown): Promise<PrepResult<DossierCode>> {
  const code = normalizeExportCode(rawType);
  if (!code || code === 'EXPORT_BRUT') {
    return { ok: false, status: 400, code: 'INVALID_EXPORT_TYPE', message: EXPORT_ERROR_MESSAGES.INVALID_EXPORT_TYPE };
  }
  if (!isDossierEligibleForFamily(code, asset.category)) {
    return { ok: false, status: 422, code: 'NOT_ELIGIBLE', message: familyIneligibilityMessage(code) };
  }
  if (code === 'CIL' && !isCilEligible(asset)) {
    return { ok: false, status: 422, code: 'NOT_ELIGIBLE', message: CIL_NOT_ELIGIBLE_MESSAGE };
  }
  const decision = await canUsePremiumFeature(asset.accountId);
  if (!decision.allowed) {
    return { ok: false, status: 403, code: decision.reason ?? 'PREMIUM_REQUIRED', message: decision.message ?? 'Les dossiers prêts à l’emploi sont disponibles avec Premium et Premium Duo.' };
  }
  return { ok: true, body: code };
}

/** Dernière génération du dossier pour ce bien, auteur compris (Duo, DRH-003). */
async function lastGenerationOf(assetId: number, code: DossierCode): Promise<PreparationDto['lastGeneration']> {
  const codes = [code, ...Object.entries(LEGACY_EXPORT_CODE_MAP).filter(([, v]) => v === code).map(([k]) => k)];
  const [row] = await db.select().from(exportGenerations)
    .where(and(eq(exportGenerations.assetId, assetId), inArray(exportGenerations.exportType, codes)))
    .orderBy(desc(exportGenerations.createdAt)).limit(1);
  if (!row) return null;
  const [author] = await db.select({ firstName: users.firstName, lastName: users.lastName }).from(users).where(eq(users.id, row.userId)).limit(1);
  const authorName = author ? [author.firstName, author.lastName].filter((x) => x?.trim()).join(' ') || null : null;
  const dto = toGenerationDto(row, { authorName });
  return { publicId: dto.publicId, status: dto.generationStatus, createdAt: new Date(dto.createdAt).toISOString(), authorName };
}

type PrepError = Extract<PrepResult<never>, { ok: false }>;

/** Choix transmis par l'écran (`choices`, forme §17.2) ; `null` si absents. */
function readChoices(code: DossierCode, raw: unknown): { ok: true; choices: ExportChoices | null } | PrepError {
  if (raw == null) return { ok: true, choices: null };
  const parsed = parseChoicesPayload(code, raw);
  if (!parsed.ok) return { ok: false, status: 400, code: 'INVALID_PAYLOAD', message: 'La sélection transmise est invalide.', extra: { issues: parsed.issues } };
  return { ok: true, choices: parsed.choices };
}

/** `POST …/exports/prepare` : `{ exportType, includeCurrentSelections?, choices? }`. */
export async function prepareDossier(params: { asset: AccessibleAsset; userId: number; body: Record<string, unknown> }): Promise<PrepResult<PreparationDto>> {
  const { asset, userId, body } = params;
  const checked = await checkDossier(asset, body.exportType);
  if (!checked.ok) return checked;
  const code = checked.body;
  let choices: ExportChoices | null = null;
  if (body.includeCurrentSelections === true) {
    const read = readChoices(code, body.choices);
    if (!read.ok) return read;
    choices = read.choices;
  }
  const today = parisDate();
  const [source, lastGeneration] = await Promise.all([
    loadExportSource({ assetId: asset.id, accountId: asset.accountId, userId, exportType: code }),
    lastGenerationOf(asset.id, code),
  ]);
  return { ok: true, body: buildPreparation(code, source, { today, choices, lastGeneration }) };
}

/** `POST …/exports/estimate` : `{ exportType, choices }` → estimation, actions, messages. */
export async function estimateDossier(params: { asset: AccessibleAsset; userId: number; body: Record<string, unknown> }): Promise<PrepResult<EstimateResponse>> {
  const { asset, userId, body } = params;
  const checked = await checkDossier(asset, body.exportType);
  if (!checked.ok) return checked;
  const code = checked.body;
  const read = readChoices(code, body.choices ?? {});
  if (!read.ok) return read;
  const choices = read.choices!;
  const today = parisDate();
  const source = await loadExportSource({ assetId: asset.id, accountId: asset.accountId, userId, exportType: code });
  const { dto } = estimateSelection(code, source, choices, today);
  const cilBlocked = code === 'CIL' && source.cil?.readiness.globalStatus === 'action_required';
  const canGeneratePdf = !cilBlocked && dto.blocking.length === 0;
  return {
    ok: true,
    body: { estimate: dto, actions: { canGeneratePdf, canGenerateZip: canGeneratePdf && dto.outputFormat === 'ZIP' }, messages: estimateMessages(dto) },
  };
}
