/**
 * /api/admin/ai/catalog-status — lot 35B, ticket « Catalogue IA dynamique
 * Google : modèles, tarifs, Preview et alertes BO ».
 *
 * GET  : en-tête de Configuration IA — modèles Gemini nouvellement
 *        disponibles (bandeau, non acquittés) et modèles ACTIFS devenus
 *        inutilisables (anomalie, jamais remplacés automatiquement).
 *        Lot 49 (ticket 11) : REGROUPÉS par modèle (`unavailableModels`,
 *        `unavailableTitle` « 1 modèle actif indisponible — 5 usages
 *        impactés »), avec le diagnostic du dernier contrôle (message
 *        fournisseur nettoyé, date, source, statut). Aucun secret.
 *        Lot 114 (carte #771) : code HTTP et code fournisseur, accès
 *        concerné pseudonymisé, prochaine sonde ; `operationalWatch` —
 *        modèles `suspect` / `inconclusive` et incident global du
 *        fournisseur, à part des indisponibilités confirmées.
 *        Lecture seule, aucun appel fournisseur.
 * POST : `{ acknowledge: string[] }` — ferme le bandeau : acquitte EN BASE,
 *        en une action, les modèles qu'il affichait (persistant, survit à
 *        une reconnexion, vaut pour tous les administrateurs).
 *
 * Réservé aux administrateurs (`requireAdminContext`).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';
import { acknowledgeAnnouncedModels, bannerText, listAnnouncedModels } from '@/services/ai/provider/new-models.service';
import {
  anomalyMessage, detectActiveModelAnomalies, groupAnomaliesByModel, loadActiveChains, loadSecoursContext, operationalWatchOf, unavailableBannerTitle,
} from '@/services/ai/provider/active-model-anomalies';
import { loadOperationalDiagnostics, operationalProjectDimension, operationalSchemaState } from '@/services/ai/provider/model-operational.service';
import { admissionMetrics, SEND_POINTS } from '@/services/ai/provider/operational-admission';
import { OPERATIONAL_CAPABILITIES, OPERATIONAL_CAPABILITY_LABELS } from '@/services/ai/provider/probe-classification';
import { loadUsableModelsContext } from '@/services/ai/registry/usable-models';
import { getCatalogState } from '@/services/ai/provider/model-catalog.service';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const ctx = await loadUsableModelsContext();
    const [newModels, chains, state] = await Promise.all([
      listAnnouncedModels(ctx),
      loadActiveChains().catch(() => []),
      getCatalogState().catch(() => null),
    ]);
    // Lot 87A (INV-10) : secours réellement admissible pour chaque usage.
    const brutes = detectActiveModelAnomalies(chains, ctx, chains.length ? await loadSecoursContext() : undefined);
    const anomalies = brutes.map((a) => ({ ...a, message: anomalyMessage(a) }));
    const diagnostics = await loadOperationalDiagnostics().catch(() => new Map());
    const unavailableModels = groupAnomaliesByModel(brutes, diagnostics);
    return NextResponse.json({
      newModels,
      banner: bannerText(newModels),
      anomalies,
      unavailableModels,
      unavailableTitle: unavailableBannerTitle(unavailableModels),
      // #771 (B01 / B04) : états suspect / inconclusive et incident global, séparés des indisponibilités confirmées.
      operationalWatch: operationalWatchOf(diagnostics, ctx.operationalReliable !== false),
      /**
       * Lot 115 (carte #786, E08) : MESURES fidèles de l'admission des envois — envois autorisés et refusés par
       * motif et par point d'envoi, sondes autorisées, verdicts servis depuis le dernier état fiable. Aucun coût
       * ni appel fictif n'y est compté : un envoi refusé n'a jamais eu lieu. Décomptes de CETTE instance.
       */
      admission: {
        metrics: admissionMetrics(),
        sendPoints: SEND_POINTS,
        // Migration critique absente : signalée, jamais remplacée par un repli silencieux.
        schema: operationalSchemaState(),
        /**
         * Lot 115 (carte #786, E05) : PÉRIMÈTRE exact d'un verdict — les capacités (et modalités) qui ont
         * chacune leur verdict, et la dimension « projet du fournisseur », vide parce qu'INCONNUE de
         * l'application : `missing` dit précisément ce qu'il faudrait pour qu'elle existe. Rien n'est deviné,
         * rien n'est fusionné avec l'empreinte de la clé.
         */
        capabilities: OPERATIONAL_CAPABILITIES.map((c) => ({ capability: c, label: OPERATIONAL_CAPABILITY_LABELS[c] })),
        project: operationalProjectDimension(),
      },
      catalogRefreshedAt: state?.refreshedAt ?? null,
      lastSyncAt: state?.lastSyncAt ?? null,
    });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/catalog-status');
  }
}

const Body = z.object({ acknowledge: z.array(z.string().min(1).max(200)).min(1).max(200) });

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'INVALID_BODY', message: 'Liste de modèles à acquitter attendue.' }, { status: 400 });
  }
  try {
    const acknowledged = await acknowledgeAnnouncedModels(parsed.data.acknowledge, guard.ctx.adminUserId);
    return NextResponse.json({ acknowledged });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/catalog-status');
  }
}
