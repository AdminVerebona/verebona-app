import { NextRequest, NextResponse } from 'next/server';
import { emitBusinessEvent } from '@/services/verebona-assistant/events/business-events';
import { db } from '@/db';
import { assets } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';
import { refuserSiModificationBiensSuspendue } from '@/lib/asset-quota-guard';
import { civilDateParis, isIsoDate } from '@/services/business-operations/finance/engine';
import { valuationHistoryView, type ValuationEntry } from '@/services/business-operations/tco/valuation-history';

export type { ValuationEntry, ValuationEntryView } from '@/services/business-operations/tco/valuation-history';

/** Date d'achat canonique de la fiche (clé, alias, colonne historique) — admissibilité « postérieure à l'achat ». */
async function acquisitionDateOf(assetRow: Record<string, unknown>): Promise<string | null> {
  try {
    const { readCanonicalValue } = await import('@/services/canonical/asset-state/canonical-asset-view');
    const st = readCanonicalValue({
      id: Number(assetRow.id), account_id: (assetRow.accountId as number | null) ?? null, category: String(assetRow.category ?? ''),
      key_characteristics: (assetRow.keyCharacteristics as string | null) ?? null, purchase_date: assetRow.purchaseDate ?? null,
    }, 'acquisitionDate');
    return typeof st?.value === 'string' && isIsoDate(st.value.trim()) ? st.value.trim().slice(0, 10) : null;
  } catch { return null; }
}

function parseHistory(kc: Record<string, unknown>): ValuationEntry[] {
  try {
    const h = kc['valuationHistory'];
    if (Array.isArray(h)) return h as ValuationEntry[];
  } catch {}
  return [];
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const assetId = parseInt(id);
    if (isNaN(assetId)) return apiError(400, 'INVALID_INPUT', 'Valid asset ID required');

    let session;
    try { session = await SessionService.getSession(request); }
    catch (e) { return SessionService.handleSessionError(e); }
    if (!session?.currentAccountId) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

    const [assetRow] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.accountId, session.currentAccountId), isNull(assets.deletedAt)))
      .limit(1);

    if (!assetRow) return apiError(404, 'NOT_FOUND', 'Asset not found');

    let kc: Record<string, unknown> = {};
    try { kc = assetRow.keyCharacteristics ? JSON.parse(assetRow.keyCharacteristics) : {}; } catch {}

    let history = parseHistory(kc);

    // Backfill: if current estimatedValue exists but history is empty, create an initial entry
    if (history.length === 0 && kc['estimatedValue'] != null) {
      history = [{
        id: 'initial',
        value: Number(kc['estimatedValue']),
        date: (kc['estimatedValueDate'] as string) ?? null,
        mode: (kc['estimatedValueMode'] as string) ?? null,
        source: 'USER',
        addedAt: (assetRow as any).updatedAt?.toISOString?.() ?? new Date().toISOString(),
      }];
    }

    // Lot 111F : tri par date de valorisation et estimation retenue (règle commune avec le TCO).
    const today = civilDateParis();
    return NextResponse.json({ history: valuationHistoryView(history, { today, acquisitionDate: await acquisitionDateOf(assetRow as unknown as Record<string, unknown>) }), today });
  } catch (error) {
    console.error('GET /valuations error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const assetId = parseInt(id);
    if (isNaN(assetId)) return apiError(400, 'INVALID_INPUT', 'Valid asset ID required');

    let session;
    try { session = await SessionService.getSession(request); }
    catch (e) { return SessionService.handleSessionError(e); }
    if (!session?.currentAccountId) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

    const [assetRow] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.accountId, session.currentAccountId), isNull(assets.deletedAt)))
      .limit(1);

    if (!assetRow) return apiError(404, 'NOT_FOUND', 'Asset not found');

    // Au-dessus du quota après un changement d'offre : modification suspendue (GAP-11).
    const refusQuota = await refuserSiModificationBiensSuspendue(session.currentAccountId);
    if (refusQuota) return refusQuota;

    let body: { value?: number | null; date?: string | null; mode?: string | null; source?: 'USER' | 'AI' };
    try { body = await request.json(); }
    catch { return apiError(400, 'INVALID_INPUT', 'Invalid JSON body'); }
    // Lot 111F : valeur et DATE DE VALORISATION obligatoires (préremplie au jour, Europe/Paris, à l'écran), jamais future.
    if (typeof body.value !== 'number' || !Number.isFinite(body.value) || body.value < 0) return apiError(400, 'INVALID_INPUT', 'La valeur estimée est requise.');
    if (typeof body.date !== 'string' || !isIsoDate(body.date.trim())) return apiError(400, 'INVALID_INPUT', 'La date de valorisation est requise (AAAA-MM-JJ).');
    const dateValorisation = body.date.trim().slice(0, 10);
    if (dateValorisation > civilDateParis()) return apiError(400, 'INVALID_INPUT', 'La date de valorisation ne peut pas être postérieure à aujourd’hui.');

    let kc: Record<string, unknown> = {};
    try { kc = assetRow.keyCharacteristics ? JSON.parse(assetRow.keyCharacteristics) : {}; } catch {}

    const history = parseHistory(kc);

    const newEntry: ValuationEntry = {
      id: `v_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      value: body.value,
      date: dateValorisation,
      mode: body.mode ?? null,
      source: body.source ?? 'USER',
      addedAt: new Date().toISOString(),
      currency: 'EUR',
    };

    history.push(newEntry);

    // Lot 111F : la valeur courante de la fiche reflète la valorisation la plus RÉCENTE PAR DATE (jamais la dernière
    // ajoutée : une estimation ancienne saisie après coup ne remplace pas une estimation plus récente).
    kc['valuationHistory'] = history;
    const plusRecente = valuationHistoryView(history, { today: civilDateParis(), acquisitionDate: null }).find((v) => v.value != null && isIsoDate(v.date));
    const courante = plusRecente?.id === newEntry.id;
    if (courante) {
      kc['estimatedValue'] = newEntry.value;
      kc['estimatedValueDate'] = newEntry.date;
      if (newEntry.mode != null) kc['estimatedValueMode'] = newEntry.mode;
    }
    // CDC 15 T3-02 (lot 13, protection hors commutateur) : la valorisation
    // est saisie ou validée par l'utilisateur (même une estimation proposée
    // par l'IA, `source: 'AI'`, n'entre qu'à son geste) — origine USER et
    // date, pour qu'aucune réconciliation ne la remplace en silence.
    const { writeOrigin } = await import('@/services/ai/reconciliation/field-origin');
    const maintenant = new Date().toISOString();
    for (const k of ['estimatedValue', 'estimatedValueDate', 'estimatedValueMode'] as const) {
      if (courante && kc[k] != null && ((k === 'estimatedValue' && newEntry.value != null) || (k === 'estimatedValueDate' && newEntry.date != null)
        || (k === 'estimatedValueMode' && newEntry.mode != null))) {
        kc = writeOrigin(kc, k, 'USER', { updatedAt: maintenant });
      }
    }

    await db.update(assets)
      .set({ keyCharacteristics: JSON.stringify(kc), updatedAt: new Date() } as any)
      .where(eq(assets.id, assetId));

    // CDC Assistant §25.7, §31.7 : valorisation du bien.
    await emitBusinessEvent({ type: 'ASSET_UPDATED', accountId: session.currentAccountId, entityId: assetId });
    return NextResponse.json({ entry: newEntry });
  } catch (error) {
    console.error('POST /valuations error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
