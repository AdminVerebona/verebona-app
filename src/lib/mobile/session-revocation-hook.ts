/**
 * Branchement du push mobile sur la fin de session — lot 97 (CDC 12 AUTH-10,
 * PUSH-08), POINT UNIQUE pour l'intégration avec le registre des sessions
 * (sous-lot 92, `src/lib/auth/session-hooks.ts`, hook `onSessionRevoked`
 * appelé à la déconnexion, révocation unitaire, autres appareils, globale,
 * remplacement).
 *
 * Branché (intégration 92 + 97) au démarrage du serveur, dans
 * `src/instrumentation-node.ts` :
 *
 *   registerMobilePushSessionHook((h) => onSessionRevoked(h, { key: 'mobile-push' }));
 *
 * Le registre transmet `RevokedSessionInfo` (`sid`, `userId`, `scope`,
 * `sameDeviceContinues`…). Le gestionnaire lit aussi les noms usuels
 * (`sessionId` / `familyId`, `installationId`) et ne fait RIEN sans
 * identifiant de session ni d'installation, ni quand le MÊME appareil reste
 * connecté avec une session neuve (`sameDeviceContinues`, remplacement à la
 * reconnexion : le jeton push ne doit pas être retiré). Il ne lève jamais
 * (une révocation ne doit pas échouer à cause du push).
 */
import { deactivatePushForSession, transferPushSession } from './push-installations';
import { parseInstallationId } from './client-context';

export interface RevokedSessionLike {
  sid?: string | null;
  sessionId?: string | null;
  familyId?: string | null;
  installationId?: string | null;
  userId?: number | null;
  /** Registre 92 : vrai si le même appareil continue avec une session neuve. */
  sameDeviceContinues?: boolean;
  /** Lot 94 (M2) : session neuve qui prend la suite sur le même appareil. */
  replacedBySid?: string | null;
}

/** Désactive le push de l'appareil de la session révoquée ; rend le nombre d'installations coupées. */
export async function onSessionRevokedPushHandler(session: RevokedSessionLike | null | undefined): Promise<number> {
  if (!session) return 0;
  const sid = [session.sid, session.sessionId, session.familyId].find((v) => typeof v === 'string' && v.trim() !== '') ?? null;
  const userId = typeof session.userId === 'number' && Number.isInteger(session.userId) ? session.userId : null;
  if (session.sameDeviceContinues === true) {
    // Lot 94 (M2) : même appareil, session neuve — le push reste actif et
    // suit la nouvelle session (sa révocation future le coupera).
    if (sid && typeof session.replacedBySid === 'string' && session.replacedBySid) {
      await transferPushSession(sid, session.replacedBySid, userId);
    }
    return 0;
  }
  const installationId = parseInstallationId(session.installationId ?? null);
  try {
    return await deactivatePushForSession({ sessionId: sid, installationId, userId });
  } catch {
    return 0;
  }
}

/** Enregistre le gestionnaire sur le hook du registre des sessions (fonction `onSessionRevoked`). */
export function registerMobilePushSessionHook(
  register: (hook: (session: RevokedSessionLike) => unknown) => unknown,
): void {
  register((session) => onSessionRevokedPushHandler(session));
}
