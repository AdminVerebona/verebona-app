/**
 * Point d'entrée UNIQUE des écritures Opération — CDC Opérations V1 C21,
 * C21.1, C24 (NFR-OP-001 à NFR-OP-003), B26.
 *
 *   withBusinessOperationWrite(accountId, fn)
 *     ouvre une transaction, prend le verrou du compte, exécute `fn` avec un
 *     `BusinessOperationRepository`, valide, PUIS publie les événements.
 *     Une erreur annule tout : aucune écriture partielle, aucun événement.
 *
 *   withBusinessOperationWriteInTx(tx, accountIds, fn)
 *     même chose dans une transaction possédée par l'appelant (suppression
 *     d'un bien, transfert Duo) : rend les événements, que l'appelant publie
 *     par `publishBusinessOperationEvents` APRÈS son commit.
 *
 * Aucun interrupteur fonctionnel (P20, INV-034, décision PO Q8) : il n'existe
 * pas de mode où les Opérations seraient ignorées.
 */
import { randomUUID } from 'node:crypto';
import { db } from '@/db';
import { BusinessOperationEventBuffer, publishBusinessOperationEvents, type BusinessOperationEvent } from './events';
import { lockOperationAccounts, type DbTx } from './lock';
import { BusinessOperationRepository } from './repository';

export interface WriteOptions {
  /** Chaîne T1 → T3 → T4 ; générée si absente. */
  correlationId?: string;
  /** Auteur d'une correction utilisateur (B27 : provenance auditée). */
  actorUserId?: number | null;
}

export interface WriteSession {
  /** Dépôt lié à un compte verrouillé de la session. */
  repository(accountId: number): BusinessOperationRepository;
  readonly tx: DbTx;
  readonly events: BusinessOperationEventBuffer;
  readonly correlationId: string;
  readonly actorUserId: number | null;
}

async function ouvrirSession(tx: DbTx, accountIds: readonly number[], options: WriteOptions): Promise<WriteSession> {
  const locked = new Set(await lockOperationAccounts(tx, accountIds));
  const correlationId = options.correlationId ?? randomUUID();
  const actorUserId = options.actorUserId ?? null;
  const events = new BusinessOperationEventBuffer(correlationId);
  const repos = new Map<number, BusinessOperationRepository>();
  return {
    tx,
    events,
    correlationId,
    actorUserId,
    repository(accountId: number) {
      let r = repos.get(accountId);
      if (!r) {
        r = new BusinessOperationRepository(tx, accountId, locked, events, { correlationId, actorUserId });
        repos.set(accountId, r);
      }
      return r;
    },
  };
}

/** Écriture Opération d'un compte, transaction propre (voir l'en-tête). */
export async function withBusinessOperationWrite<T>(
  accountId: number,
  fn: (repo: BusinessOperationRepository, session: WriteSession) => Promise<T>,
  options: WriteOptions = {},
): Promise<T> {
  let events: BusinessOperationEvent[] = [];
  const result = await db.transaction(async (tx) => {
    const session = await ouvrirSession(tx, [accountId], options);
    const r = await fn(session.repository(accountId), session);
    events = session.events.drain();
    return r;
  });
  await publishBusinessOperationEvents(events);
  return result;
}

/**
 * Écriture Opération dans une transaction EXISTANTE. Les événements rendus ne
 * doivent être publiés qu'après le commit de cette transaction.
 */
export async function withBusinessOperationWriteInTx<T>(
  tx: DbTx,
  accountIds: readonly number[],
  fn: (session: WriteSession) => Promise<T>,
  options: WriteOptions = {},
): Promise<{ result: T; events: BusinessOperationEvent[] }> {
  const session = await ouvrirSession(tx, accountIds, options);
  const result = await fn(session);
  return { result, events: session.events.drain() };
}
