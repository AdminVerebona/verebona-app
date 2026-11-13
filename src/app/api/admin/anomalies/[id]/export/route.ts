import { NextRequest, NextResponse } from 'next/server';
import { getSession, requireAdmin } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { getAppBaseUrl } from '@/lib/app-url';
import { contentDisposition } from '@/lib/download-filename';
import {
  ANOMALY_EXPORT_FORMAT, ANOMALY_EXPORT_SCHEMA, ANOMALY_EXPORT_SCHEMA_VERSION, anomalyExportFileName, parisDateTime,
} from '@/services/admin/anomalies-export/model';
import { guardAdmin, NO_STORE } from '../../../ops/_shared';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/anomalies/[id]/export — lot 113AI (Trello #733) : UNE
 * anomalie de Supervision (écran de traitement) pour une analyse externe.
 *
 *   ?format=md (défaut)   « Copier » : texte Markdown structuré (code,
 *                         gravité, domaine, compte par identifiant, objet,
 *                         occurrences, statut, contexte technique, lien BO,
 *                         50 occurrences les plus récentes) ;
 *   ?format=json          même contenu, JSON versionné ; `download=1` :
 *                         pièce jointe datée.
 *
 * Garde administrateur AVANT toute lecture : un non-administrateur reçoit
 * la même réponse que l'anomalie existe ou non (anti-énumération).
 * Journalisé `ANOMALY_EXPORT` (cible : l'anomalie).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  const raw = (await params).id;
  const sp = request.nextUrl.searchParams;
  const format = sp.get('format') ?? 'md';
  const id = /^\d{1,9}$/.test(raw) && Number(raw) > 0 ? Number(raw) : null;
  const adminEmail = await getSession(request).then((s) => (typeof s?.email === 'string' ? s.email : undefined), () => undefined);
  const audit = (result: 'SUCCESS' | 'FAILURE', details: Record<string, unknown>) => logAdminAction({
    adminId: g.adminId, adminEmail, action: 'ANOMALY_EXPORT', targetType: 'ANOMALY', targetId: id, result,
    details: { scope: 'anomalie', format, ...details },
  });
  if (format !== 'md' && format !== 'json') {
    await audit('FAILURE', { code: 'INVALID_FORMAT' });
    return NextResponse.json({ error: 'Format inconnu (md, json).', code: 'INVALID_FORMAT' }, { status: 400, headers: NO_STORE });
  }
  if (!id) {
    await audit('FAILURE', { code: 'INVALID_ID' });
    return NextResponse.json({ error: 'Identifiant invalide', code: 'INVALID_ID' }, { status: 400, headers: NO_STORE });
  }
  try {
    const baseUrl = getAppBaseUrl(request);
    const { anomalyRecord, anomalyMarkdown } = await import('@/services/admin/anomalies-export/service');
    const rec = await anomalyRecord(id, baseUrl);
    if (!rec) {
      await audit('FAILURE', { code: 'NOT_FOUND' });
      return NextResponse.json({ error: 'Anomalie introuvable', code: 'NOT_FOUND' }, { status: 404, headers: NO_STORE });
    }
    // Lot 113AQ (#751) : section structurée des contradictions d'attributs — tracée, jamais prétendue complète si bornée.
    const complet = !rec.conflitsAttributs || rec.conflitsAttributs.complet;
    await audit('SUCCESS', {
      count: 1, occurrences: rec.historique?.length ?? 0,
      ...(rec.conflitsAttributs ? { conflicts: { contract: rec.conflitsAttributs.contrat, complete: complet, error: rec.conflitsAttributs.erreur } } : {}),
    });
    if (format === 'md') {
      return new Response(anomalyMarkdown(rec, baseUrl), { status: 200, headers: { ...NO_STORE, 'Content-Type': 'text/markdown; charset=utf-8' } });
    }
    const now = new Date();
    const body = {
      format: ANOMALY_EXPORT_FORMAT, schema: ANOMALY_EXPORT_SCHEMA, schemaVersion: ANOMALY_EXPORT_SCHEMA_VERSION,
      generatedAt: now.toISOString(), generatedAtParis: parisDateTime(now), timeZone: 'Europe/Paris',
      source: 'BO › Supervision › anomalie', total: 1, items: [rec], exported: 1, complete: complet,
    };
    const headers: Record<string, string> = { ...NO_STORE, 'Content-Type': 'application/json; charset=utf-8' };
    if (sp.get('download') === '1') headers['Content-Disposition'] = contentDisposition(anomalyExportFileName(rec.statut === 'ouverte' ? 'open' : 'resolved', 'json', now, id));
    return new Response(JSON.stringify(body, null, 2), { status: 200, headers });
  } catch (e) {
    console.error('[admin/anomalies/export] anomalie :', (e as Error)?.message ?? e);
    await audit('FAILURE', { code: 'EXPORT_FAILED' });
    return NextResponse.json({ error: 'Export impossible (voir le journal du serveur).', code: 'EXPORT_FAILED' }, { status: 500, headers: NO_STORE });
  }
}
