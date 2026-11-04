/**
 * /api/admin/ai/provider/pricing — lot 109L (ticket P1 « Tarifs Gemini non
 * reconnus », points A, B et E) : état TARIFAIRE, distinct du catalogue modèles.
 *
 * GET  : dernière synchronisation tarifaire (date, source, URL finale, statut
 *        HTTP, type de contenu, taille, EMPREINTE et FORMAT de la page lue,
 *        extrait, code d'échec), couverture (connus / non confirmés /
 *        inconnus), par modèle : statut de la page, motif, tarif APPLIQUÉ
 *        (source, priorité, vérification, ligne, date) et écart éventuel avec la
 *        page, retrait vérifiable ; historique des changements ; saisies
 *        manuelles ; état du cache de l'instance.
 * POST : `{ action: 'sync' }` — synchronisation tarifaire seule ;
 *        `{ action: 'manual', … }` — saisie / validation d'un tarif DOCUMENTÉ
 *        (URL https Google, date du document, palier Standard payant, modalité
 *        texte/image/PDF vérifiés, note) : jamais un montant non sourcé ;
 *        `{ action: 'confirm_retirement', model, note }` — retrait vérifié.
 * Historisé (`ai_model_price_changes`, journal d'administration).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pgClient } from '@/db';
import { logAdminAction } from '@/lib/admin-audit';
import { getCachedPrice, getCacheState, loadPricingCache, sourceRank, upsertPrice } from '@/services/ai/gateway/pricing/pricing.repository';
import {
  confirmModelRetirement, loadPriceStatuses, modelsActuallyUsed, RETIREMENT_MIN_ABSENT_READS,
} from '@/services/ai/gateway/pricing/pricing-sync.service';
import { GOOGLE_PRICING_PAGE_URL, GOOGLE_PRICING_REDIRECT_URL, GOOGLE_PRICING_SOURCE_URL } from '@/services/ai/gateway/pricing/google-pricing-page.adapter';
import { requireAdminContext, toErrorResponse } from '../../config-versions/_shared';

type Row = Record<string, unknown>;
const rows = async (t: string, p: unknown[] = []) => ((await pgClient.unsafe(t, p as never[]).catch(() => [])) as unknown as Row[]) ?? [];
const SOURCE_LABELS: Record<string, string> = {
  manual: 'Saisie manuelle', public_catalog: 'Page officielle Google', billing_api: 'Grille du compte (Cloud Billing)',
};

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    if (getCacheState().loadedAt === null) await loadPricingCache();
    const [statuts, logs, history, manual, used] = await Promise.all([
      loadPriceStatuses(),
      rows(`SELECT * FROM ai_model_pricing_refresh_log ORDER BY id DESC LIMIT 10`),
      rows(`SELECT id, model, old_status, new_status, old_input, old_output, new_input, new_output, reason, reason_code, source, page_fingerprint,
                   actor_user_id, evidence, detected_at
              FROM ai_model_price_changes WHERE provider = 'gemini' ORDER BY id DESC LIMIT 60`),
      rows(`SELECT id, model, input_micros, output_micros, currency, verified, verified_by, effective_from, created_at, invalidated_at, evidence
              FROM ai_model_pricing WHERE provider = 'gemini' AND source = 'manual' ORDER BY id DESC LIMIT 30`),
      modelsActuallyUsed(30).catch(() => new Set<string>()),
    ]);
    let wanted: string[] = [];
    try {
      const { modelsToPrice } = await import('@/services/ai/gateway/pricing/refresh-pricing.job');
      wanted = await modelsToPrice();
    } catch { wanted = []; }
    const noms = [...new Set([...wanted, ...statuts.keys()])].sort();
    const models = noms.map((model) => {
      const st = statuts.get(model);
      const applied = getCachedPrice('gemini', model);
      const pageAmounts = st && st.inputPerMillion != null ? { input: st.inputPerMillion, output: st.outputPerMillion } : null;
      const conflict = Boolean(applied && pageAmounts && applied.source !== 'public_catalog'
        && (applied.inputMicros !== pageAmounts.input || applied.outputMicros !== pageAmounts.output));
      return {
        model,
        used: used.has(model),
        pageStatus: st?.status ?? 'NOT_EVALUATED',
        reason: st?.reason ?? null,
        reasonCode: st?.reasonCode ?? null,
        pageAmounts,
        thinkingIncluded: st?.thinkingIncluded ?? null,
        confirmedAt: st?.confirmedAt ?? null,
        staleSince: st?.staleSince ?? null,
        absentReads: st?.absentReads ?? 0,
        canConfirmRetirement: st?.status === 'STALE' && st.reasonCode === 'ABSENT' && (st.absentReads ?? 0) >= RETIREMENT_MIN_ABSENT_READS,
        applied: applied ? {
          source: applied.source, sourceLabel: SOURCE_LABELS[applied.source] ?? applied.source, verified: applied.verified,
          priority: sourceRank(applied.source, applied.verified), inputPerMillion: applied.inputMicros, outputPerMillion: applied.outputMicros,
          rowId: applied.id ?? null, effectiveFrom: applied.effectiveFrom?.toISOString() ?? null, stale: Boolean(applied.stale), reference: applied.sourceReference ?? null,
        } : null,
        conflict,
      };
    });
    const last = logs[0] ?? null;
    const lastOk = logs.find((l) => l.status === 'completed' || l.status === 'partial') ?? null;
    return NextResponse.json({
      source: { page: GOOGLE_PRICING_PAGE_URL, redirect: GOOGLE_PRICING_REDIRECT_URL, read: GOOGLE_PRICING_SOURCE_URL },
      lastSync: last, lastSuccessfulSync: lastOk, recentSyncs: logs.map((l) => ({ id: l.id, startedAt: l.started_at, status: l.status, failureCode: l.failure_code ?? null, format: l.page_format ?? null, fingerprint: l.page_fingerprint ?? null })),
      coverage: {
        known: models.filter((m) => m.pageStatus === 'KNOWN').length,
        stale: models.filter((m) => m.pageStatus === 'STALE').length,
        unknown: models.filter((m) => m.pageStatus === 'UNKNOWN' || m.pageStatus === 'NOT_EVALUATED').length,
        usedWithoutPrice: models.filter((m) => m.used && !m.applied).map((m) => m.model),
        usedWithStalePrice: models.filter((m) => m.used && m.applied?.stale).map((m) => m.model),
      },
      models, history, manual,
      priorityRule: 'Saisie manuelle vérifiée > grille du compte vérifiée (désactivée par défaut) > page officielle synchronisée > saisie non vérifiée.',
      cache: { ...getCacheState(), loadedAt: getCacheState().loadedAt?.toISOString() ?? null },
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/provider/pricing');
  }
}

const GOOGLE_HOST = /^([a-z0-9-]+\.)*(google\.com|google\.dev)$/i;
const Manual = z.object({
  action: z.literal('manual'),
  model: z.string().trim().regex(/^[a-z0-9][a-z0-9.\-]{2,80}$/),
  inputPerMillion: z.number().finite().min(0).max(1000),
  outputPerMillion: z.number().finite().min(0).max(1000),
  currency: z.literal('USD'),
  sourceUrl: z.string().url().max(500),
  documentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  validityEvidence: z.string().trim().max(500).optional(),
  paidTier: z.literal(true),
  tier: z.literal('standard'),
  modality: z.literal('text_image_pdf'),
  thinkingIncluded: z.boolean(),
  note: z.string().trim().min(10).max(500),
});
const Body = z.discriminatedUnion('action', [
  Manual,
  z.object({ action: z.literal('confirm_retirement'), model: z.string().trim().min(3).max(80), note: z.string().trim().min(10).max(300) }),
  z.object({ action: z.literal('sync') }),
]);

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'INVALID_BODY', message: 'Saisie incomplète : montants, source officielle (https), date, palier Standard payant, modalité et note sont obligatoires.', issues: parsed.error.issues.slice(0, 5) }, { status: 400 });
  }
  const b = parsed.data;
  const adminId = guard.ctx.adminUserId;
  try {
    if (b.action === 'sync') {
      const { refreshModelPricing } = await import('@/services/ai/gateway/pricing/refresh-pricing.job');
      const r = await refreshModelPricing({ trigger: 'manual' });
      return NextResponse.json({ pricing: r }, { status: r.status === 'failed' ? 502 : 200 });
    }
    if (b.action === 'confirm_retirement') {
      const r = await confirmModelRetirement(b.model, adminId, b.note);
      await logAdminAction({ adminId, action: 'AI_PRICING_UPDATE', targetType: 'AI_PRICING', targetId: null, result: r.ok ? 'SUCCESS' : 'FAILURE',
        details: { kind: 'confirm_retirement', model: b.model, note: b.note, ...(r.ok ? { invalidated: r.invalidated } : { code: r.code }) } });
      return NextResponse.json(r, { status: r.ok ? 200 : 409 });
    }
    // Saisie manuelle sourcée.
    const url = new URL(b.sourceUrl);
    if (url.protocol !== 'https:' || !GOOGLE_HOST.test(url.hostname)) {
      return NextResponse.json({ error: 'SOURCE_NOT_OFFICIAL', message: 'La source doit être une page ou un document officiel Google (https, google.com / google.dev).' }, { status: 400 });
    }
    const today = new Date().toISOString().slice(0, 10);
    if (b.documentDate > today || (b.effectiveFrom && b.effectiveFrom > today)) {
      return NextResponse.json({ error: 'FUTURE_DATE', message: 'Date du document ou de validité dans le futur.' }, { status: 400 });
    }
    if (b.effectiveFrom && b.effectiveFrom < b.documentDate && (b.validityEvidence ?? '').length < 10) {
      return NextResponse.json({ error: 'BACKDATING_NOT_DOCUMENTED', message: 'Une validité antérieure à la date du document exige la preuve de cette validité (citation, archive).' }, { status: 400 });
    }
    const before = getCachedPrice('gemini', b.model);
    const evidence = {
      sourceUrl: b.sourceUrl, documentDate: b.documentDate, note: b.note, operatorUserId: adminId, paidTier: true as const, tier: 'standard' as const,
      modality: 'text_image_pdf' as const, thinkingIncluded: b.thinkingIncluded, ...(b.validityEvidence ? { validityEvidence: b.validityEvidence } : {}),
    };
    const id = await upsertPrice({
      provider: 'gemini', model: b.model, inputMicros: b.inputPerMillion, outputMicros: b.outputPerMillion, currency: 'USD',
      sourceReference: `manual:${b.documentDate}:${url.hostname}`,
    }, 'manual', true, adminId, { effectiveFrom: b.effectiveFrom ? new Date(`${b.effectiveFrom}T00:00:00Z`) : undefined, evidence });
    await pgClient.unsafe(
      `INSERT INTO ai_model_price_changes (provider, model, old_status, new_status, old_input, old_output, new_input, new_output, currency, source, reason, detected_at, actor_user_id, evidence)
       VALUES ('gemini', $1, $2, 'KNOWN', $3, $4, $5, $6, 'USD', 'manual', $7, NOW(), $8, $9::jsonb)`,
      [b.model, before ? 'KNOWN' : null, before?.inputMicros ?? null, before?.outputMicros ?? null, b.inputPerMillion, b.outputPerMillion,
        `saisie manuelle vérifiée : ${b.note}`.slice(0, 500), adminId, JSON.stringify(evidence)] as never[],
    );
    await loadPricingCache();
    await logAdminAction({ adminId, action: 'AI_PRICING_UPDATE', targetType: 'AI_PRICING', targetId: id, result: 'SUCCESS',
      before: before ? { inputPerMillion: before.inputMicros, outputPerMillion: before.outputMicros, source: before.source } : null,
      after: { model: b.model, inputPerMillion: b.inputPerMillion, outputPerMillion: b.outputPerMillion, effectiveFrom: b.effectiveFrom ?? today },
      details: { kind: 'manual', evidence } });
    return NextResponse.json({ ok: true, id, applied: getCachedPrice('gemini', b.model) });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/provider/pricing');
  }
}
