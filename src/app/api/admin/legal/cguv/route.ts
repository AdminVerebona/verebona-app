/**
 * BO › CGUV — référentiel des versions (lot 102B).
 *
 *   GET  : versions (code, statut, origine, permalien, empreinte, substantielle
 *          oui / non, acceptations), dernier état du manifeste public.
 *   POST : { action: 'sync' } — « Relire le manifeste » (même fonction que la
 *          tâche planifiée `legal-cguv-manifest-sync`) ;
 *          { action: 'manual', code, permalink, sha256, publishedAt,
 *            effectiveAt?, requiresReacceptance, changeSummary?, makeCurrent?,
 *            textUrl? }
 *          — saisie de secours (mêmes règles que le manifeste, dont la
 *          vérification des octets du texte figé — lot 104A), jamais une
 *          modification : une version enregistrée est immuable.
 *   Lot 111O : GET porte aussi `publication` (carte BO › Exploitation › Santé ›
 *   « CGUV publiées » : URL du manifeste réellement lue et son origine, dernière
 *   lecture — statut HTTP, motif stable, versions —, version attendue / en
 *   vigueur, empreinte vérifiée, âge des caches, diagnostic) ; POST
 *   { action: 'resync' } = « Relire maintenant » : invalidation des caches
 *   juridiques + même relecture que 'sync', rapport à jour en retour.
 * Aucune édition de texte : le site public publie le texte officiel.
 * Chaque action est tracée dans le journal juridique (`legal_audit_log`).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { ensureMigrations } from '@/db';
import { guardAdmin, NO_STORE, opsError } from '../../ops/_shared';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  try {
    await ensureMigrations();
    const svc = await import('@/services/legal/cguv-referential.service');
    const { getCguvPublicationReport } = await import('@/services/legal/cguv-publication-diagnostic');
    const [versions, state, resolved, publication] = await Promise.all([
      svc.listCguvReferential(), svc.getManifestSyncState(), svc.getServerLegalLinks(), getCguvPublicationReport(),
    ]);
    return NextResponse.json({
      versions,
      state,
      manifestUrl: svc.configuredManifestUrl(),
      publicUrl: resolved.links.cguv,
      linksMode: resolved.mode,
      links: resolved.links,
      publication,
    }, { headers: NO_STORE });
  } catch (e) {
    return opsError(e, 'référentiel CGUV (lecture)', 'LEGAL_REFERENTIAL_READ_FAILED');
  }
}

export async function POST(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const action = typeof body?.action === 'string' ? body.action : '';
  try {
    await ensureMigrations();
    const svc = await import('@/services/legal/cguv-referential.service');
    if (action === 'sync') {
      // Lot 111O : caches juridiques de l'instance invalidés avant et après la relecture.
      await svc.invalidateLegalCaches();
      const result = await svc.syncCguvManifest({ trigger: 'bo', actorUserId: g.adminId });
      await svc.invalidateLegalCaches();
      return NextResponse.json({ action, result }, { headers: NO_STORE });
    }
    if (action === 'resync') {
      const { resyncCguvNow } = await import('@/services/legal/cguv-publication-diagnostic');
      const publication = await resyncCguvNow(g.adminId);
      return NextResponse.json({ action, publication }, { headers: NO_STORE });
    }
    if (action === 'manual') {
      try {
        const version = await svc.recordManualCguvVersion({
          code: body?.code, permalink: body?.permalink, textUrl: body?.textUrl, sha256: body?.sha256, publishedAt: body?.publishedAt,
          effectiveAt: body?.effectiveAt, requiresReacceptance: body?.requiresReacceptance,
          changeSummary: body?.changeSummary, makeCurrent: body?.makeCurrent,
        }, g.adminId);
        return NextResponse.json({ action, version }, { headers: NO_STORE });
      } catch (e) {
        if (e instanceof svc.ReferentialInputError) {
          return NextResponse.json({ code: e.code, message: e.message }, { status: e.code === 'VERSION_CODE_TAKEN' ? 409 : e.code === 'TEXT_NOT_VERIFIED' ? 422 : 400, headers: NO_STORE });
        }
        throw e;
      }
    }
    return NextResponse.json({ code: 'INVALID_ACTION', message: 'Action inconnue.' }, { status: 400, headers: NO_STORE });
  } catch (e) {
    return opsError(e, `référentiel CGUV (${action})`, 'LEGAL_REFERENTIAL_ACTION_FAILED');
  }
}
