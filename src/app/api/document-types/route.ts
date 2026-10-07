/**
 * GET /api/document-types — types de documents du SÉLECTEUR (V1).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 32 (décision PO du 07/10/2026, Q13 : « il faut que ce soit la même
 * liste — le sélecteur n'est pas alimenté par la liste du code ? »)
 *
 * La route lisait la table `document_types` (lignes actives, ordre de la
 * table), seulement filtrée par `hideFromPicker` : le sélecteur du tiroir et
 * des dialogues dépendait du contenu de la base, pas du référentiel du code
 * (lot 30 : `document-type-constants`, résolveur `document-codes`,
 * équivalences `legacy-document-codes`, types V2 `DOCUMENT_TYPES`).
 *
 * Désormais la liste vient du CODE, et d'aucune autre source :
 *   · `status: 'ACTIVE'` — proposés à la création (`pickerDocumentTypes()`) ;
 *   · `status: 'LEGACY_SUPPORTED'` — codes V1 anciens ou fins (formats,
 *     diagnostics CIL) : servis pour le LIBELLÉ d'un document existant,
 *     jamais proposés (`hideFromPicker: true`).
 * Le statut est celui du résolveur unique (`resolveDocumentCode`). La table
 * `document_types` n'est plus lue ici ; `PUT /api/documents/:id` valide déjà
 * par le référentiel du code (lot 30).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextResponse } from 'next/server';
import { documentTypesForPicker } from '@/lib/referential/picker-document-types';

export async function GET() {
  return NextResponse.json({ documentTypes: documentTypesForPicker() }, { status: 200 });
}
