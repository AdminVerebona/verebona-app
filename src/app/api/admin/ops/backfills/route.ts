import { NextRequest, NextResponse } from 'next/server';
import { getSession, requireAdmin } from '@/lib/auth-guards';
import { BACKFILL_DEFINITIONS, validateBackfillRequest } from '@/services/admin/ops/backfill/definitions';
import {
  BackfillBusyError, BackfillUnavailableError, getBackfillState, startBackfill,
} from '@/services/admin/ops/backfill/runner';
import { guardAdmin, NO_STORE, opsError } from '../_shared';

export const dynamic = 'force-dynamic';

/**
 * Rattrapages de données (page « Exploitation », lot 25).
 *
 *   GET  : catalogue (ordre recommandé, actions permises), exécution en cours,
 *          historique (sans les rapports JSON).
 *   POST : { script, action: simulate|apply|restore, step?, runId?, accountId?, reason }
 *          → 202 et l'exécution lancée EN TÂCHE DE FOND ; 409 BACKFILL_BUSY si
 *          un rattrapage tourne déjà sur la plateforme ; 400 si la demande est
 *          invalide (motif obligatoire pour appliquer ou restaurer).
 * Journalisé dans l'audit admin (auteur, action, motif, identifiants).
 */
export async function GET(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  try {
    const state = await getBackfillState(50);
    return NextResponse.json({ definitions: BACKFILL_DEFINITIONS, ...state }, { headers: NO_STORE });
  } catch (e) {
    if ((e as { code?: string }).code === '42P01') {
      return NextResponse.json(
        { error: 'Indisponible', code: 'BACKFILL_UNAVAILABLE', message: 'Table ops_backfill_runs absente : migration 0253 non appliquée.' },
        { status: 503, headers: NO_STORE },
      );
    }
    return opsError(e, 'rattrapages (lecture)', 'OPS_BACKFILL_LIST_FAILED');
  }
}

export async function POST(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  const body = await request.json().catch(() => null);
  const v = validateBackfillRequest(body);
  if (!v.ok) return NextResponse.json({ error: 'Demande invalide', code: v.code, message: v.message }, { status: 400, headers: NO_STORE });
  try {
    // E-mail de l'auteur (historique « lancé par », journal) ; à défaut, relu en base par l'audit.
    const email = await getSession(request).then((s) => (s as { email?: string } | null)?.email, () => undefined);
    const run = await startBackfill(v.value, { id: g.adminId, email: email || undefined });
    return NextResponse.json({ run }, { status: 202, headers: NO_STORE });
  } catch (e) {
    if (e instanceof BackfillBusyError) {
      return NextResponse.json({ error: 'Déjà en cours', code: e.code, message: e.message, active: e.active }, { status: 409, headers: NO_STORE });
    }
    if (e instanceof BackfillUnavailableError) {
      return NextResponse.json({ error: 'Indisponible', code: e.code, message: e.message }, { status: 503, headers: NO_STORE });
    }
    return opsError(e, 'rattrapages (lancement)', 'OPS_BACKFILL_START_FAILED');
  }
}
