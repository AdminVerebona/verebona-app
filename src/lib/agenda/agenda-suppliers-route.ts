/**
 * Lot 103E — « Fournisseur / intervenant » des routes de création et de
 * modification d'un élément d'Agenda (`POST /api/agenda`, `PUT /api/agenda/:id`).
 *
 *   · `preparerFournisseurs` : validation AVANT toute écriture (format,
 *     fournisseurs du compte actif) — refus 400 / 404 sans rien écrire ;
 *     `undefined` quand le champ est absent (rien ne change) ;
 *   · `appliquerFournisseurs` : application après l'écriture de l'élément
 *     (une transaction : fiches créées et liens, ou rien). Un échec technique
 *     n'annule pas l'élément enregistré : la réponse le signale
 *     (`suppliers.error`, code stable) et aucun lien partiel n'existe.
 * Serveur seulement.
 */
import { NextResponse } from 'next/server';
import { parseAgendaSuppliersPayload, type AgendaSuppliersPayload } from '@/lib/agenda/agenda-suppliers-rules';

export async function preparerFournisseurs(accountId: number, raw: unknown, itemId: number | null): Promise<AgendaSuppliersPayload | undefined | NextResponse> {
  const parsed = parseAgendaSuppliersPayload(raw);
  if (parsed === undefined) return undefined;
  if ('error' in parsed) return NextResponse.json({ error: parsed.error, code: 'AGENDA_SUPPLIERS_INVALID' }, { status: 400 });
  const { assertSuppliersPayloadInAccount, AgendaSupplierError } = await import('@/services/agenda/agenda-suppliers');
  try {
    await assertSuppliersPayloadInAccount(accountId, parsed, itemId);
  } catch (e) {
    if (e instanceof AgendaSupplierError) return NextResponse.json({ error: e.message, code: `AGENDA_SUPPLIERS_${e.code}` }, { status: 404 });
    throw e;
  }
  return parsed;
}

export async function appliquerFournisseurs(accountId: number, itemId: number, userId: number | null, payload: AgendaSuppliersPayload) {
  const { applyAgendaItemSuppliers, AgendaSupplierError } = await import('@/services/agenda/agenda-suppliers');
  try {
    const r = await applyAgendaItemSuppliers({ accountId, itemId, actorUserId: userId, payload });
    if (r.added.length || r.removed.length || r.created.length) {
      const { emitBusinessEvent } = await import('@/services/verebona-assistant/events/business-events');
      for (const c of r.created.filter((x) => x.outcome !== 'reused')) {
        await emitBusinessEvent({ type: 'SUPPLIER_CHANGED', accountId, entityId: c.supplierId });
      }
    }
    return { ok: true as const, supplierIds: r.supplierIds, created: r.created.map((c) => ({ name: c.name, supplierId: c.supplierId, outcome: c.outcome })) };
  } catch (e) {
    const code = e instanceof AgendaSupplierError ? `AGENDA_SUPPLIERS_${e.code}` : 'AGENDA_SUPPLIERS_FAILED';
    console.error(JSON.stringify({ event: 'agenda_suppliers.apply_failed', accountId, itemId, code, message: (e as Error).message.slice(0, 200) }));
    return { ok: false as const, error: 'L’élément est enregistré, mais les fournisseurs n’ont pas pu être associés. Réessayez depuis sa fiche.', code };
  }
}
