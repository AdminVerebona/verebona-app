import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getSession, requireAdmin } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { EXPORT_FORMATS, entityId, exportFileName, isEntityType, type ExportFormat } from '@/services/admin/account-data/model';
import { EntityNotFoundError, buildEntityDossier, loadSectionPage, planEntityDossier } from '@/services/admin/account-data/dossier';
import { guardAdmin, NO_STORE, readError, resolveAccount } from '../../../data/_shared';

export const dynamic = 'force-dynamic';
// Lot 81C : export intégral en flux (aucun plafond de volume) ; délai par requête appliqué par PostgreSQL.
export const maxDuration = 900;

type Ctx = { params: Promise<{ id: string; type: string; entityId: string }> };

const CONTENT_TYPES: Readonly<Record<ExportFormat, string>> = {
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
};

/**
 * GET /api/admin/accounts/:id/entities/:type/:entityId — dossier d'une entité
 * du compte (lots 75N, 81C) : tiroir BO, « Copier tout » et téléchargements.
 *
 *   sans `format`         → CONSULTATION (tiroir) : dossier JSON, chaque
 *                           section tabulaire / de relations avec sa première
 *                           page et son total réel — journalisé
 *                           `ACCOUNT_DATA_READ` ;
 *   `section=<id>` (+ `offset`, `size` ≤ 200, `q`) → page d'UNE section
 *                           (navigation jusqu'à la dernière ligne, recherche
 *                           serveur sur TOUTES les lignes) ;
 *   `format=json|csv|txt` → EXPORT INTÉGRAL généré ici, en flux, depuis la
 *                           base (jamais depuis les lignes du tiroir) : une
 *                           transaction REPEATABLE READ READ ONLY, lecture par
 *                           lots, manifeste de complétude en fin de fichier
 *                           (statut COMPLETE / PARTIAL / FAILED par section),
 *                           génération suivie (`admin_export_generations`),
 *                           journalisé `ACCOUNT_DATA_EXPORT` ;
 *   `format=…&section=<id>` → la seule section (CSV : colonnes de la table ;
 *                           reprise ciblée d'une section en échec).
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
  const type = p.type;
  const sp = request.nextUrl.searchParams;
  const rawFormat = sp.get('format');
  if (rawFormat !== null && !(EXPORT_FORMATS as readonly string[]).includes(rawFormat)) {
    return NextResponse.json({ error: 'Format inconnu (json, csv, txt).', code: 'INVALID_FORMAT' }, { status: 400, headers: NO_STORE });
  }
  const format = rawFormat as ExportFormat | null;
  const sectionId = sp.get('section');
  if (sectionId !== null && !/^[a-z0-9-]{1,64}$/.test(sectionId)) {
    return NextResponse.json({ error: 'Section inconnue.', code: 'INVALID_SECTION' }, { status: 400, headers: NO_STORE });
  }
  const page = { offset: Number(sp.get('offset') ?? 0), size: Number(sp.get('size') ?? 0) || undefined, q: sp.get('q') };
  const adminEmail = await getSession(request).then((s) => (typeof s?.email === 'string' ? s.email : undefined), () => undefined);
  const audit = (accountId: number, result: 'SUCCESS' | 'FAILURE' | 'DENIED', details: Record<string, unknown>) => logAdminAction({
    adminId: g.adminId, adminEmail, action: format ? 'ACCOUNT_DATA_EXPORT' : 'ACCOUNT_DATA_READ', targetType: 'ACCOUNT', targetId: accountId, result,
    details: { entityType: type, entityId: id, format: format ?? null, section: sectionId, ...details },
  });

  let accountId = 0;
  try {
    const acc = await resolveAccount(p.id);
    if (!acc.ok) return acc.response;
    accountId = acc.accountId;
    if (!format) {
      if (sectionId) {
        const sec = await loadSectionPage(accountId, type, id, sectionId, page);
        if (!sec) return NextResponse.json({ error: 'Section inconnue.', code: 'INVALID_SECTION' }, { status: 400, headers: NO_STORE });
        await audit(accountId, 'SUCCESS', { offset: sec.window?.offset ?? 0, size: sec.window?.size ?? null, q: sec.window?.query ?? null, total: sec.window?.total ?? null });
        return NextResponse.json({ section: sec }, { headers: NO_STORE });
      }
      const dossier = await buildEntityDossier(accountId, type, id);
      await audit(accountId, 'SUCCESS', { complete: dossier.complete, extractedAt: dossier.extractedAt });
      return NextResponse.json(dossier, { headers: NO_STORE });
    }
    return await streamExport(request, { adminId: g.adminId, accountId, type, id, format, sectionId, audit });
  } catch (e) {
    if (e instanceof EntityNotFoundError) {
      if (accountId) await audit(accountId, 'DENIED', { code: 'NOT_FOUND_IN_ACCOUNT' });
      return NextResponse.json({ error: 'Entité introuvable dans ce compte.', code: 'ENTITY_NOT_FOUND' }, { status: 404, headers: NO_STORE });
    }
    if (accountId) await audit(accountId, 'FAILURE', { code: (e as { code?: string })?.code ?? 'READ_FAILED' });
    return readError(e, `dossier ${type} ${id}`);
  }
}

/**
 * Export intégral en flux. La session de lecture reste ouverte pendant la
 * transmission ; le journal et le suivi sont écrits AVANT la fin du flux
 * (un client qui a reçu le fichier entier trouve la génération terminée).
 */
