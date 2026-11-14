/**
 * PUT / DELETE d'un équipement d'un bien.
 *
 * ⚠️ RUPTURE (lot 18, CDC 15 T3-02) — `purchasePriceCents` et
 * `estimatedValueCents` étaient lus du corps mais JAMAIS écrits. Ils le sont
 * désormais (`equipments.purchase_price_cents`, `estimated_value_cents`) :
 *   · unité : CENTIMES, entier ≥ 0, ou `null` pour effacer ;
 *   · un nombre DÉCIMAL est encore accepté (ancien client API qui enverrait
 *     des euros ou un montant calculé) : arrondi au centime entier, avec un
 *     avertissement journalisé — il n'est pas converti d'euros en centimes ;
 *   · négatif, non numérique : 400 INVALID_INPUT.
 * Une valeur réellement modifiée (comparée à la vue canonique de
 * l'équipement : fiche puis colonne) reçoit l'origine USER dans la fiche
 * canonique de l'équipement (hors commutateur) : aucune écriture automatique
 * ne la remplacera.
 *
 * Lot 20 (CDC 15, D-D) : `fiche` — caractéristiques canoniques saisies dans
 * le tiroir (puissance, COP, fluide frigorigène, compteur horaire,
 * `EQUIPMENT_FICHE_FIELDS`), écrites par le même chemin (origine USER, clés
 * réellement modifiées seulement). Valeur invalide : 400 VALIDATION_ERROR.
 *
 * Lot 70B (décision PO 19/10) :
 *   · `energyUsage` — usage énergétique déclaré dans le tiroir (choix fermé,
 *     `EQUIPMENT_ENERGY_USAGE_OPTIONS` ; `null` = non renseigné), écrit dans
 *     `equipments.energy_usage`, lu en priorité par la règle B6 du CIL.
 *     Valeur hors liste : 400 INVALID_INPUT. Absent : inchangé.
 *   · `category` — lue du corps depuis toujours mais JAMAIS écrite : elle
 *     l'est désormais (texte rogné, `''` ou `null` = effacée, 100 car. max).
 *     Absente : inchangée (aucun autre champ n'est touché).
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assets } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';
import { refuserSiModificationBiensSuspendue } from '@/lib/asset-quota-guard';
import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { archiveEquipmentForAccount, updateEquipmentForAccount } from '@/services/assets/structure-write.facade';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; equipId: string }> }
) {
  try {
    const { id, equipId } = await params;
    const assetId = parseInt(id);
    const equipmentId = parseInt(equipId);

    if (isNaN(assetId) || isNaN(equipmentId)) {
      return apiError(400, 'INVALID_INPUT', 'Valid asset ID and equipment ID are required');
    }

    let session;
    try {
      session = await SessionService.getSession(request);
    } catch (authError) {
      return SessionService.handleSessionError(authError);
    }

    if (!session || !session.currentAccountId) {
      return apiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    // Verify asset ownership
    const asset = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.accountId, session.currentAccountId)))
      .limit(1);

    if (asset.length === 0) {
      return apiError(404, 'NOT_FOUND', 'Asset not found');
    }

    // Au-dessus du quota après un changement d'offre : modification suspendue (GAP-11).
    const refusQuota = await refuserSiModificationBiensSuspendue(session.currentAccountId);
    if (refusQuota) return refusQuota;

    // Lot 114 (#753, W05) : modification par la façade métier — la même que l'Assistant Verebona (validations,
    // origine USER, cartes « À traiter », rapprochement après renommage ou déplacement, événements).
    const body = await request.json();
    return await updateEquipmentForAccount({ userId: session.userId ?? null, currentAccountId: session.currentAccountId }, assetId, equipmentId, body);
  } catch (error: any) {
    console.error('PUT equipment error:', error?.message ?? error);
    return NextResponse.json({ error: 'INTERNAL_ERROR', detail: error?.message ?? String(error) }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; equipId: string }> }
) {
  try {
    const { id, equipId } = await params;
    const assetId = parseInt(id);
    const equipmentId = parseInt(equipId);

    if (isNaN(assetId) || isNaN(equipmentId)) {
      return apiError(400, 'INVALID_INPUT', 'Valid asset ID and equipment ID are required');
    }

    let session;
    try {
      session = await SessionService.getSession(request);
    } catch (authError) {
      return SessionService.handleSessionError(authError);
    }

    if (!session || !session.currentAccountId) {
      return apiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    // Verify asset ownership
    const asset = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.accountId, session.currentAccountId)))
      .limit(1);

    if (asset.length === 0) {
      return apiError(404, 'NOT_FOUND', 'Asset not found');
    }

    // Lot 85D : retirer un équipement est une écriture — refusée en lecture seule.
    const refus = await refuserSiLectureSeule(session.currentAccountId);
    if (refus) return refus;

    // Lot 114 (#753, W06) : archivage logique par la façade métier — la même que l'Assistant Verebona.
    if (!(await archiveEquipmentForAccount(session.currentAccountId, assetId, equipmentId))) {
      return apiError(404, 'NOT_FOUND', 'Equipment not found');
    }
    return NextResponse.json({ message: 'Equipment archived successfully' });
  } catch (error) {
    console.error('DELETE equipment error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}
