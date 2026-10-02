/**
 * Prévisualisation d'un modèle d'export (dossier V12) — `[id]` = code du dossier.
 *
 * GET  ?assetId=  : biens du PROPRE compte de l'administrateur, avec leur
 *                   éligibilité ; si un bien est choisi, données manquantes.
 * POST { assetId } : rendu final (PDF, moteur V12 : HTML/CSS + Chromium)
 *                   renvoyé pour affichage et téléchargement. Données
 *                   manquantes dans l'en-tête `X-Preview-Missing` (JSON encodé URI).
 *
 * Aucun export n'est enregistré ni déposé. Un dossier désactivé reste
 * prévisualisable (contrôle avant réactivation). Le rendu est journalisé
 * (EXPORT_TEMPLATE_PREVIEW : dossier, bien, résultat).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, getSession, sessionErrorResponse } from '@/lib/auth-guards';
import { pgClient } from '@/db';
import { isPremiumPlan } from '@/types/domain';
import { logAdminAction } from '@/lib/admin-audit';
import {
  analysePreview,
  assetIneligibilityReason,
  listAdminOwnAssets,
  previewFileName,
  renderPreviewFile,
} from '@/services/admin/export-preview.service';
import { loadInactiveDossiers } from '@/services/exports/dossier-availability';
import { toDossierParam } from '../../model';

async function guard(request: NextRequest): Promise<{ adminId: number; accountId?: number } | NextResponse> {
  try {
    const adminId = await requireAdmin(request);
    const session = await getSession(request);
    return { adminId, accountId: session.currentAccountId };
  } catch (error) {
    return sessionErrorResponse(error);
  }
}

function parseId(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const notFound = () => NextResponse.json({ code: 'TEMPLATE_NOT_FOUND', message: 'Modèle introuvable.' }, { status: 404 });

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(request);
  if (g instanceof NextResponse) return g;
  const code = toDossierParam((await params).id);
  if (!code) return notFound();

  try {
    const own = await listAdminOwnAssets(g.adminId, g.accountId);
    const assets = own.map((a) => ({
      id: a.id,
      name: a.name,
      category: a.category,
      ineligibleReason: assetIneligibilityReason(code, null, a.category, a.subtype),
    }));

    const assetIdRaw = new URL(request.url).searchParams.get('assetId');
    let analysis: { assetId: number; missing: string[]; documentCount: number } | null = null;
    if (assetIdRaw) {
      const asset = own.find((a) => a.id === parseId(assetIdRaw));
      if (!asset) return NextResponse.json({ code: 'ASSET_NOT_OWN', message: 'Ce bien n’appartient pas à votre compte.' }, { status: 404 });
      const reason = assetIneligibilityReason(code, null, asset.category, asset.subtype);
      if (reason) return NextResponse.json({ code: 'ASSET_INELIGIBLE', message: reason }, { status: 400 });
      const a = await analysePreview(code, asset);
      analysis = { assetId: asset.id, missing: a.missing, documentCount: a.manifest.includedDocuments.length };
    }

    return NextResponse.json({
      supported: true,
      exportType: code,
      output: 'PDF',
      templateActive: !(await loadInactiveDossiers()).has(code),
      assets,
      analysis,
    });
  } catch (error) {
    console.error('[admin/export-templates/preview] GET :', error);
    return NextResponse.json({ code: 'PREVIEW_FAILED', message: 'Chargement de la prévisualisation impossible.' }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(request);
  if (g instanceof NextResponse) return g;
  const code = toDossierParam((await params).id);
  if (!code) return notFound();
  const body = (await request.json().catch(() => null)) as { assetId?: unknown } | null;
  const assetId = parseId(body?.assetId);
  if (!assetId) return NextResponse.json({ code: 'ASSET_REQUIRED', message: 'Choisissez un bien.' }, { status: 400 });

  const journal = (result: 'SUCCESS' | 'FAILURE', details: Record<string, unknown>) =>
    logAdminAction({ adminId: g.adminId, action: 'EXPORT_TEMPLATE_PREVIEW', targetType: 'EXPORT_TEMPLATE', targetId: null, result, details: { code, assetId, ...details } });

  try {
    const own = await listAdminOwnAssets(g.adminId, g.accountId);
    const asset = own.find((a) => a.id === assetId);
    // Jamais le bien d'un autre compte.
    if (!asset) return NextResponse.json({ code: 'ASSET_NOT_OWN', message: 'Ce bien n’appartient pas à votre compte.' }, { status: 404 });
    const reason = assetIneligibilityReason(code, null, asset.category, asset.subtype);
    if (reason) return NextResponse.json({ code: 'ASSET_INELIGIBLE', message: reason }, { status: 400 });

    const analysis = await analysePreview(code, asset);
    const [acc] = await pgClient.unsafe<{ plan_type: string | null }[]>(
      `SELECT ac.plan_type FROM assets a JOIN accounts ac ON ac.id = a.account_id WHERE a.id = $1`,
      [asset.id],
    );
    const file = await renderPreviewFile(analysis, isPremiumPlan(acc?.plan_type ?? ''));
    const fileName = previewFileName(code, code);
    await journal('SUCCESS', { bytes: file.buffer.length, renderer: file.renderer });

    return new NextResponse(new Uint8Array(file.buffer), {
      status: 200,
      headers: {
        'Content-Type': file.contentType,
        'Content-Disposition': `inline; filename="${fileName}"`,
        'Cache-Control': 'no-store',
        'X-Preview-Filename': fileName,
        'X-Preview-Missing': encodeURIComponent(JSON.stringify(analysis.missing)),
        'X-Preview-Renderer': file.renderer,
        ...(file.fallbackReason ? { 'X-Preview-Notice': encodeURIComponent(file.fallbackReason) } : {}),
      },
    });
  } catch (error) {
    console.error('[admin/export-templates/preview] POST :', error);
    await journal('FAILURE', { error: (error as Error).message });
    return NextResponse.json(
      { code: 'RENDER_FAILED', message: 'Le rendu de la prévisualisation a échoué. Vous pouvez réessayer.' },
      { status: 500 },
    );
  }
}
