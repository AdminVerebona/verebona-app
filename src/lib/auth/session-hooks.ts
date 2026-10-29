/**
 * Crochets de fin de session — lot 92 (CDC 18 §20 ; CDC 12 mobile AUTH-10,
 * PUSH-08 : « la déconnexion désactive le jeton push de cet appareil »).
 *
 * Module PUR (aucune dépendance) : importé par `@/db` (révocation globale)
 * comme par le registre des sessions.
 *
 * `onSessionRevoked(hook)` est appelé pour CHAQUE session du registre qui se
 * termine côté serveur :
 *   · `scope: 'logout'`   — déconnexion volontaire sur cet appareil ;
 *   · `scope: 'single'`   — « Déconnecter » un appareil (Mon compte ou BO) ;
 *   · `scope: 'others'`   — « Déconnecter tous les autres appareils » ;
 *   · `scope: 'all'`      — révocation globale (mot de passe changé ou
 *                           réinitialisé, rejeu, suspension, clôture, BO
 *                           « forcer la déconnexion ») ;
 *   · `scope: 'replaced'` — même appareil, session remplacée par une neuve
 *                           (reconnexion, session rouverte après clôture) :
 *                           `sameDeviceContinues = true`, l'appareil reste
 *                           connecté — un jeton push ne doit PAS être retiré.
 *
 * Branché (intégration 92 + 97) au démarrage du serveur
 * (`instrumentation-node.ts`) : `registerMobilePushSessionHook`
 * (`lib/mobile/session-revocation-hook.ts`) désactive le push de
 * l'installation rattachée à `sid` quand `sameDeviceContinues` est faux.
 *
 * Les erreurs d'un crochet sont journalisées et n'empêchent jamais la
 * révocation (déjà validée en base au moment de l'appel).
 */
export type SessionRevocationScope = 'logout' | 'single' | 'others' | 'all' | 'replaced';

export interface RevokedSessionInfo {
  sid: string;
  userId: number;
  /** Empreinte de l'appareil (jamais l'identifiant en clair) ; `null` si inconnu. */
  deviceKey: string | null;
  clientType: string;
  reason: string;
  scope: SessionRevocationScope;
  /** Vrai si le même appareil reste connecté avec une session neuve. */
  sameDeviceContinues: boolean;
  /**
   * Lot 94 (M2) : pour `scope: 'replaced'`, la session neuve qui prend la
   * suite sur le même appareil — le push mobile y est rattaché, pour que sa
   * révocation ultérieure coupe bien les notifications de l'appareil.
   */
  replacedBySid?: string;
}

type SessionRevokedHook = (session: RevokedSessionInfo) => unknown;

/*
 * Lot 94 (M2) : registre porté par `globalThis`. Next.js compile
 * l'instrumentation (où le crochet push mobile est branché au démarrage) et
 * les routes (où les sessions sont révoquées) dans des paquets distincts :
 * un état au niveau du module pourrait exister en DEUX exemplaires, et la
 * révocation d'une session ne couperait alors jamais le push. Un registre
 * unique par processus garantit que les routes voient le crochet branché.
 */
const REGISTRY_KEY = '__verebonaSessionRevokedHooks';
type HookRegistry = { hooks: Set<SessionRevokedHook>; keyed: Map<string, SessionRevokedHook> };
function registry(): HookRegistry {
  const g = globalThis as Record<string, unknown>;
  let r = g[REGISTRY_KEY] as HookRegistry | undefined;
  if (!r) {
    r = { hooks: new Set(), keyed: new Map() };
    g[REGISTRY_KEY] = r;
  }
  return r;
}

/**
 * Enregistre un crochet ; renvoie la fonction de désinscription. Avec `key`,
 * un nouvel enregistrement REMPLACE le précédent de même clé (démarrage
 * rejoué, rechargement à chaud) : jamais deux exécutions du même crochet.
 */
export function onSessionRevoked(hook: SessionRevokedHook, opts: { key?: string } = {}): () => void {
  const { hooks, keyed } = registry();
  if (opts.key) {
    const previous = keyed.get(opts.key);
    if (previous) hooks.delete(previous);
    keyed.set(opts.key, hook);
  }
  hooks.add(hook);
  return () => {
    hooks.delete(hook);
    if (opts.key && keyed.get(opts.key) === hook) keyed.delete(opts.key);
  };
}

/** Appelle les crochets (jamais bloquant pour l'appelant, jamais d'exception). */
export async function notifySessionsRevoked(sessions: readonly RevokedSessionInfo[]): Promise<void> {
  const { hooks } = registry();
  if (sessions.length === 0 || hooks.size === 0) return;
  for (const s of sessions) {
    for (const hook of [...hooks]) {
      try {
        await hook(s);
      } catch (e) {
        console.error('[session-hooks] crochet onSessionRevoked en échec :', (e as Error)?.message ?? e);
      }
    }
  }
}
