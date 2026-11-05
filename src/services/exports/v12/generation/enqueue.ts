/**
 * Demande de génération d'un dossier V12 (POST, §17.2) : contrôles
 * synchrones (type, éligibilité, offre, CIL-RULE-002, seuils §6.3), puis mise
 * en file (`status = queued`) — le rendu est asynchrone (worker).
 *
 * Lot 111B — trois cas distincts :
 *   · CRÉATION : première demande (ou demande sans `regenerate`) — inchangée ;
 *   · REJEU IDEMPOTENT : même demande (empreinte `requestHash`) encore active
 *     dans la fenêtre du double clic → la génération existante est renvoyée,
 *     rien n'est remplacé (y compris pour un double clic sur « Régénérer ») ;
 *   · RÉGÉNÉRATION EXPLICITE (`regenerate: true`, bouton « Régénérer ») : les
 *     générations encore actives de MÊME identité métier (`identity.ts` :
 *     compte + bien + type + contexte + utilisateur) sont remplacées
 *     atomiquement — `queued` → `cancelled` (REPLACED_BY_NEW_GENERATION),
 *     `generating` → annulation persistante observée par le worker. Les
 *     droits, l'éligibilité, les choix et les seuils sont vérifiés AVANT.
 *
 * Accepte le payload V12 (`choices` : sections / items / modes /
 * acknowledgements) et, en attendant l'écran de préparation, les options du
 * tiroir historique (`options.customDocIds`, `options.includePhotos`,
 * `requestedOutputs`) — converties avec les pré-sélections du CDC.
 */

import { createHash } from 'node:crypto';
import { db } from '@/db';
import { exportGenerations, exportGenerationLogs } from '@/db/schema';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { isCilEligible, CIL_NOT_ELIGIBLE_MESSAGE } from '@/lib/asset-capabilities';
import { canUsePremiumFeature } from '@/services/entitlements.service';
import { familyIneligibilityMessage, isDossierEligibleForFamily, type DossierCode } from '@/services/exports/catalog';
import { evaluateCilReadiness, CIL_ACTION_REQUIRED_CODE } from '@/services/exports/cil-preparation.service';
import { cilActionRequiredMessage } from '@/lib/exports/cil-blocking';
import { EXPORT_ERROR_MESSAGES } from '@/services/exports/export-errors';
import type { AccessibleAsset } from '@/services/exports/export-access';
import { loadExportSource } from '../data/source';
import { parseChoicesPayload, type LegacyDrawerOptions, type OutputFormat } from '../data/choices';
import type { ThresholdAlert } from '../thresholds';
import { estimateSelection } from '../preparation/estimate';
import { PREP_MESSAGES } from '../preparation/messages';
import { templateVersion } from '../templates';
import { effectiveChoices, type GenerationRequestSnapshot } from './job';
import { parisDate } from './clock';
import { MAX_ACTIVE_PER_ACCOUNT, type GenerationRow } from './repository';
import { generationIdentityKey, CANCELLED_STEP_QUEUED, REPLACED_BY_NEW_GENERATION } from './identity';

/** Génération remplacée par une régénération explicite. */
export interface ReplacedGeneration {
  id: number;
  publicId: string;
  /** `cancelled` : retirée de la file ; `stopping` : arrêt demandé au worker. */
  outcome: 'cancelled' | 'stopping';
}