async function streamExport(_request: NextRequest, a: {
  adminId: number; accountId: number; type: Parameters<typeof planEntityDossier>[2]; id: number; format: ExportFormat; sectionId: string | null;
  audit: (accountId: number, result: 'SUCCESS' | 'FAILURE' | 'DENIED', details: Record<string, unknown>) => Promise<unknown>;
}): Promise<Response> {
  const { openReadSession } = await import('@/services/admin/account-data/session');
  const { writeDossierExport, describeError } = await import('@/services/admin/account-data/export');
  const { responseStream } = await import('@/services/admin/account-data/stream-response');
  const { tryAcquireExportSlot, startGeneration, finishGeneration } = await import('@/services/admin/export-generations');
  const slot = tryAcquireExportSlot('ACCOUNT_DATA');
  if (!slot) {
    await a.audit(a.accountId, 'FAILURE', { code: 'BUSY' });
    return NextResponse.json({ error: 'Exports intégraux déjà en cours : réessayez dans un instant.', code: 'BUSY' }, { status: 429, headers: { ...NO_STORE, 'Retry-After': '30' } });
  }
  let session: Awaited<ReturnType<typeof openReadSession>> | null = null;
  try {
    session = await openReadSession();
    const plan = await planEntityDossier(session, a.accountId, a.type, a.id, { only: a.sectionId, mode: 'export' });
    if (a.sectionId && !plan.dossier.sections.some((x) => x.id === a.sectionId)) {
      await session.close();
      slot.release();
      return NextResponse.json({ error: 'Section inconnue.', code: 'INVALID_SECTION' }, { status: 400, headers: NO_STORE });
    }
    const generationId = randomUUID();
    const fileName = exportFileName(plan.dossier, a.format, a.sectionId);
    await startGeneration({
      id: generationId, kind: 'ACCOUNT_DATA', mode: a.format, adminUserId: a.adminId, targetType: `ENTITY_${a.type.toUpperCase()}`, targetId: a.id,
      targetAccountId: a.accountId, perimeter: { accountId: a.accountId, entityType: a.type, entityId: a.id, section: a.sectionId, format: a.format },
    });
    const out = responseStream();
    const s = session;
    void (async () => {
      try {
        const m = await writeDossierExport(s, plan, a.format, out.sink, { generationId, sectionId: a.sectionId });
        await finishGeneration(generationId, {
          status: m.status, snapshotAt: m.snapshot.at, pgSnapshot: m.snapshot.snapshot, rowsExpected: m.totals.expected, rowsExported: m.totals.exported,
          batches: m.totals.batches, bytes: out.sink.bytes(), files: 1, sections: m.sections, error: m.error, fileName,
        });
        await a.audit(a.accountId, 'SUCCESS', { generationId, fileName, status: m.status, complete: m.status === 'COMPLETE', rowsExpected: m.totals.expected, rowsExported: m.totals.exported, bytes: out.sink.bytes(), extractedAt: plan.dossier.extractedAt, snapshotAt: m.snapshot.at });
        // CSV d'une section : aucun statut dans le fichier — un échec de lecture interrompt le flux (jamais un CSV « complet » tronqué).
        if (a.format === 'csv' && a.sectionId && m.status !== 'COMPLETE') out.abort(new Error(`section ${a.sectionId} : ${m.status}`));
        else out.end();
      } catch (e) {
        console.error('[admin/account-data] export interrompu :', (e as Error)?.message ?? e);
        await finishGeneration(generationId, { status: 'FAILED', bytes: out.sink.bytes(), error: describeError(e), fileName });
        await a.audit(a.accountId, 'FAILURE', { generationId, fileName, code: (e as { code?: string })?.code ?? (e as Error)?.name ?? 'EXPORT_FAILED' });
        out.abort(e);
      } finally {
        await s.close();
        slot.release();
      }
    })();
    return new Response(out.body, {
      status: 200,
      headers: {
        ...NO_STORE,
        'Content-Type': CONTENT_TYPES[a.format],
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'X-Content-Type-Options': 'nosniff',
        'X-Verebona-Export-Id': generationId,
        'X-Verebona-Export-Snapshot': plan.dossier.snapshot?.at ?? '',
      },
    });
  } catch (e) {
    if (session) await session.close();
    slot.release();
    throw e;
  }
}
