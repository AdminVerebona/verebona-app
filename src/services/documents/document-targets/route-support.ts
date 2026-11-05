/**
 * Lot 111I — appui des routes d'édition (PUT document, routes `targets`) :
 * lecture des listes du corps, validation pour le compte, réponses d'erreur
 * homogènes (400 / 404 anti-énumération / 409 bien verrouillé).
 */
import { NextResponse } from 'next/server';
import { bodyHasTargetLists, currentSelection, levelChanged, selectionFromBody, TargetSelectionError, type TargetColumns, type TargetSelection } from './plan';
import { planDocumentTargets, type TargetsExecutor } from './service';

async function dbExecutor(): Promise<TargetsExecutor> {
  const { db } = await import('@/db');
  return db as unknown as TargetsExecutor;
}

export interface PreparedTargetLists {
  selection: TargetSelection;
  columns: TargetColumns;
  changed: { assets: boolean; rooms: boolean; equipments: boolean };
}

/**
 * Listes de rattachement du corps (`assetIds`, `substructureIds` / `roomIds`,
 * `equipmentIds`) validées pour le compte ; `null` si le corps n'en porte
 * aucune (ancien appelant à valeur unique). Un niveau absent garde sa
 * sélection actuelle. Lève `TargetSelectionError`.
 */
export async function prepareTargetLists(accountId: number, fileId: number, body: Record<string, unknown>, exec?: TargetsExecutor): Promise<PreparedTargetLists | null> {
  if (!bodyHasTargetLists(body)) return null;
  const x = exec ?? await dbExecutor();
  const p0 = await planDocumentTargets(x, accountId, fileId, { assetIds: [], roomIds: [], equipmentIds: [] }, 'add');
  const cur = currentSelection(p0.state.columns, p0.state.active);
  const selection = selectionFromBody(body, cur)!;
  const p = await planDocumentTargets(x, accountId, fileId, selection, 'replace');
  return {
    selection: p.selection,
    columns: p.columns,
    changed: {
      assets: levelChanged(p.current.assetIds, p.selection.assetIds),
      rooms: levelChanged(p.current.roomIds, p.selection.roomIds),
      equipments: levelChanged(p.current.equipmentIds, p.selection.equipmentIds),
    },
  };
}

/** Réponse HTTP d'une erreur de sélection ; `null` si l'erreur n'en est pas une. */
export function documentTargetsErrorResponse(e: unknown, accountId: number, context: string): NextResponse | null {
  if (!(e instanceof TargetSelectionError)) return null;
  if (e.code === 'NOT_FOUND') {
    if (e.refs.length) {
      console.warn(JSON.stringify({ event: 'security.cross_account_refused', context, accountId, refs: e.refs.slice(0, 20) }));
    }
    return NextResponse.json({ error: 'NOT_FOUND', message: 'Bien, pièce ou équipement introuvable' }, { status: 404 });
  }
  if (e.code === 'ASSET_LOCKED') return NextResponse.json({ error: 'ASSET_LOCKED', message: e.message }, { status: 409 });
  return NextResponse.json({ error: 'INVALID_INPUT', message: e.message }, { status: 400 });
}
