/**
 * POST /api/documents/upload-notification — CONSERVÉE POUR COMPATIBILITÉ.
 *
 * Lot 32 (PO-Q18/Q19) : la fenêtre d'ajout l'appelait en fin de lot d'envoi
 * pour émettre une notification « Document ajouté ».
 *
 * Lot 108I (ticket « Notifications documents ») : un ajout réussi est
 * confirmé discrètement DANS le parcours d'ajout, sans notification
 * (`lib/upload-confirmation-client.ts`). La fenêtre d'ajout ne l'appelle
 * plus ; une interface plus ancienne encore ouverte (onglet, application
 * native avant rechargement) peut l'appeler : la route répond sans rien
 * émettre. Les notifications « Document ajouté » déjà reçues restent dans
 * l'historique (type conservé au catalogue pour leur affichage).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth-guards';

/** Motif renvoyé (et tracé) : la confirmation est faite dans l'interface. */
const UPLOAD_NOTIFICATION_RETIRED_REASON = 'ui_confirmation';

export async function POST(request: NextRequest) {
  try { await getSession(request); }
  catch { return NextResponse.json({ error: 'AUTH_REQUIRED' }, { status: 401 }); }
  return NextResponse.json({ emitted: false, count: 0, reason: UPLOAD_NOTIFICATION_RETIRED_REASON }, { status: 202 });
}
