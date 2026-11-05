/**
 * Session d'une étape de dépôt (`/api/files/presign`, `/api/files/confirm`) —
 * lot 110A (partage natif).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE OPÉRATION D'IMPORT, DEUX FAÇONS DE S'AUTHENTIFIER
 *
 * Les routes de dépôt lisent normalement la session de la requête
 * (`getSession` : cookie / jeton d'accès, garde de session complète). La
 * route d'import du partage natif (`/api/mobile/share-import/upload`)
 * authentifie un JETON D'IMPORT (dérivé d'une session, import seul) puis
 * APPELLE CES MÊMES ROUTES, dans le même processus, avec une requête qu'elle
 * construit elle-même et à laquelle elle associe l'identité vérifiée.
 *
 * L'association passe par une `WeakMap` sur l'OBJET requête : aucun en-tête,
 * cookie ou paramètre ne peut la produire depuis l'extérieur — une requête
 * HTTP reçue n'est jamais dans cette table. Hors de ce cas, la garde de
 * session habituelle s'applique, inchangée.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth-guards';

/** Identité utile aux étapes de dépôt. */
export interface DepotSession {
  userId: number;
  currentAccountId?: number;
  /** Origine de l'identité (journal) : jeton d'import du partage natif. */
  via?: 'share-import-grant';
}

const delegated = new WeakMap<object, Readonly<DepotSession>>();

/**
 * Associe à une requête CONSTRUITE EN INTERNE l'identité déjà vérifiée par
 * l'appelant (jeton d'import). À n'utiliser que depuis
 * `services/mobile/share-import/import-operation.ts`.
 */
export function delegateDepotSession<R extends NextRequest>(request: R, session: DepotSession): R {
  delegated.set(request, Object.freeze({ userId: session.userId, currentAccountId: session.currentAccountId, via: 'share-import-grant' as const }));
  return request;
}

/** Session de l'étape de dépôt : identité déléguée en interne, sinon garde de session habituelle. */
export async function resolveDepotSession(request: NextRequest): Promise<DepotSession & Partial<Awaited<ReturnType<typeof getSession>>>> {
  const d = delegated.get(request);
  if (d) return { ...d };
  return getSession(request);
}
