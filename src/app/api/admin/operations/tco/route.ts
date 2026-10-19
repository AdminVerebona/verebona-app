import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { AssetNotFoundForTcoError, readAssetTco } from '@/services/business-operations/tco/service';
import { ECONOMIC_LINE_REASON_LABELS, TCO_HIDDEN_REASON_LABELS, TCO_WARNING_LABELS, tcoUserView } from '@/services/business-operations/tco/dto';
import { ECONOMIC_LINE_STATUS_LABELS } from '@/services/business-operations/finance/economic-lines';
import { diagnosticsError, guardAdmin, NO_STORE } from '../_shared';

export const dynamic = 'force-dynamic';

const id = (v: string | null): number | null => (v && /^\d{1,10}$/.test(v) && Number(v) > 0 ? Number(v) : null);

/**
 * GET /api/admin/operations/tco?accountId=&assetId= — diagnostic du coût
 * total de possession d'un bien (lot 61, ticket P1 TCO §6) : CHAQUE ligne
 * examinée (composante consolidée, justificatif, prix de la fiche) avec son
 * document, son montant, sa devise, sa catégorie, sa source (T1, T3,
 * utilisateur), son Opération éventuelle, le montant retenu, son statut et
 * le motif d'inclusion ou d'exclusion. Même calcul que le tiroir et que T2
 * (`readAssetTco`), recalculé à la demande — aucune écriture, aucune
 * Opération créée, aucun accès SQL requis pour l'exploitant.
 *
 * Lot 68 (68A) : TOUTES les lignes restent listées ; `userView.hidden` indique
 * celles que la fiche ne montre pas (autre bien, justificatif porté par une
 * dépense consolidée affichée) et `tco.citedOnlyDocuments` les justificatifs
 * qui citent seulement le bien (lien MENTIONED), exclus des sources.
 */
export async function GET(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  const accountId = id(request.nextUrl.searchParams.get('accountId'));
  const assetId = id(request.nextUrl.searchParams.get('assetId'));
  if (!accountId || !assetId) {
    return NextResponse.json({ error: 'Paramètres invalides', code: 'INVALID_PARAMS', message: 'Compte et bien requis (identifiants numériques).' }, { status: 400, headers: NO_STORE });
  }
  try {
    const { entries, ...tco } = await readAssetTco(accountId, assetId);
    return NextResponse.json({
      accountId, assetId, tco, componentsExamined: entries.length,
      userView: { hidden: tcoUserView(tco.lines).hidden },
      labels: { status: ECONOMIC_LINE_STATUS_LABELS, reason: ECONOMIC_LINE_REASON_LABELS, warning: TCO_WARNING_LABELS, hidden: TCO_HIDDEN_REASON_LABELS },
    }, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof AssetNotFoundForTcoError) {
      return NextResponse.json({ error: 'Bien introuvable', code: 'ASSET_NOT_FOUND', message: 'Aucun bien actif de ce numéro dans ce compte.' }, { status: 404, headers: NO_STORE });
    }
    return diagnosticsError(e, 'coût de possession');
  }
}
