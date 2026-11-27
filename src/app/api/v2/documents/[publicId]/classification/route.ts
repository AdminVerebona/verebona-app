/**
 * PATCH /api/v2/documents/[publicId]/classification — CDC V2.0 §5.1, §5.3, §12.2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ENREGISTRER, C'EST AUSSI RÉSOUDRE
 *
 * §5.3 : « Si une action À arbitrer ou À compléter est active et que
 * l'utilisateur corrige directement la donnée dans le drawer ou dans un autre
 * écran métier, l'action correspondante est résolue automatiquement à
 * l'enregistrement. »
 *
 * C'est la règle qui distingue une file vivante d'une liste de tâches
 * parallèle. Sans elle, l'utilisateur qui range son document depuis le drawer
 * retrouverait la même question dans « À traiter », et conclurait — à raison —
 * que la page ne sait pas ce qu'il vient de faire.
 *
 * ── LA MODIFICATION MANUELLE VAUT VALIDATION ──────────────────────────────
 *
 * §5.1, dernier alinéa. `origin: 'USER'` protège donc définitivement la valeur
 * contre toute réécriture automatique (§12.2). Une meilleure proposition ne
 * pourra plus qu'ouvrir un arbitrage.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { updateDocumentClassificationForAccount } from '@/services/documents/document-write.facade';
import { refuserSiRequeteSurBienTransmis } from '@/lib/asset-read-only-guard';

export const dynamic = 'force-dynamic';

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ publicId: string }> },
) {
  // #849 (complément, A2) : bien TRANSMIS — consultation seule (garde centrale).
  { const refusTransmis = await refuserSiRequeteSurBienTransmis(req, context, { kind: 'documentPublicId', param: 'publicId' }); if (refusTransmis) return refusTransmis; }
  let session;
  try {
    session = await SessionService.getSession(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }

  const accountId = session.currentAccountId;
  if (!accountId) {
    return NextResponse.json({ error: 'NO_ACCOUNT_SELECTED' }, { status: 400 });
  }
  // Lot 85D : reclasser un document est une écriture — refusée en lecture seule.
  const refus = await refuserSiLectureSeule(accountId);
  if (refus) return refus;

  const { publicId } = await context.params;

  let body: { rubricCode?: string | null; documentTypeCode?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'INVALID_BODY' }, { status: 400 });
  }

  // Passage 114AB (#753, W12) : le corps de ce geste est la façade métier
  // partagée `document-write.facade.updateDocumentClassificationForAccount` —
  // le tiroir du document et l'Assistant passent par le MÊME code. Les règles,
  // les statuts et le JSON rendus ici sont inchangés.
  const r = await updateDocumentClassificationForAccount(
    { userId: session.userId, currentAccountId: accountId },
    { publicId },
    {
      ...('rubricCode' in body ? { rubricCode: body.rubricCode ?? null } : {}),
      ...('documentTypeCode' in body ? { documentTypeCode: body.documentTypeCode ?? null } : {}),
    },
  );
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });

  return NextResponse.json({
    classification: r.classification,
    changes: r.changes,
    rejected: r.rejected,
    resolvedActions: r.resolvedActions,
  });
}
