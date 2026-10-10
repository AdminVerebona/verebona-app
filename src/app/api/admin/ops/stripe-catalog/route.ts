import { NextRequest, NextResponse } from 'next/server';
import { getSession, requireAdmin } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { guardAdmin, NO_STORE, opsError } from '../_shared';

export const dynamic = 'force-dynamic';

/**
 * Catalogue Stripe (page BO « Exploitation », lot 35C — CDC lookup_key V4).
 *
 *   GET  : diagnostic complet (lecture seule, LK-64).
 *   POST : { action, reason?, ... } — opérations d'exploitation qui
 *          REMPLACENT les commandes du CDC (`inspect`, `backfill`, `sync`,
 *          `publish`, `rollback`) : l'exploitant ne lance aucune commande.
 *
 * Aucune action ne saisit ni ne modifie un montant (EX-039) : la grille
 * publiée est TOUJOURS celle du référentiel du code. Les actions qui
 * écrivent chez Stripe exigent un motif et sont journalisées dans l'audit
 * admin (auteur, action, motif, résultat).
 */
export async function GET(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  try {
    const { getCatalogDiagnostic } = await import('@/services/billing/catalog-diagnostic.service');
    return NextResponse.json(await getCatalogDiagnostic(), { headers: NO_STORE });
  } catch (e) {
    return opsError(e, 'catalogue Stripe (diagnostic)', 'OPS_STRIPE_CATALOG_READ_FAILED');
  }
}

const READ_ONLY = new Set(['sync', 'publish-simulate', 'revaluation-simulate']);
const ACTIONS = new Set(['sync', 'backfill', 'publish-simulate', 'publish', 'resume', 'abandon', 'rollback', 'portal-sync', 'revaluation-simulate', 'revaluation-notify', 'revaluation-run']);

export async function POST(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const action = typeof body?.action === 'string' ? body.action : '';
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (!ACTIONS.has(action)) {
    return NextResponse.json({ error: 'Demande invalide', code: 'INVALID_ACTION' }, { status: 400, headers: NO_STORE });
  }
  if (!READ_ONLY.has(action) && reason.length < 5) {
    return NextResponse.json({ error: 'Motif obligatoire', code: 'REASON_REQUIRED', message: 'Indiquez le motif de cette opération (5 caractères minimum).' }, { status: 400, headers: NO_STORE });
  }
  const email = await getSession(request).then((s) => (s as { email?: string } | null)?.email, () => undefined);
  const actor = `admin:${g.adminId}`;
  try {
    const result = await run(action, body ?? {}, actor);
    if (!READ_ONLY.has(action)) {
      await logAdminAction({
        adminId: g.adminId, adminEmail: email, action: 'STRIPE_CATALOG_OPERATION', targetType: 'STRIPE_CATALOG', targetId: null,
        result: isFailure(result) ? 'FAILURE' : 'SUCCESS', details: { action, reason, result: summarize(result) },
      }).catch(() => undefined);
    }
    return NextResponse.json({ action, result }, { headers: NO_STORE });
  } catch (e) {
    if (!READ_ONLY.has(action)) {
      await logAdminAction({
        adminId: g.adminId, adminEmail: email, action: 'STRIPE_CATALOG_OPERATION', targetType: 'STRIPE_CATALOG', targetId: null,
        result: 'FAILURE', details: { action, reason, error: (e as Error).message?.slice(0, 300) },
      }).catch(() => undefined);
    }
    return opsError(e, `catalogue Stripe (${action})`, 'OPS_STRIPE_CATALOG_ACTION_FAILED');
  }
}

async function run(action: string, body: Record<string, unknown>, actor: string): Promise<unknown> {
  switch (action) {
    case 'sync': {
      const { refreshCatalog } = await import('@/services/billing/price-catalog.service');
      return refreshCatalog({ source: 'bo' });
    }
    case 'backfill': {
      const { runPriceBackfill } = await import('@/services/billing/price-backfill.service');
      return runPriceBackfill({ trigger: 'bo', actor, deadline: Date.now() + 4 * 60_000 });
    }
    case 'publish-simulate':
    case 'publish':
    case 'resume': {
      const { publishCodeCatalog } = await import('@/services/billing/catalog-publication.service');
      return publishCodeCatalog({ trigger: action === 'resume' ? 'resume' : 'manual', actor, dryRun: action === 'publish-simulate' });
    }
    case 'abandon': {
      const { abandonPublication } = await import('@/services/billing/catalog-publication.service');
      return abandonPublication({ actor });
    }
    case 'rollback': {
      const { rollbackCatalog } = await import('@/services/billing/catalog-publication.service');
      return rollbackCatalog({ actor, reason: String(body.reason ?? '') });
    }
    case 'portal-sync': {
      const { syncUpgradePortal } = await import('@/services/billing/portal-configuration.service');
      return syncUpgradePortal({ reason: 'bo', force: true });
    }
    case 'revaluation-simulate': {
      const { listCampaign } = await import('@/services/billing/price-revaluation.service');
      return listCampaign(typeof body.revisionId === 'string' ? body.revisionId : null, 1000);
    }
    case 'revaluation-notify': {
      const { recordCampaignNotification } = await import('@/services/billing/price-revaluation.service');
      if (body.legalValidated !== true) throw new Error('Validation juridique du texte non confirmée');
      return recordCampaignNotification({
        revisionId: String(body.revisionId ?? ''),
        channel: body.channel === 'external' ? 'external' : 'email',
        legalReference: String(body.legalReference ?? ''),
        externalReference: typeof body.externalReference === 'string' ? body.externalReference : null,
        actor,
      });
    }
    case 'revaluation-run': {
      const { runRevaluationTick } = await import('@/services/billing/price-revaluation.service');
      return runRevaluationTick({ deadline: Date.now() + 4 * 60_000 });
    }
    default:
      throw new Error('Action inconnue');
  }
}

function isFailure(result: unknown): boolean {
  const s = (result as { status?: string } | null)?.status;
  return s === 'failed' || s === 'refused';
}

function summarize(result: unknown): Record<string, unknown> {
  const r = result as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return {};
  const { rows: _rows, plan: _plan, ...rest } = r as Record<string, unknown> & { rows?: unknown; plan?: unknown };
  void _rows; void _plan;
  const json = JSON.stringify(rest);
  return json.length <= 2000 ? (JSON.parse(json) as Record<string, unknown>) : { truncated: json.slice(0, 2000) };
}