export type EnqueueResult =
  | { ok: true; generation: GenerationRow; warnings: ThresholdAlert[]; reused: boolean; replaced: ReplacedGeneration[] }
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
export function requestHash(code: string, req: Pick<GenerationRequestSnapshot, 'outputFormat' | 'choices' | 'legacyOptions' | 'claimOperationId'>, variant: string | null): string {
  return createHash('sha256')
    .update(canonical({
      code, outputFormat: req.outputFormat, choices: req.choices ?? null, legacyOptions: req.legacyOptions ?? null, variant,
      // Lot 44 : deux sinistres différents donnent deux générations (absent : empreinte inchangée).
      ...(req.claimOperationId ? { claimOperationId: req.claimOperationId } : {}),
    }))
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

  // Modèle désactivé depuis le back-office (BO « Modèles d'export »).
  const { loadInactiveDossiers, DOSSIER_UNAVAILABLE_MESSAGE } = await import('@/services/exports/dossier-availability');
  if ((await loadInactiveDossiers()).has(code)) {
    return { ok: false, status: 409, code: 'DOSSIER_UNAVAILABLE', message: DOSSIER_UNAVAILABLE_MESSAGE };
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
      const blockingBlocks = readiness.blockingBlocks.map((b) => ({ id: b.id, label: b.label }));
      return {
        ok: false, status: 422, code: CIL_ACTION_REQUIRED_CODE, message: cilActionRequiredMessage(blockingBlocks),
        extra: { blockingBlocks },
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
  // Lot 44 (Q2) : sinistre du dossier Assurance-sinistre (choix, ou racine du corps pour les anciens appels).
  const claimRaw = req.choices?.claimOperationId ?? (body.claimOperationId == null ? null : Number(body.claimOperationId));
  if (claimRaw !== null && claimRaw !== undefined) {
    if (code !== 'ASSURANCE_SINISTRE' || !Number.isSafeInteger(claimRaw) || claimRaw <= 0) {
      return { ok: false, status: 400, code: 'INVALID_PAYLOAD', message: 'La sélection transmise est invalide.', extra: { issues: [{ path: 'claimOperationId', message: 'Sinistre invalide.' }] } };
    }
    req.claimOperationId = claimRaw;
  }

  // Seuils (§6.3) : même estimation que l'écran de préparation
  // (`preparation/estimate.ts`) ; un dossier bloqué n'est pas mis en file.
  const today = parisDate();
  const source = await loadExportSource({ assetId: asset.id, accountId: asset.accountId, userId, exportType: code, ...(req.claimOperationId ? { claimOperationId: req.claimOperationId } : {}) });
  // Le sinistre réellement retenu (le plus récent si aucun n'est demandé) est figé dans la demande.
  if (code === 'ASSURANCE_SINISTRE' && source.claim?.selectedOperationId) req.claimOperationId = source.claim.selectedOperationId;
  const { warnings, blocking, dto } = estimateSelection(code, source, effectiveChoices(code, source, req, today), today, { outputFormat });
  // ALT-002 : un « PDF seul » qui retire des pièces ZIP doit avoir été confirmé.
  if (req.choices && outputFormat === 'PDF' && dto.zipOnlyItems.length > 0 && !req.choices.acknowledgements.pdfOnlyExcludesZipItems) {
    return {
      ok: false, status: 409, code: 'PDF_ONLY_CONFIRMATION_REQUIRED', message: PREP_MESSAGES['MSG-PREP-002'],
      extra: { zipOnlyItems: dto.zipOnlyItems },
    };
  }
  if (blocking.length) {
    return { ok: false, status: 422, code: 'THRESHOLD_BLOCKED', message: EXPORT_ERROR_MESSAGES.THRESHOLD_BLOCKED, extra: { blocking, warnings } };
  }

  // Double-clic : même bien, même dossier, MÊME demande (empreinte), encore
  // en file ; puis plafond de générations actives par compte. Les deux
  // contrôles et l'insertion sont sérialisés par compte (verrou consultatif
  // transactionnel) : deux requêtes simultanées ne dépassent pas le plafond.
  const variant = typeof body.variant === 'string' ? body.variant : null;
  req.requestHash = requestHash(code, req, variant);
  // Lot 111B : identité métier (≠ requestHash) et intention explicite du client.
  const identityKey = generationIdentityKey({
    accountId: asset.accountId, assetId: asset.id, exportType: code, claimOperationId: req.claimOperationId ?? null, variant, userId,
  });
  const regenerate = body.regenerate === true;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`export-enqueue:${asset.accountId}`}))`);
    const [existing] = await tx.select().from(exportGenerations)
      .where(and(
        eq(exportGenerations.assetId, asset.id),
        inArray(exportGenerations.exportType, [code]),
        inArray(exportGenerations.status, ['queued', 'generating']),
        isNull(exportGenerations.cancelRequestedAt),
        gt(exportGenerations.createdAt, new Date(Date.now() - DEDUP_WINDOW_MS)),
        sql`${exportGenerations.snapshotJson} -> 'request' ->> 'requestHash' = ${req.requestHash}`,
      ))
      .orderBy(desc(exportGenerations.createdAt)).limit(1);
    if (existing) return { ok: true as const, generation: existing, warnings, reused: true, replaced: [] };

    // Régénération explicite : générations actives de MÊME identité, verrouillées
    // (le worker ne peut plus les prendre ni les clore pendant le remplacement).
    const targets = regenerate
      ? await tx.select({ id: exportGenerations.id, publicId: exportGenerations.publicId, status: exportGenerations.status })
        .from(exportGenerations)
        .where(and(
          eq(exportGenerations.accountId, asset.accountId),
          eq(exportGenerations.identityKey, identityKey),
          inArray(exportGenerations.status, ['queued', 'generating']),
          isNull(exportGenerations.cancelRequestedAt),
          sql`${exportGenerations.exportType} <> 'EXPORT_BRUT'`,
        ))
        .orderBy(exportGenerations.id)
        .for('update')
      : [];

    // Plafond : les générations remplacées (ou dont l'annulation est déjà demandée) ne comptent plus.
    const [active] = await tx.select({ n: sql<number>`count(*)::int` }).from(exportGenerations)
      .where(and(
        eq(exportGenerations.accountId, asset.accountId),
        inArray(exportGenerations.status, ['queued', 'generating']),
        isNull(exportGenerations.cancelRequestedAt),
        sql`${exportGenerations.exportType} <> 'EXPORT_BRUT'`,
      ));
    if (Number(active?.n ?? 0) - targets.length >= MAX_ACTIVE_PER_ACCOUNT) {
      return { ok: false as const, status: 429, code: 'TOO_MANY_GENERATIONS', message: TOO_MANY_GENERATIONS_MESSAGE, extra: { limit: MAX_ACTIVE_PER_ACCOUNT } };
    }
    if (targets.length) req.replacesGenerationIds = targets.map((t) => t.id);

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
      identityKey,
      createdAt: new Date(),
    }).returning();

    const replaced = await replaceGenerations(tx, targets, row, userId);
    return { ok: true as const, generation: row, warnings, reused: false, replaced };
  });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Remplacement atomique (même transaction que l'insertion, sous le verrou du
 * compte et le verrou de ligne pris par `FOR UPDATE`) :
 *   · `queued` → `cancelled` immédiat (retiré de la file de prélèvement) ;
 *   · `generating` → annulation PERSISTANTE (`cancel_requested_at`) : le
 *     worker l'observe pendant les étapes, interrompt rendu et transferts,
 *     nettoie ses fichiers et clôt `cancelled` ; la nouvelle génération
 *     n'est prise qu'après cet arrêt effectif (`claimNextGeneration`).
 * Historique : ancienne / nouvelle référence, utilisateur, date, étape, motif.
 */
async function replaceGenerations(tx: Tx, targets: Array<{ id: number; publicId: string; status: string }>, replacement: GenerationRow, userId: number): Promise<ReplacedGeneration[]> {
  if (!targets.length) return [];
  const now = new Date();
  const out: ReplacedGeneration[] = [];
  for (const t of targets) {
    const queued = t.status === 'queued';
    const [done] = await tx.update(exportGenerations).set({
      cancelRequestedAt: now,
      cancelRequestedByUserId: userId,
      cancelReason: REPLACED_BY_NEW_GENERATION,
      replacedByGenerationId: replacement.id,
      ...(queued ? {
        status: 'cancelled', cancelledAt: now, completedAt: now, cancelledStep: CANCELLED_STEP_QUEUED,
        lockedBy: null, lockedUntil: null, nextAttemptAt: null,
      } : {}),
    }).where(and(eq(exportGenerations.id, t.id), eq(exportGenerations.status, t.status), isNull(exportGenerations.cancelRequestedAt)))
      .returning({ id: exportGenerations.id });
    if (!done) continue;
    out.push({ id: t.id, publicId: t.publicId, outcome: queued ? 'cancelled' : 'stopping' });
    await tx.insert(exportGenerationLogs).values({
      generationId: t.id,
      level: 'info',
      step: queued ? CANCELLED_STEP_QUEUED : null,
      code: REPLACED_BY_NEW_GENERATION,
      message: queued
        ? 'Génération retirée de la file : remplacée par une nouvelle génération.'
        : 'Arrêt demandé : remplacée par une nouvelle génération.',
      detailsJson: { replacedByGenerationId: replacement.id, replacedByPublicId: replacement.publicId, requestedByUserId: userId, previousStatus: t.status },
      createdAt: now,
    });
  }
  if (out.length) {
    await tx.insert(exportGenerationLogs).values({
      generationId: replacement.id,
      level: 'info',
      step: 'validate_request',
      code: 'REPLACES_PREVIOUS_GENERATION',
      message: `Régénération : remplace ${out.length} génération(s) encore active(s).`,
      detailsJson: { replaces: out.map((r) => ({ id: r.id, publicId: r.publicId, outcome: r.outcome })), requestedByUserId: userId },
      createdAt: now,
    });
  }
  return out;
}
