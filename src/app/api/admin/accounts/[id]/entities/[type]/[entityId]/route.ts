import { NextRequest, NextResponse } from 'next/server';
import { getSession, requireAdmin } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import {
  EXPORT_FORMATS, dossierToCsv, dossierToJson, dossierToText, entityId, exportFileName, isEntityType, sectionToCsv,
  type EntityDossier, type ExportFormat,
} from '@/services/admin/account-data/model';
import { EntityNotFoundError, buildEntityDossier } from '@/services/admin/account-data/dossier';
import { guardAdmin, NO_STORE, readError, resolveAccount } from '../../../data/_shared';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string; type: string; entityId: string }> };

const CONTENT_TYPES: Readonly<Record<ExportFormat, string>> = {
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
};

/**
 * GET /api/admin/accounts/:id/entities/:type/:entityId — dossier d'une entité
 * du compte (lot 75N) : tiroir BO, « Copier tout » et téléchargements.
 *
 *   sans `format`        → dossier JSON (tiroir) — consultation journalisée
 *                          (`ACCOUNT_DATA_READ`) ;
 *   `format=json|csv|txt` → fichier COMPLET généré ici, depuis le même
 *                          dossier (`Content-Disposition: attachment`,
 *                          nom `verebona-compte-<id>-<type>-<id>-<date>.<ext>`),
 *                          journalisé (`ACCOUNT_DATA_EXPORT`) ;
 *   `section=<id>` (CSV) → la seule section tabulaire demandée.
 *
 * Sécurité : administrateur seulement ; l'entité est relue PAR LE COMPTE (une
 * entité d'un autre compte répond 404, tentative journalisée) ; masquage
 * (secrets, clés et URL de stockage, nom et contenu intégral du fichier
 * original) appliqué AVANT toute sortie ; aucune écriture métier.
 */
export async function GET(request: NextRequest, { params }: Ctx) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  const p = await params;
  const id = entityId(p.entityId);
  if (!isEntityType(p.type) || !id) {
    return NextResponse.json({ error: 'Entité invalide.', code: 'INVALID_ENTITY' }, { status: 400, headers: NO_STORE });
  }
  const sp = request.nextUrl.searchParams;
  const rawFormat = sp.get('format');
  if (rawFormat !== null && !(EXPORT_FORMATS as readonly string[]).includes(rawFormat)) {
    return NextResponse.json({ error: 'Format inconnu (json, csv, txt).', code: 'INVALID_FORMAT' }, { status: 400, headers: NO_STORE });
  }
  const format = rawFormat as ExportFormat | null;
  const sectionId = sp.get('section');
  const adminEmail = await getSession(request).then((s) => (typeof s?.email === 'string' ? s.email : undefined), () => undefined);
  const audit = (accountId: number, result: 'SUCCESS' | 'FAILURE' | 'DENIED', details: Record<string, unknown>) => logAdminAction({
    adminId: g.adminId, adminEmail, action: format ? 'ACCOUNT_DATA_EXPORT' : 'ACCOUNT_DATA_READ', targetType: 'ACCOUNT', targetId: accountId, result,
    details: { entityType: p.type, entityId: id, format: format ?? null, section: sectionId, ...details },
  });

  let accountId = 0;
  try {
    const acc = await resolveAccount(p.id);
    if (!acc.ok) return acc.response;
    accountId = acc.accountId;
    const dossier = await buildEntityDossier(accountId, p.type, id);
    if (!format) {
      await audit(accountId, 'SUCCESS', { complete: dossier.complete, extractedAt: dossier.extractedAt });
      return NextResponse.json(dossier, { headers: NO_STORE });
    }
    const out = render(dossier, format, sectionId);
    if (!out) {
      return NextResponse.json({ error: 'Section inconnue ou non tabulaire.', code: 'INVALID_SECTION' }, { status: 400, headers: NO_STORE });
    }
    const fileName = exportFileName(dossier, format, format === 'csv' ? sectionId : null);
    await audit(accountId, 'SUCCESS', { fileName, complete: dossier.complete, warnings: dossier.warnings.length, bytes: Buffer.byteLength(out), extractedAt: dossier.extractedAt });
    return new NextResponse(out, {
      status: 200,
      headers: {
        ...NO_STORE,
        'Content-Type': CONTENT_TYPES[format],
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'X-Content-Type-Options': 'nosniff',
        'X-Verebona-Export-Complete': dossier.complete ? 'true' : 'false',
      },
    });
  } catch (e) {
    if (e instanceof EntityNotFoundError) {
      if (accountId) await audit(accountId, 'DENIED', { code: 'NOT_FOUND_IN_ACCOUNT' });
      return NextResponse.json({ error: 'Entité introuvable dans ce compte.', code: 'ENTITY_NOT_FOUND' }, { status: 404, headers: NO_STORE });
    }
    if (accountId) await audit(accountId, 'FAILURE', { code: (e as { code?: string })?.code ?? 'READ_FAILED' });
    return readError(e, `dossier ${p.type} ${id}`);
  }
}

function render(d: EntityDossier, format: ExportFormat, sectionId: string | null): string | null {
  if (format === 'json') return dossierToJson(d);
  if (format === 'txt') return dossierToText(d);
  if (!sectionId) return dossierToCsv(d);
  const s = d.sections.find((x) => x.id === sectionId);
  return s ? sectionToCsv(s) : null;
}
