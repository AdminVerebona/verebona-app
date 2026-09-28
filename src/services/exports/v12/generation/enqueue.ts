/**
 * Demande de génération d'un dossier V12 (POST, §17.2) : contrôles
 * synchrones (type, éligibilité, offre, CIL-RULE-002, seuils §6.3), puis mise
 * en file (`status = queued`) — le rendu est asynchrone (worker).
 *
 * Accepte le payload V12 (`choices` : sections / items / modes /
 * acknowledgements) et, en attendant l'écran de préparation, les options du
 * tiroir historique (`options.customDocIds`, `options.includePhotos`,
 * `requestedOutputs`) — converties avec les pré-sélections du CDC.
 */

import { createHash } from 'node:crypto';
import { db } from '@/db';
import { exportGenerations } from '@/db/schema';
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { isCilEligible, CIL_NOT_ELIGIBLE_MESSAGE } from '@/lib/asset-capabilities';
import { canUsePremiumFeature } from '@/services/entitlements.service';
import { familyIneligibilityMessage, isDossierEligibleForFamily, type DossierCode } from '@/services/exports/catalog';
import { evaluateCilReadiness, CIL_ACTION_REQUIRED_CODE, CIL_ACTION_REQUIRED_MESSAGE } from '@/services/exports/cil-preparation.service';
import { EXPORT_ERROR_MESSAGES } from '@/services/exports/export-errors';
import type { AccessibleAsset } from '@/services/exports/export-access';
import { loadExportSource } from '../data/source';
import { parseChoicesPayload, planSelection, type LegacyDrawerOptions, type OutputFormat } from '../data/choices';
import { evaluateThresholds, estimatePages, type ThresholdAlert } from '../thresholds';
import { templateVersion } from '../templates';
import { effectiveChoices, type GenerationRequestSnapshot } from './job';
import { parisDate } from './clock';
import { MAX_ACTIVE_PER_ACCOUNT, type GenerationRow } from './repository';

export type EnqueueResult =
  | { ok: true; generation: GenerationRow; warnings: ThresholdAlert[]; reused: boolean }
  | { ok: false; status: number; code: string; message: string; extra?: Record<string, unknown> };

/** Double-clic : une génération identique encore en file est réutilisée. */
const DEDUP_WINDOW_MS = 2 * 60 * 1000;

export const TOO_MANY_GENERATIONS_MESSAGE =
  `Vous avez déjà ${MAX_ACTIVE_PER_ACCOUNT} dossiers en cours de préparation. Attendez qu'ils soient prêts avant d'en lancer un nouveau.`;

/** JSON canonique (clés triées) : deux demandes identiques ont la même empreinte. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>).sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * Empreinte d'une demande (type, format, choix V12 OU options du tiroir,
 * variante) : seule une demande STRICTEMENT identique est dédoublonnée —
 * deux clics avec des options différentes donnent deux générations.
 */
export function requestHash(code: string, req: Pick<GenerationRequestSnapshot, 'outputFormat' | 'choices' | 'legacyOptions'>, variant: string | null): string {
  return createHash('sha256')
    .update(canonical({ code, outputFormat: req.outputFormat, choices: req.choices ?? null, legacyOptions: req.legacyOptions ?? null, variant }))
    .digest('hex');
}

