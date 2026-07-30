/**
 * Classement d'un document — CDC 5 §8.4 et §5.1.
 *
 * GET   : options proposables dans le drawer, limitées aux biens rattachés.
 * PATCH : modification, partielle ou complète.
 *
 * Le §8.4 impose d'accepter `categoryId` et `documentTypeCode`
 * INDÉPENDAMMENT : « afin d'autoriser les modifications partielles ». Un
 * utilisateur qui ne connaît que la catégorie doit pouvoir l'enregistrer, le
 * document restant « à classer » jusqu'à ce que le type soit renseigné.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import {
  updateClassification,
  getClassificationOptions,
  ClassificationError,
} from '@/services/documents/classification.service';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let session;
  try {
    session = await SessionService.getSession(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }
  if (!session.currentAccountId) {
    return NextResponse.json({ error: 'NO_ACTIVE_ACCOUNT' }, { status: 400 });
  }

  const fileId = Number((await params).id);
  if (!Number.isInteger(fileId)) {
    return NextResponse.json({ error: 'Identifiant invalide.', code: 'INVALID_ID' }, { status: 400 });
  }

  await ensureMigrations();

  try {
    return NextResponse.json(await getClassificationOptions(fileId, session.currentAccountId));
  } catch (e) {
    if (e instanceof ClassificationError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 404 });
    }
    throw e;
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let session;
  try {
    session = await SessionService.getSession(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }
  if (!session.currentAccountId) {
    return NextResponse.json({ error: 'NO_ACTIVE_ACCOUNT' }, { status: 400 });
  }

  const fileId = Number((await params).id);
  if (!Number.isInteger(fileId)) {
    return NextResponse.json({ error: 'Identifiant invalide.', code: 'INVALID_ID' }, { status: 400 });
  }

  await ensureMigrations();

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Corps de requête invalide.', code: 'BAD_REQUEST' }, { status: 400 });
  }

  // `undefined` = champ non touché ; `null` = champ explicitement vidé. La
  // distinction porte tout le §8.4 : sans elle, une modification partielle
  // effacerait le champ qu'on n'a pas voulu changer.
  const categoryCode = 'categoryCode' in body
    ? (typeof body.categoryCode === 'string' ? body.categoryCode : null)
    : undefined;
  const documentTypeCode = 'documentTypeCode' in body
    ? (typeof body.documentTypeCode === 'string' ? body.documentTypeCode : null)
    : undefined;

  if (categoryCode === undefined && documentTypeCode === undefined) {
    return NextResponse.json(
      { error: 'Aucune modification demandée.', code: 'NOTHING_TO_UPDATE' },
      { status: 400 },
    );
  }

  try {
    const result = await updateClassification({
      fileId,
      accountId: session.currentAccountId,
      categoryCode,
      documentTypeCode,
      // Toute modification passant par cette route vient d'un humain : elle
      // verrouille donc les champs touchés (§5.2).
      source: 'USER',
      actorUserId: session.userId,
    });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof ClassificationError) {
      const status = e.code === 'NOT_FOUND' ? 404 : 400;
      return NextResponse.json({ error: e.message, code: e.code }, { status });
    }
    console.error('[documents] classement impossible :', (e as Error).message);
    return NextResponse.json(
      { error: 'Une erreur interne est survenue.', code: 'INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}
