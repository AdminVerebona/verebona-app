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
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { assetFiles } from '@/db/schema';
import { SessionService } from '@/lib/session-service';
import { REFERENTIAL_VERSION, getDocumentType, getRubric } from '@/lib/referential/v2';
import {
  applyClassificationChange,
  type DocumentClassification,
} from '@/services/documents/rubric-classification';
import { resolveActionsForData } from '@/services/to-process/to-process-action.service';

export const dynamic = 'force-dynamic';

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ publicId: string }> },
) {
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

  const { publicId } = await context.params;

  let body: { rubricCode?: string | null; documentTypeCode?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'INVALID_BODY' }, { status: 400 });
  }

  // Codes inconnus rejetés avant toute écriture : une Rubrique inventée
  // rendrait le document invisible dans tous les regroupements.
  if (body.rubricCode != null && !getRubric(body.rubricCode)) {
    return NextResponse.json({ error: 'UNKNOWN_RUBRIC' }, { status: 400 });
  }
  if (body.documentTypeCode != null && !getDocumentType(body.documentTypeCode)) {
    return NextResponse.json({ error: 'UNKNOWN_TYPE' }, { status: 400 });
  }

  const [row] = await db
    .select({
      id: assetFiles.id,
      rubricCode: assetFiles.rubricCode,
      documentTypeCode: assetFiles.documentTypeCode,
      rubricOrigin: assetFiles.rubricOrigin,
      typeOrigin: assetFiles.typeOrigin,
      rubricUserValidated: assetFiles.rubricUserValidated,
      typeUserValidated: assetFiles.typeUserValidated,
    })
    .from(assetFiles)
    .where(and(eq(assetFiles.publicId, publicId), eq(assetFiles.accountId, accountId)))
    .limit(1);

  if (!row) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });

  const current: DocumentClassification = {
    rubricCode: row.rubricCode as never,
    documentTypeCode: row.documentTypeCode,
    rubricOrigin: row.rubricOrigin as never,
    typeOrigin: row.typeOrigin as never,
    rubricUserValidated: row.rubricUserValidated,
    typeUserValidated: row.typeUserValidated,
  };

  const outcome = applyClassificationChange({
    current,
    // `undefined` = champ non fourni donc inchangé ; `null` = retiré. La
    // distinction est portée par la présence de la clé dans le corps.
    nextRubric: 'rubricCode' in body ? (body.rubricCode as never) : undefined,
    nextType: 'documentTypeCode' in body ? body.documentTypeCode : undefined,
    origin: 'USER',
  });

  await db
    .update(assetFiles)
    .set({
      rubricCode: outcome.result.rubricCode,
      documentTypeCode: outcome.result.documentTypeCode,
      rubricOrigin: outcome.result.rubricOrigin,
      typeOrigin: outcome.result.typeOrigin,
      rubricUserValidated: outcome.result.rubricUserValidated,
      typeUserValidated: outcome.result.typeUserValidated,
      classificationReferentialVersion: REFERENTIAL_VERSION,
      classificationUpdatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(assetFiles.id, row.id));

  // §5.3 — les deux natures sont fermées d'un coup : une donnée renseignée ne
  // laisse subsister ni l'arbitrage qui proposait, ni la complétion qui
  // réclamait.
  const resolved: Record<string, number> = {};
  if (outcome.result.rubricCode !== current.rubricCode) {
    resolved.rubricCode = await resolveActionsForData(
      accountId, 'DOCUMENT', row.id, 'rubricCode', 'USER_COMPLETED',
    );
  }
  if (outcome.result.documentTypeCode !== current.documentTypeCode) {
    resolved.documentTypeCode = await resolveActionsForData(
      accountId, 'DOCUMENT', row.id, 'documentTypeCode', 'USER_COMPLETED',
    );
  }

  return NextResponse.json({
    classification: outcome.result,
    changes: outcome.changes,
    rejected: outcome.rejected,
    resolvedActions: resolved,
  });
}