export async function enqueueGeneration(params: {
  asset: AccessibleAsset;
  userId: number;
  code: DossierCode;
  body: Record<string, unknown>;
}): Promise<EnqueueResult> {
  const { asset, userId, code, body } = params;

  // Éligibilité (§1.2) : famille, et maison / appartement pour le CIL.
  if (!isDossierEligibleForFamily(code, asset.category)) {
    return { ok: false, status: 422, code: 'NOT_ELIGIBLE', message: familyIneligibilityMessage(code) };
  }
  if (code === 'CIL' && !isCilEligible(asset)) {
    return { ok: false, status: 422, code: 'NOT_ELIGIBLE', message: CIL_NOT_ELIGIBLE_MESSAGE };
  }

  // Dossiers prêts à l'emploi : Premium et Premium Duo (essai compris).
  const decision = await canUsePremiumFeature(asset.accountId);
  if (!decision.allowed) {
    return { ok: false, status: 403, code: decision.reason ?? 'FORBIDDEN', message: decision.message ?? EXPORT_ERROR_MESSAGES.FORBIDDEN };
  }

  // CIL-RULE-002.
  if (code === 'CIL') {
    const readiness = await evaluateCilReadiness(asset);
    if (readiness.globalStatus === 'action_required') {
      return {
        ok: false, status: 422, code: CIL_ACTION_REQUIRED_CODE, message: CIL_ACTION_REQUIRED_MESSAGE,
        extra: { blockingBlocks: readiness.blockingBlocks.map((b) => ({ id: b.id, label: b.label })) },
      };
    }
  }

  // Choix : payload V12 explicite, sinon options du tiroir historique.
  const requested = Array.isArray(body.requestedOutputs) ? body.requestedOutputs.map(String) : [];
  const rawChoices = body.choices as Record<string, unknown> | undefined;
  const outputFormat: OutputFormat = (rawChoices?.outputFormat ?? body.outputFormat) === 'ZIP' || requested.includes('ZIP') ? 'ZIP' : 'PDF';
  const req: GenerationRequestSnapshot = { outputFormat, requestedAt: new Date().toISOString() };
  if (rawChoices) {
    const parsed = parseChoicesPayload(code, { ...rawChoices, outputFormat });
    if (!parsed.ok) return { ok: false, status: 400, code: 'INVALID_PAYLOAD', message: 'La sélection transmise est invalide.', extra: { issues: parsed.issues } };
    req.choices = parsed.choices;
  } else if (body.options && typeof body.options === 'object') {
    req.legacyOptions = body.options as LegacyDrawerOptions;
  }

  // Seuils (§6.3) sur l'estimation : un dossier bloqué n'est pas mis en file.
  const today = parisDate();
  const source = await loadExportSource({ assetId: asset.id, accountId: asset.accountId, userId, exportType: code });
  const plan = planSelection(code, source, effectiveChoices(code, source, req, today), today);
  const pdfDocs = plan.documents.filter((pd) => pd.mode === 'PDF');
  const { warnings, blocking } = evaluateThresholds({
    integratedDocuments: pdfDocs.length,
    photos: plan.photos.length,
    totalBytes: [...plan.documents.map((pd) => pd.doc.sizeBytes ?? 0), ...plan.photos.map((pp) => pp.photo.sizeBytes ?? 0)].reduce((s, b) => s + b, 0),
    pages: estimatePages({
      integratedPdfBytes: pdfDocs.filter((pd) => pd.doc.format === 'PDF').map((pd) => pd.doc.sizeBytes ?? 0),
      integratedImages: pdfDocs.filter((pd) => pd.doc.format !== 'PDF').length,
      photos: plan.photos.length,
    }),
  });
  if (blocking.length) {
    return { ok: false, status: 422, code: 'THRESHOLD_BLOCKED', message: EXPORT_ERROR_MESSAGES.THRESHOLD_BLOCKED, extra: { blocking, warnings } };
  }

  // Double-clic : même bien, même dossier, MÊME demande (empreinte), encore
  // en file ; puis plafond de générations actives par compte. Les deux
  // contrôles et l'insertion sont sérialisés par compte (verrou consultatif
  // transactionnel) : deux requêtes simultanées ne dépassent pas le plafond.
  const variant = typeof body.variant === 'string' ? body.variant : null;
  req.requestHash = requestHash(code, req, variant);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`export-enqueue:${asset.accountId}`}))`);
    const [existing] = await tx.select().from(exportGenerations)
      .where(and(
        eq(exportGenerations.assetId, asset.id),
        inArray(exportGenerations.exportType, [code]),
        inArray(exportGenerations.status, ['queued', 'generating']),
        gt(exportGenerations.createdAt, new Date(Date.now() - DEDUP_WINDOW_MS)),
        sql`${exportGenerations.snapshotJson} -> 'request' ->> 'requestHash' = ${req.requestHash}`,
      ))
      .orderBy(desc(exportGenerations.createdAt)).limit(1);
    if (existing) return { ok: true as const, generation: existing, warnings, reused: true };

    const [active] = await tx.select({ n: sql<number>`count(*)::int` }).from(exportGenerations)
      .where(and(
        eq(exportGenerations.accountId, asset.accountId),
        inArray(exportGenerations.status, ['queued', 'generating']),
        sql`${exportGenerations.exportType} <> 'EXPORT_BRUT'`,
      ));
    if (Number(active?.n ?? 0) >= MAX_ACTIVE_PER_ACCOUNT) {
      return { ok: false as const, status: 429, code: 'TOO_MANY_GENERATIONS', message: TOO_MANY_GENERATIONS_MESSAGE, extra: { limit: MAX_ACTIVE_PER_ACCOUNT } };
    }

    const [row] = await tx.insert(exportGenerations).values({
      assetId: asset.id,
      accountId: asset.accountId,
      userId,
      exportType: code,
      variant,
      status: 'queued',
      requestedOutputs: JSON.stringify(outputFormat === 'ZIP' ? ['PDF', 'ZIP'] : ['PDF']),
      manifestPayload: req.legacyOptions ? JSON.stringify(req.legacyOptions) : null,
      outputFormat,
      snapshotJson: { request: req },
      templateVersion: templateVersion(code),
      generationAttemptCount: 0,
      createdAt: new Date(),
    }).returning();

    return { ok: true as const, generation: row, warnings, reused: false };
  });
}
