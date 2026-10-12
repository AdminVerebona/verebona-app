/**
 * Outils communs des routes Sinistre (`/api/assets/[id]/claims*`) — lot 44,
 * O5. Accès : celui des autres routes du bien (compte courant de la session,
 * titulaire ou co-titulaire Duo) ; un bien d'un autre compte répond 404.
 * Écriture : mêmes règles que la fiche (`loadWritableAsset` : bien archivé ou
 * verrouillé, compte restreint ou au-dessus du quota refusés) — SANS droit
 * Premium (décision PO Q3 : saisie ouverte à toutes les offres).
 */
import { NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { AssetDetailsError, loadWritableAsset } from '@/services/asset-details-write.service';
import { validateAdditionalInfosPatch, type NormalizedPatch, type PatchValidationIssue } from '@/lib/assets/additional-infos';
import { toExportFamily } from '@/services/exports/catalog';
import { findInvalidReferences } from '@/services/exports/additional-infos-references.service';
import { isBusinessOperationIntegrityError } from '../errors';
import { ClaimFormError } from '../consolidation/claim-form';

export function parsePositiveId(raw: string): number | null {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export const notFound = (message = 'Bien introuvable.') => NextResponse.json(
  { error: 'ASSET_NOT_FOUND', code: 'INVALID_ASSET', message },
  { status: 404 },
);

export function validationError(issues: PatchValidationIssue[]): NextResponse {
  return NextResponse.json(
    {
      error: 'VALIDATION_ERROR', code: 'VALIDATION_ERROR',
      message: issues.length === 1 ? issues[0].message : 'Certains champs sont invalides.',
      fields: issues, details: { fields: issues },
    },
    { status: 422 },
  );
}

/** Bien modifiable du compte, ou réponse de refus (corps lu par `parseWriteBlocked`). */
export async function writableAssetOr(assetId: number, accountId: number): Promise<{ asset: Awaited<ReturnType<typeof loadWritableAsset>> } | { response: NextResponse }> {
  try {
    return { asset: await loadWritableAsset(assetId, accountId) };
  } catch (e) {
    if (!(e instanceof AssetDetailsError)) throw e;
    if (e.code === 'NOT_FOUND') return { response: notFound() };
    if (e.code === 'WRITE_BLOCKED') {
      const code = e.details.writeBlocked?.code ?? 'ASSET_QUOTA_EXCEEDED';
      return { response: NextResponse.json({ error: code, code, message: e.message, limit: e.details.writeBlocked?.limit }, { status: 403 }) };
    }
    if (e.code === 'ASSET_UNAVAILABLE') {
      return { response: NextResponse.json({ error: 'ASSET_UNAVAILABLE', code: 'FORBIDDEN', reason: e.details.reason, message: e.message }, { status: 403 }) };
    }
    throw e;
  }
}

export interface ParsedClaimBody {
  patch: NormalizedPatch | null;
  expectedVersion: number | null;
  /** Biens concernés demandés (Q2) ; `null` : inchangés. */
  assetIds: number[] | null;
  /** Une liste est touchée : version obligatoire (verrou optimiste). */
  touchesLists: boolean;
}

/**
 * Corps `{ claim?: {...}, version?, assetIds? }` — même dictionnaire et même
 * validation que la sous-rubrique historique (`validateAdditionalInfosPatch`),
 * limitée à `claim`. Références (pièces, photos, événement) : celles des biens
 * concernés.
 */
export async function parseClaimBody(body: unknown, opts: { category: string; accountId: number; refAssetIds: readonly number[]; requireFields?: boolean }):
  Promise<{ ok: true; value: ParsedClaimBody } | { ok: false; issues: PatchValidationIssue[] }> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, issues: [{ path: '', message: 'Corps attendu : un objet.' }] };
  const b = body as Record<string, unknown>;
  const issues: PatchValidationIssue[] = [];
  for (const k of Object.keys(b)) if (!['claim', 'version', 'assetIds'].includes(k)) issues.push({ path: k, message: 'Champ inconnu.' });
  let assetIds: number[] | null = null;
  if (b.assetIds !== undefined) {
    if (!Array.isArray(b.assetIds) || !b.assetIds.length || b.assetIds.length > 50 || !b.assetIds.every((x) => Number.isSafeInteger(x) && (x as number) > 0)) {
      issues.push({ path: 'assetIds', message: 'Choisissez au moins un bien.' });
    } else {
      assetIds = [...new Set(b.assetIds as number[])];
    }
  }
  if (issues.length) return { ok: false, issues };
  let patch: NormalizedPatch | null = null;
  let expectedVersion: number | null = null;
  let touchesLists = false;
  const hasClaim = b.claim !== undefined && b.claim !== null && typeof b.claim === 'object' && Object.keys(b.claim as object).length > 0;
  if (hasClaim || b.version !== undefined) {
    if (hasClaim) {
      const r = validateAdditionalInfosPatch({ claim: b.claim, ...(b.version !== undefined ? { version: b.version } : {}) }, toExportFamily(opts.category));
      if (!r.ok) return r;
      patch = r.patch;
      expectedVersion = r.expectedVersion;
      touchesLists = r.listPaths.length > 0;
      const refIssues = await findInvalidReferences([...new Set(opts.refAssetIds)], opts.accountId, r.patch);
      if (refIssues.length) return { ok: false, issues: refIssues };
    } else if (typeof b.version !== 'number' || !Number.isSafeInteger(b.version) || b.version < 0) {
      return { ok: false, issues: [{ path: 'version', message: 'Version invalide.' }] };
    } else {
      expectedVersion = b.version;
    }
  }
  if (opts.requireFields && !patch && !assetIds) return { ok: false, issues: [{ path: '', message: 'Aucun champ à enregistrer.' }] };
  return { ok: true, value: { patch, expectedVersion, assetIds, touchesLists } };
}

/** Erreurs connues → réponse ; sinon 500 journalisé. */
export function claimErrorResponse(context: string, error: unknown): NextResponse {
  if (error instanceof ClaimFormError) {
    if (error.code === 'CLAIM_NOT_FOUND') return NextResponse.json({ error: 'CLAIM_NOT_FOUND', code: 'NOT_FOUND', message: error.message }, { status: 404 });
    if (error.code === 'INVALID_ASSETS' || error.code === 'EVENT_NOT_FOUND' || error.code === 'EVENT_ALREADY_LINKED') {
      return validationError([{ path: String(error.details.path ?? ''), message: error.message }]);
    }
  }
  if (isBusinessOperationIntegrityError(error)) {
    // Référence d'un autre compte, pièce disparue entre-temps… : refus sans détail technique.
    console.error(`[claims ${context}]`, error.message);
    return validationError([{ path: '', message: 'Certaines pièces ou références citées ne sont plus disponibles.' }]);
  }
  const res = SessionService.handleSessionError(error);
  if (res.status < 500) return res;
  console.error(`[claims ${context}]`, error);
  return NextResponse.json(
    { error: 'INTERNAL_ERROR', code: 'INTERNAL_ERROR', message: 'Les sinistres sont momentanément indisponibles.' },
    { status: 500 },
  );
}
