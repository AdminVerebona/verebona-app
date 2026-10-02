/**
 * GET /api/admin/export-templates — modèles d'export du back-office.
 *
 * Les six dossiers prêts à l'emploi V12 (nom, description, familles, statut
 * actif / inactif). Lecture seule : l'activation passe par `[id]` PATCH.
 * L'ancienne table `export_templates` (modèles PDFMonkey) n'est plus lue
 * (MIG-06, BO « Modèles d'export » du 2 oct. 2026).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, sessionErrorResponse } from '@/lib/auth-guards';
import { listDossierAvailability } from '@/services/exports/dossier-availability';
import { toAdminExportModel } from './model';

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }
  try {
    const rows = await listDossierAvailability();
    return NextResponse.json({ data: rows.map(toAdminExportModel) });
  } catch (error) {
    console.error('GET /api/admin/export-templates :', error);
    return NextResponse.json({ code: 'EXPORT_MODELS_LOAD_FAILED', message: 'Chargement des modèles impossible.' }, { status: 500 });
  }
}
