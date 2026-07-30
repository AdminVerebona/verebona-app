/**
 * GET /api/documents/browse — CDC 5 §8.3.
 *
 * Contrat commun à la page globale et à l'onglet d'un bien. La page globale
 * est le cas sans `assetIds` ; l'onglet d'un bien passe son identifiant. Rien
 * d'autre ne les distingue — c'est ce qui empêche les deux écrans de dériver.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import { listDocumentsGrouped } from '@/services/documents/document-query.service';

/** Liste d'entiers depuis un paramètre répété ou séparé par des virgules. */
function ids(params: URLSearchParams, key: string): number[] {
  return params
    .getAll(key)
    .flatMap((v) => v.split(','))
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function codes(params: URLSearchParams, key: string): string[] {
  return params.getAll(key).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
}

export async function GET(req: NextRequest) {
  let session;
  try {
    session = await SessionService.getSession(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }

  if (!session.currentAccountId) {
    return NextResponse.json({ error: 'NO_ACTIVE_ACCOUNT' }, { status: 400 });
  }

  await ensureMigrations();
  const p = req.nextUrl.searchParams;

  // Décalages par groupe : `offset[CODE]=20`. Chaque catégorie se pagine
  // indépendamment, l'utilisateur pouvant dérouler l'une sans les autres.
  const offsets: Record<string, number> = {};
  for (const [key, value] of p.entries()) {
    const match = key.match(/^offset\[(.+)\]$/);
    if (match) {
      const n = Number(value);
      if (Number.isInteger(n) && n >= 0) offsets[match[1]] = n;
    }
  }

  const result = await listDocumentsGrouped({
    accountId: session.currentAccountId,
    assetIds: ids(p, 'assetId'),
    equipmentIds: ids(p, 'equipmentId'),
    categoryCodes: codes(p, 'category'),
    typeCodes: codes(p, 'type'),
    formats: codes(p, 'format'),
    dateFrom: p.get('dateFrom') ?? undefined,
    dateTo: p.get('dateTo') ?? undefined,
    search: p.get('search') ?? undefined,
    onlyToClassify: p.get('onlyToClassify') === '1',
    sort: (p.get('sort') as never) ?? undefined,
    direction: (p.get('direction') as never) ?? undefined,
    pageSize: Number(p.get('pageSize')) || undefined,
    offsets,
  });

  return NextResponse.json(result);
}
