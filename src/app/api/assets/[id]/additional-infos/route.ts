/**
 * GET   /api/assets/[id]/additional-infos — Informations de « Préparation des
 *       dossiers » du bien (ex-« Informations complémentaires » ; seul le
 *       libellé UI a changé au lot 34, la route et les clés restent)
 * PATCH /api/assets/[id]/additional-infos — Correctif fusionné champ par champ
 *
 * CDC Exports V12 §4.3, §17, §26 ; DEC-007, IC-GEN-001..010, EXP-002.
 *
 * Accès : celui des autres routes `/api/assets/[id]/*` — le bien appartient au
 * compte courant de la session (titulaire ou co-titulaire Duo). Un bien d'un
 * autre compte répond 404 sans révéler son existence.
 *
 * Écriture : mêmes règles que la fiche bien (`loadWritableAsset`) — bien
 * archivé ou verrouillé refusé, compte restreint (essai terminé, impayé,
 * résiliation) ou au-dessus de son quota refusé via `entitlements.service`
 * (corps lu par `parseWriteBlocked` côté client).
 * Lot 34, point 6 : l'écriture exige en plus le droit FONCTIONNEL de créer des
 * dossiers (`canCreateDossiers`, jamais le nom de l'offre) — un compte
 * Standard reçoit 403 `PREMIUM_REQUIRED` AVANT toute lecture du corps : rien
 * n'est modifié, quel que soit le client (appel direct, ancien front). La
 * lecture (GET) reste ouverte : les données sont conservées après un
 * downgrade et l'écriture revient dès que le droit revient (droits relus à
 * chaque requête).
 *
 * Corps du PATCH : `{ commercial?: {...}, rental?: {...}, insurance?: {...},
 * claim?: {...}, finance?: {...}, version?: n }`. Une valeur `null` ou vide
 * retire le champ ; `0` est une valeur (IC-GEN-008). Montants en centimes
 * entiers, dates `AAAA-MM-JJ`.
 * Listes structurées (dommages, actions, échanges, points forts, protections,
 * éléments à assurer, charges) : remplacées en bloc ; `version` (celle lue
 * par le client) est alors obligatoire — 409 `CONFLICT` si la ligne a changé
 * depuis, avec l'état courant dans `details.current`. Les photos, pièces et
 * événements cités doivent appartenir au bien (422 sinon).
 * Réponse : l'état complet `{ assetId, commercial, rental, insurance, claim,
 * finance, updatedAt, updatedBy, version }`.
 *
 * GET `?include=references` : ajoute `references` (pièces, photos,
 * événements sinistre, suggestions de points forts) pour les sélecteurs du
 * formulaire.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { findAccessibleAssetForExport } from '@/services/exports/export-access';
import { AssetDetailsError, loadWritableAsset } from '@/services/asset-details-write.service';
import {
  AdditionalInfosConflictError, getAssetAdditionalInfos, updateAssetAdditionalInfos,
} from '@/services/exports/additional-infos.service';
import { findInvalidReferences, loadAdditionalInfoReferences } from '@/services/exports/additional-infos-references.service';
import { validateAdditionalInfosPatch, sectionsForCategory } from '@/lib/assets/additional-infos';
import { toExportFamily } from '@/services/exports/catalog';
import { emitBusinessEvent } from '@/services/verebona-assistant/events/business-events';
import { canCreateDossiers } from '@/services/entitlements.service';
import { DOSSIER_PREPARATION_PREMIUM_MESSAGE } from '@/lib/entitlements/dossier-rights';

type Ctx = { params: Promise<{ id: string }> };

function parseAssetId(raw: string): number | null {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const notFound = () => NextResponse.json(
  { error: 'ASSET_NOT_FOUND', code: 'INVALID_ASSET', message: 'Bien introuvable.' },
  { status: 404 },
);

function internalError(context: string, error: unknown): NextResponse {
  const res = SessionService.handleSessionError(error);
  if (res.status < 500) return res;
  console.error(`[additional-infos ${context}]`, error);
  return NextResponse.json(
    { error: 'INTERNAL_ERROR', code: 'INTERNAL_ERROR', message: 'Les informations de préparation des dossiers sont momentanément indisponibles.' },
    { status: 500 },
  );
}

export async function GET(request: NextRequest, { params }: Ctx) {
  try {
    const session = await SessionService.getSession(request);
    const assetId = parseAssetId((await params).id);
    if (!assetId) return NextResponse.json({ error: 'INVALID_ID', code: 'INVALID_ASSET' }, { status: 400 });

    const asset = await findAccessibleAssetForExport(session, assetId);
    if (!asset) return notFound();

    const withReferences = request.nextUrl.searchParams.get('include') === 'references';
    const [infos, references] = await Promise.all([
      getAssetAdditionalInfos(assetId, asset.accountId),
      withReferences ? loadAdditionalInfoReferences({ assetId, accountId: asset.accountId, userId: session.userId }) : Promise.resolve(undefined),
    ]);
    return NextResponse.json({
      ...infos,
      family: toExportFamily(asset.category),
      sections: sectionsForCategory(asset.category),
      ...(references ? { references } : {}),
    });
  } catch (error) {
    return internalError('GET', error);
  }
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  try {
    const session = await SessionService.getSession(request);
    const assetId = parseAssetId((await params).id);
    if (!assetId) return NextResponse.json({ error: 'INVALID_ID', code: 'INVALID_ASSET' }, { status: 400 });
    if (!session.currentAccountId) return notFound();
    const accountId = session.currentAccountId;

    let asset;
    try {
      asset = await loadWritableAsset(assetId, accountId);
    } catch (e) {
      if (!(e instanceof AssetDetailsError)) throw e;
      if (e.code === 'NOT_FOUND') return notFound();
      if (e.code === 'WRITE_BLOCKED') {
        const code = e.details.writeBlocked?.code ?? 'ASSET_QUOTA_EXCEEDED';
        return NextResponse.json(
          { error: code, code, message: e.message, limit: e.details.writeBlocked?.limit },
          { status: 403 },
        );
      }
      if (e.code === 'ASSET_UNAVAILABLE') {
        return NextResponse.json(
          { error: 'ASSET_UNAVAILABLE', code: 'FORBIDDEN', reason: e.details.reason, message: e.message },
          { status: 403 },
        );
      }
      throw e;
    }

    // Lot 34, point 6 : droit de créer des dossiers (DOSS-08). Même corps de
    // refus que les autres fonctions Premium (lu par `parseWriteBlocked`).
    const droit = await canCreateDossiers(accountId);
    if (!droit.allowed) {
      const code = droit.reason ?? 'PREMIUM_REQUIRED';
      const message = code === 'PREMIUM_REQUIRED' ? DOSSIER_PREPARATION_PREMIUM_MESSAGE : droit.message;
      return NextResponse.json({ error: code, code, message }, { status: 403 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: 'VALIDATION_ERROR', code: 'VALIDATION_ERROR', message: 'Corps JSON invalide.', fields: [] },
        { status: 400 },
      );
    }

    const validationError = (issues: Array<{ path: string; message: string }>) => NextResponse.json(
      {
        error: 'VALIDATION_ERROR',
        code: 'VALIDATION_ERROR',
        message: issues.length === 1 ? issues[0].message : 'Certains champs sont invalides.',
        fields: issues,
        // `details` : seul champ que `apiClient` transmet à l'appelant.
        details: { fields: issues },
      },
      { status: 422 },
    );

    const result = validateAdditionalInfosPatch(body, toExportFamily(asset.category));
    if (!result.ok) return validationError(result.issues);

    // Photos, pièces et événements cités : ceux du bien uniquement.
    const refIssues = await findInvalidReferences(assetId, accountId, result.patch);
    if (refIssues.length) return validationError(refIssues);

    let infos;
    try {
      infos = await updateAssetAdditionalInfos(assetId, accountId, session.userId, result.patch, {
        // Contrôle optimiste dès qu'une liste est touchée (ou qu'une version est fournie).
        expectedVersion: result.listPaths.length > 0 || result.expectedVersion !== null ? result.expectedVersion : null,
      });
    } catch (e) {
      if (!(e instanceof AdditionalInfosConflictError)) throw e;
      const current = await getAssetAdditionalInfos(assetId, accountId);
      return NextResponse.json(
        {
          error: 'CONFLICT',
          code: 'CONFLICT',
          message: 'Ces informations ont été modifiées entre-temps (autre onglet ou co-titulaire).',
          current,
          details: { current, lists: result.listPaths },
        },
        { status: 409 },
      );
    }

    // CDC Assistant §25.7, §31.7 : la fiche du bien a changé — les caches de
    // l'assistant qui la recopient sont invalidés.
    await emitBusinessEvent({ type: 'ASSET_UPDATED', accountId, entityId: assetId });

    return NextResponse.json({
      ...infos,
      family: toExportFamily(asset.category),
      sections: sectionsForCategory(asset.category),
    });
  } catch (error) {
    return internalError('PATCH', error);
  }
}
