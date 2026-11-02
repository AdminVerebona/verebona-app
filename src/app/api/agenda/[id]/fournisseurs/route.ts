/**
 * Fournisseurs / intervenants d'un élément d'Agenda — lot 103E.
 *
 *   GET /api/agenda/:id/fournisseurs   noms et identifiants (fiche détaillée, tiroir en modification)
 *
 * Compte ACTIF de la session seulement ; un élément d'un autre compte → 404
 * (anti-énumération). NOMS seulement : aucune coordonnée (la fiche
 * fournisseur reste la source de consultation). Les écritures passent par
 * `PUT /api/agenda/:id` (champ `suppliers`) et par la fiche fournisseur.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, context: RouteContext) {
  let session;
  try {
    session = await SessionService.getSession(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }
  try {
    const accountId = session.currentAccountId;
    if (!accountId) return NextResponse.json({ error: 'No account selected' }, { status: 400 });
    const { id: rawId } = await context.params;
    if (!/^\d{1,10}$/.test(rawId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const { getItemSuppliers } = await import('@/services/agenda/agenda-suppliers');
    const suppliers = await getItemSuppliers(accountId, Number(rawId));
    if (!suppliers) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(
      { suppliers: suppliers.map((s) => ({ id: s.id, name: s.name, archived: s.status === 'archived', provenance: s.provenance })) },
      { headers: { 'Cache-Control': 'private, no-cache' } },
    );
  } catch (err) {
    console.error('[api/agenda/:id/fournisseurs] GET', (err as Error).message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
