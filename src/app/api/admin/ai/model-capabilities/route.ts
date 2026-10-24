/**
 * GET /api/admin/ai/model-capabilities — lot 85C (CDC Pilotage IA V2 P4 :
 * CAT-03, CFG-01..03, BO-06 ; décisions PO 12 et 15).
 *
 * Lecture seule, dans Configuration IA (écran existant, aucun nouvel écran) :
 *   · fiches de capacités de chaque modèle connu (catalogue + références
 *     documentées) — paramètres acceptés, raisonnement, défauts, limites,
 *     modalités, SOURCE et DATE de chaque champ ; « requalification
 *     nécessaire » marquée sur événement ; derniers changements constatés ;
 *   · profils de température par famille (décision 09, code) ;
 *   · `?versionId=N` : PROFILS EFFECTIFS de cette version, par traitement,
 *     opération et rang — construits par le constructeur de requête UNIQUE
 *     de l'exécution (demandé / hérité / adapté / envoyé, refus avant appel).
 * Droits : administrateurs existants (`requireAdminContext`), aucun rôle
 * nouveau (décision 15). Aucun appel fournisseur.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';
import { listModelCapabilities, ensureModelCapabilitiesLoaded } from '@/services/ai/provider/model-capabilities.repository';
import {
  CAPABILITY_REFERENCES_VERSION, TEMPERATURE_PROFILE_BY_FAMILY, thinkingLabel,
} from '@/services/ai/provider/model-capabilities';
import { treatmentRequestPlan } from '@/services/ai/config/profile-check';
import { AI_OPERATIONS } from '@/services/ai/registry/operations';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    await ensureModelCapabilitiesLoaded();
    const { rows, changes } = await listModelCapabilities();
    const capabilities = rows.map((r) => ({
      ...r,
      thinkingLabel: thinkingLabel(r.capabilities.thinking),
      // Décision PO 02 : un Preview reste visible, pour information seulement.
      informationOnly: r.lifecycle === 'preview',
    }));

    let plans: Record<string, unknown[]> | null = null;
    const raw = req.nextUrl.searchParams.get('versionId');
    if (raw) {
      const versionId = Number(raw);
      if (!Number.isInteger(versionId) || versionId <= 0) {
        return NextResponse.json({ error: 'versionId invalide' }, { status: 400 });
      }
      const { getVersion } = await import('@/services/ai/config/config-version.repository');
      const version = await getVersion(versionId);
      if (!version) return NextResponse.json({ error: 'Version introuvable' }, { status: 404 });
      plans = {};
      for (const e of version.entries) {
        plans[e.treatment] = treatmentRequestPlan(e).map((p) => ({
          operationCode: p.operationCode, label: AI_OPERATIONS[p.operationCode]?.label ?? p.operationCode,
          rank: p.rank, slot: p.slot, model: p.model,
          reasoning: { requested: p.profile.reasoning, origin: p.profile.reasoningOrigin, sent: p.result.trace.reasoning.sent },
          maxOutputTokens: p.result.trace.maxOutputTokens,
          timeoutMs: p.profile.timeoutMs, timeoutOrigin: p.profile.timeoutOrigin,
          temperature: p.result.trace.temperature,
          adaptations: p.result.trace.adaptations,
          refusal: p.result.ok ? null : p.result.refusal,
        }));
      }
    }

    return NextResponse.json({
      readAt: new Date().toISOString(),
      referencesVersion: CAPABILITY_REFERENCES_VERSION,
      temperatureProfiles: TEMPERATURE_PROFILE_BY_FAMILY,
      capabilities,
      changes,
      plans,
    });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/model-capabilities');
  }
}
