import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { positiveInt } from '@/services/business-operations/diagnostics/model';
import { readOperationGraphDiagnostic } from '@/services/business-operations/graph/audit-read';
import { diagnosticsError, guardAdmin, NO_STORE } from '../_shared';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/operations/graph?accountId= — diagnostic du GRAPHE des
 * opérations d'un compte (lot 116C, carte #806 §4, AC73) : état du contrôle
 * de cohérence `COH-OPERATION-GRAPH` (fondé sur la preuve de contrôle : un
 * compte sans preuve est « jamais contrôlé », jamais « vérifié ») et écarts
 * recalculés à l'instant — liens orphelins, liens entre comptes, refus ou
 * scission de l'utilisateur contournés, provenance manquante, double comptage.
 * Lecture seule (transaction READ ONLY) : aucune réparation n'est faite.
 */
export async function GET(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  const accountId = positiveInt(request.nextUrl.searchParams.get('accountId'));
  if (!accountId) {
    return NextResponse.json({ error: 'Paramètres invalides', code: 'INVALID_PARAMS', message: 'Compte requis (identifiant numérique).' }, { status: 400, headers: NO_STORE });
  }
  try {
    const diagnostic = await readOperationGraphDiagnostic(accountId);
    if (!diagnostic.accountFound) {
      return NextResponse.json({ error: 'Compte introuvable', code: 'ACCOUNT_NOT_FOUND', message: 'Aucun compte de ce numéro.' }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json(diagnostic, { headers: NO_STORE });
  } catch (e) {
    return diagnosticsError(e, 'graphe des opérations');
  }
}
