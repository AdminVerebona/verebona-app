/**
 * GET /api/v2/to-process — file unique d'actions (CDC V2.0 §8).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ROUTE NOUVELLE, SOUS /v2, ET NON REMPLACEMENT DE L'EXISTANTE
 *
 * `/api/dashboard/a-traiter` sert la page V1 à onglets et sa pastille. La
 * remplacer maintenant casserait l'écran en service avant que le sien soit
 * vérifié. Les deux cohabitent le temps du lot 3 ; le retrait de la V1 relève
 * du lot 4.
 *
 * ── PARAMÈTRES ────────────────────────────────────────────────────────────
 *
 *   ?order=priority|action   défaut « priority », non mémorisé (§8.2)
 *   ?kind=ARBITRATE|COMPLETE
 *   ?priority=DO_FIRST|DO_NEXT|CAN_WAIT
 *   ?target=DOCUMENT|ASSET|EQUIPMENT|AGENDA_ITEM|SUPPLIER
 *   ?assets=12,45            sélection multiple (§8.8)
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { getToProcessPage } from '@/services/to-process/to-process-query.service';
import type {
  ActionKind,
  ActionPriority,
  TargetType,
} from '@/services/to-process/action-model';
import type { OrderMode } from '@/services/to-process/priority';

export const dynamic = 'force-dynamic';

const KINDS: ActionKind[] = ['ARBITRATE', 'COMPLETE'];
const PRIORITIES: ActionPriority[] = ['DO_FIRST', 'DO_NEXT', 'CAN_WAIT'];
const TARGETS: TargetType[] = ['DOCUMENT', 'ASSET', 'EQUIPMENT', 'AGENDA_ITEM', 'SUPPLIER'];

export async function GET(req: NextRequest) {
  let session;
  try {
    session = await SessionService.getSession(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }

  const accountId = session.currentAccountId;
  if (!accountId) {
    return NextResponse.json({ error: 'NO_ACCOUNT_SELECTED' }, { status: 400 });
  }

  const p = req.nextUrl.searchParams;
  const orderMode: OrderMode = p.get('order') === 'action' ? 'BY_ACTION' : 'BY_PRIORITY';

  // Un paramètre inconnu est ignoré plutôt que rejeté : un filtre mal
  // orthographié ne doit pas produire une page en erreur, seulement une page
  // non filtrée.
  const kind = KINDS.find((k) => k === p.get('kind'));
  const priority = PRIORITIES.find((v) => v === p.get('priority'));
  const targetType = TARGETS.find((t) => t === p.get('target'));
  const assetIds = (p.get('assets') ?? '')
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isInteger(v) && v > 0);

  const page = await getToProcessPage(accountId, {
    orderMode,
    filters: {
      actionKind: kind,
      priority,
      targetType,
      assetIds: assetIds.length > 0 ? assetIds : undefined,
    },
  });

  return NextResponse.json(page, {
    // Court, et identique à celui de la pastille : deux durées différentes
    // afficheraient un compteur en désaccord avec l'écran.
    headers: { 'Cache-Control': 'private, max-age=15, stale-while-revalidate=60' },
  });
}
