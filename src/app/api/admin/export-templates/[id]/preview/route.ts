/**
 * Prévisualisation d'un modèle d'export — CDC Back-Office V1 §11.2.
 *
 * GET  ?assetId=  : biens du PROPRE compte de l'administrateur (EXP-009,
 *                   EXP-010) et, si un bien est choisi, données manquantes
 *                   (EXP-011).
 * POST { assetId } : rendu final (PDF, ou ZIP pour l'export brut) renvoyé en
 *                   pièce jointe (EXP-008, EXP-012, REC-MOD-05). Les données
 *                   manquantes sont transmises dans l'en-tête
 *                   `X-Preview-Missing` (JSON encodé URI).
 *
 * Lecture seule : aucun export n'est enregistré ni déposé (EXP-013).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, getSession, sessionErrorResponse } from '@/lib/auth-guards';
import { pgClient } from '@/db';
import { isPremiumPlan } from '@/types/domain';
import {
  analysePreview,
  assetIneligibilityReason,
  listAdminOwnAssets,
  loadPreviewTemplate,
  previewFileName,
  renderPreviewFile,
  resolvePreviewExportType,
} from '@/services/admin/export-preview.service';

async function guard(request: NextRequest): Promise<{ adminId: number; accountId?: number } | NextResponse> {
  try {
    const adminId = await requireAdmin(request);
    const session = await getSession(request);
    return { adminId, accountId: session.currentAccountId };
  } catch (error) {
    return sessionErrorResponse(error);
  }
}

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await guard(request);
  if (g instanceof NextResponse) return g;
  const templateId = parseId((await params).id);
  if (!templateId) return NextResponse.json({ code: 'INVALID_ID', message: 'Identifiant invalide.' }, { status: 400 });

  try {
    const template = await loadPreviewTemplate(templateId);
    if (!template) return NextResponse.json({ code: 'TEMPLATE_NOT_FOUND', message: 'Modèle introuvable.' }, { status: 404 });

    const exportType = resolvePreviewExportType(template);
    if (!exportType) {
      return NextResponse.json({
        supported: false,
        message: 'Ce modèle n’est utilisé par aucun type d’export du moteur actuel : prévisualisation impossible.',
        assets: [],
      });
    }

    const own = await listAdminOwnAssets(g.adminId, g.accountId);
    const assets = own.map((a) => ({
      id: a.id,
      name: a.name,
      category: a.category,
      ineligibleReason: assetIneligibilityReason(exportType, template.category, a.category),
    }));

    const assetIdRaw = new URL(request.url).searchParams.get('assetId');
    let analysis: { assetId: number; missing: string[]; documentCount: number } | null = null;
    if (assetIdRaw) {
      const assetId = parseId(assetIdRaw);
      const asset = assetId ? own.find((a) => a.id === assetId) : undefined;
      if (!asset) {
        return NextResponse.json({ code: 'ASSET_NOT_OWN', message: 'Ce bien n’appartient pas à votre compte.' }, { status: 404 });
      }
      const reason = assetIneligibilityReason(exportType, template.category, asset.category);
      if (reason) return NextResponse.json({ code: 'ASSET_INELIGIBLE', message: reason }, { status: 400 });
      const a = await analysePreview(exportType, asset);
      analysis = { assetId: asset.id, missing: a.missing, documentCount: a.manifest.includedDocuments.length };
    }

    return NextResponse.json({
      supported: true,
      exportType,
      output: exportType === 'EXPORT_BRUT' ? 'ZIP' : 'PDF',
      scope: 'asset',
      templateActive: template.isActive,
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
  const templateId = parseId((await params).id);
  if (!templateId) return NextResponse.json({ code: 'INVALID_ID', message: 'Identifiant invalide.' }, { status: 400 });
  const body = (await request.json().catch(() => null)) as { assetId?: unknown } | null;
  const assetId = typeof body?.assetId === 'number' ? parseId(String(body.assetId)) : null;
  if (!assetId) return NextResponse.json({ code: 'ASSET_REQUIRED', message: 'Choisissez un bien.' }, { status: 400 });

  try {
    const template = await loadPreviewTemplate(templateId);
    if (!template) return NextResponse.json({ code: 'TEMPLATE_NOT_FOUND', message: 'Modèle introuvable.' }, { status: 404 });
    const exportType = resolvePreviewExportType(template);
    if (!exportType) {
      return NextResponse.json({ code: 'UNSUPPORTED', message: 'Prévisualisation impossible pour ce modèle.' }, { status: 400 });
    }
    const own = await listAdminOwnAssets(g.adminId, g.accountId);
    const asset = own.find((a) => a.id === assetId);
    if (!asset) {
      // SEC-005 : jamais le bien d'un autre compte.
      return NextResponse.json({ code: 'ASSET_NOT_OWN', message: 'Ce bien n’appartient pas à votre compte.' }, { status: 404 });
    }
    const reason = assetIneligibilityReason(exportType, template.category, asset.category);
    if (reason) return NextResponse.json({ code: 'ASSET_INELIGIBLE', message: reason }, { status: 400 });

    const analysis = await analysePreview(exportType, asset);
    const [acc] = await pgClient.unsafe<{ plan_type: string | null }[]>(
      `SELECT ac.plan_type FROM assets a JOIN accounts ac ON ac.id = a.account_id WHERE a.id = $1`,
      [asset.id],
    );
    const file = await renderPreviewFile(template, analysis, isPremiumPlan(acc?.plan_type ?? ''));
    const fileName = previewFileName(template.code, exportType);

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
    return NextResponse.json(
      { code: 'RENDER_FAILED', message: 'Le rendu de la prévisualisation a échoué. Vous pouvez réessayer.' },
      { status: 500 },
    );
  }
}
