/**
 * Modèle d'export (dossier V12) — `[id]` = code du dossier (CIL, VENTE…).
 *
 * GET   : nom, description, familles, statut.
 * PATCH : `{ isActive: boolean }` — seule mutation admise. Effet immédiat (au
 *         plus 30 s sur les autres instances) : un dossier désactivé n'est plus
 *         proposé ni généré ; les exports déjà produits sont intacts.
 *         Journalisé (EXPORT_TEMPLATE_TOGGLE). La confirmation de la
 *         désactivation est demandée par l'écran.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, sessionErrorResponse } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { listDossierAvailability, setDossierAvailability } from '@/services/exports/dossier-availability';
import { toAdminExportModel, toDossierParam } from '../model';

const notFound = () => NextResponse.json({ code: 'TEMPLATE_NOT_FOUND', message: 'Modèle introuvable.' }, { status: 404 });

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }
  const code = toDossierParam((await params).id);
  if (!code) return notFound();
  try {
    const row = (await listDossierAvailability()).find((r) => r.code === code);
    return row ? NextResponse.json(toAdminExportModel(row)) : notFound();
  } catch (error) {
    console.error('GET /api/admin/export-templates/[id] :', error);
    return NextResponse.json({ code: 'EXPORT_MODEL_LOAD_FAILED', message: 'Chargement du modèle impossible.' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let adminId: number;
  try {
    adminId = await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }
  const code = toDossierParam((await params).id);
  if (!code) return notFound();

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const extraFields = body ? Object.keys(body).filter((k) => k !== 'isActive') : [];
  if (!body || typeof body.isActive !== 'boolean' || extraFields.length > 0) {
    return NextResponse.json(
      {
        code: 'READ_ONLY_FIELDS',
        message: "Seule l'activation du modèle est modifiable depuis le back-office (corps attendu : { isActive: boolean }).",
        rejectedFields: extraFields,
      },
      { status: 400 },
    );
  }
  const isActive = body.isActive;

  try {
    const { before } = await setDossierAvailability(code, isActive, adminId);
    await logAdminAction({
      adminId, action: 'EXPORT_TEMPLATE_TOGGLE', targetType: 'EXPORT_TEMPLATE', targetId: null, result: 'SUCCESS',
      before: { isActive: before }, after: { isActive }, details: { code },
    });
    return NextResponse.json({ success: true, code, isActive });
  } catch (error) {
    console.error('PATCH /api/admin/export-templates/[id] :', error);
    await logAdminAction({
      adminId, action: 'EXPORT_TEMPLATE_TOGGLE', targetType: 'EXPORT_TEMPLATE', targetId: null, result: 'FAILURE',
      after: { isActive }, details: { code, error: (error as Error).message },
    });
    return NextResponse.json({ code: 'INTERNAL_ERROR', message: 'Modification impossible. Réessayez.' }, { status: 500 });
  }
}
