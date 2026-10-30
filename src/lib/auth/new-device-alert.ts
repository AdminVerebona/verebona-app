/**
 * Alerte « Connexion depuis un nouvel appareil » — lot 96B (CDC 18 §20.4,
 * §22, SESS-11 ; décisions PO Q6 et P5).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * QUAND
 *
 * Appelée par la fonction d'émission UNIQUE (`session-issuance.ts`) pour
 * toute session OUVERTE (`kind: 'open'`). Une alerte part seulement si :
 *   1. la session vient d'une CONNEXION RÉUSSIE (`NEW_DEVICE_ALERT_METHODS` :
 *      mot de passe, Google, Apple, lien d'activation) — jamais au
 *      renouvellement (`rotate`), au changement d'espace (`reissue`), ni à la
 *      session rouverte après « Déconnecter tous les autres appareils », un
 *      changement de mot de passe ou une clôture (`session_reopen`) ;
 *   2. l'appareil est INCONNU pour CE compte (`assessDevice`) — preuve
 *      SERVEUR uniquement (P5) :
 *        · reconnu si le cookie signé `vb_device` présenté porte une entrée
 *          valable pour CE compte (même règle que D1 règle A) — entrée liée
 *          à l'identifiant utilisateur depuis l'intégration 96 : un
 *          changement d'adresse (96A) ne rend aucun appareil « nouveau »,
 *          une adresse reprise n'hérite d'aucun appareil ;
 *        · reconnu si l'identifiant PROUVÉ de ce cookie (`authenticDeviceId`)
 *          a déjà porté une session de cet utilisateur (registre Q5, lignes
 *          actives ou terminées non purgées) ;
 *        · aucun en-tête déclaratif (`X-Verebona-Installation-Id`,
 *          `X-Verebona-Client`, User-Agent) ne peut rendre un appareil
 *          « reconnu » ni supprimer l'alerte ;
 *   3. ce n'est pas la toute première session du compte (activation,
 *      inscription Google / Apple) : la personne vient de créer son compte,
 *      il n'existe aucun « autre » appareil à protéger
 *      (`NEW_DEVICE_ALERT_ON_ACCOUNT_CREATION`, un seul point à changer).
 * Active dès la mise en service : aucune période d'apprentissage (Q6).
 *
 * UNE SEULE FOIS : clé d'idempotence `security:new-device:<user>:<empreinte
 * de l'appareil>` (file `notification_outbox`, unique) — deux connexions
 * simultanées du même navigateur n'envoient qu'un e-mail ; ensuite le
 * cookie signé reconnaît l'appareil.
 *
 * CONTENU (catalogue `NEW_DEVICE_LOGIN`, e-mail de sécurité OBLIGATOIRE,
 * non désactivable ; gabarit `notif_new_device_login`, migration 0832 ;
 * lot 101B : ni cloche, ni toast, ni push — décision PO du 30/10/2026) :
 * date et heure (Europe/Paris), appareil et navigateur ou « Application
 * Verebona », lien vers Mon compte › Sécurité › Appareils connectés. Ni IP
 * ni localisation. Aucune validation du nouvel appareil n'est demandée
 * (Q6) : l'alerte n'est pas une MFA.
 *
 * Jamais bloquant : un échec est journalisé, la session est émise.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { readDeviceCookie, trustedDeviceFor, authenticDeviceId, type DeviceTrustAccount } from './device-trust';
import { deviceAccountById } from './device-account';
import { deviceKeyFor, type SessionClientInfo } from './session-client';
import { isKnownDevice } from './session-registry';

/** Méthodes d'ouverture qui sont de vraies connexions (Q6). */
export const NEW_DEVICE_ALERT_METHODS: ReadonlySet<string> = new Set(['password', 'google', 'apple', 'email_link']);

/**
 * Choix pris par défaut (Q6) : pas d'alerte pour la session qui CRÉE le
 * compte (activation par le lien, inscription Google / Apple). `true` :
 * alerte aussi dans ce cas.
 */
export const NEW_DEVICE_ALERT_ON_ACCOUNT_CREATION = false;

/** Fenêtre de « création » d'un compte sans autre session (inscription Google / Apple, application). */
export const ACCOUNT_CREATION_WINDOW_MS = 24 * 60 * 60 * 1000;

export type DeviceAssessment =
  | { known: true; via: 'cookie' | 'registry' }
  | { known: false };

export type NewDeviceAlertOutcome =
  | 'sent' | 'known_device' | 'not_a_login' | 'account_creation' | 'error';

export interface NewDeviceAlertMessage {
  userId: number;
  dedupeKey: string;
  payload: { at: string; deviceLabel: string; browserLabel: string; clientType: string };
}

export interface NewDeviceAlertDeps {
  /** Compte pour la reconnaissance du cookie (identifiant + transition des entrées héritées). */
  account(userId: number): Promise<DeviceTrustAccount>;
  /** Cette empreinte d'appareil a-t-elle déjà porté une autre session de cet utilisateur ? */
  deviceSeen(userId: number, deviceKey: string, exceptSid: string): Promise<boolean>;
  /** Session qui crée le compte (aucune autre session, compte tout juste créé) ? */
  isAccountCreation(userId: number, sid: string, method: string): Promise<boolean>;
  send(message: NewDeviceAlertMessage): Promise<void>;
}

const dbDeps: NewDeviceAlertDeps = {
  account: deviceAccountById,
  async deviceSeen(userId, deviceKey, exceptSid) {
    return (await isKnownDevice(userId, deviceKey, exceptSid)) === true;
  },
  async isAccountCreation(userId, sid, method) {
    // Activation par le lien reçu : par construction la première session du compte.
    if (method === 'email_link') return true;
    const { pgClient } = await import('@/db');
    const [r] = await pgClient<{ recent: boolean; other: boolean }[]>`
      SELECT (u.created_at > ${new Date(Date.now() - ACCOUNT_CREATION_WINDOW_MS).toISOString()}) AS recent,
             EXISTS (SELECT 1 FROM user_sessions s WHERE s.user_id = u.id AND s.sid <> ${sid}) AS other
        FROM users u WHERE u.id = ${userId}`;
    return !!r && r.recent && !r.other;
  },
  async send(m) {
    const { emit } = await import('@/lib/notifications');
    await emit({
      type: 'NEW_DEVICE_LOGIN',
      recipientUserIds: [m.userId],
      entityType: 'user',
      entityId: m.userId,
      payload: m.payload,
      dedupeKey: m.dedupeKey,
    });
  },
};

// Surcharge portée par `globalThis` : elle survit à `vi.resetModules()` dans les tests.
const OVERRIDE_KEY = '__verebonaNewDeviceAlertDeps';
function deps(): NewDeviceAlertDeps {
  const o = (globalThis as Record<string, unknown>)[OVERRIDE_KEY] as Partial<NewDeviceAlertDeps> | null | undefined;
  return o ? { ...dbDeps, ...o } : dbDeps;
}

/** TESTS SEULEMENT : remplace tout ou partie des dépendances. `null` rétablit la base. */
export function __setNewDeviceAlertDepsForTests(d: Partial<NewDeviceAlertDeps> | null): void {
  (globalThis as Record<string, unknown>)[OVERRIDE_KEY] = d;
}

interface CookieRequest { cookies: { get(name: string): { value: string } | undefined } }

/**
 * L'appareil de la requête est-il connu pour ce compte ? Lit le cookie
 * PRÉSENTÉ (avant la connexion), jamais celui que la réponse dépose.
 */
export async function assessDevice(
  request: CookieRequest,
  input: { userId: number; sid: string },
): Promise<DeviceAssessment> {
  const raw = readDeviceCookie(request);
  if (raw && trustedDeviceFor(raw, await deps().account(input.userId))) return { known: true, via: 'cookie' };
  const proven = authenticDeviceId(raw);
  if (proven && await deps().deviceSeen(input.userId, deviceKeyFor('cookie', proven), input.sid)) {
    return { known: true, via: 'registry' };
  }
  return { known: false };
}

/**
 * Évalue puis émet (au plus une fois) l'alerte. Ne lève jamais.
 * `client` : description de l'appareil de la session qui vient d'être émise.
 */
export async function processNewDeviceAlert(
  request: CookieRequest,
  input: {
    userId: number;
    sid: string;
    method: string | null | undefined;
    client: SessionClientInfo;
    now?: Date;
  },
): Promise<NewDeviceAlertOutcome> {
  if (!input.method || !NEW_DEVICE_ALERT_METHODS.has(input.method)) return 'not_a_login';
  try {
    const a = await assessDevice(request, input);
    if (a.known) return 'known_device';
    if (!NEW_DEVICE_ALERT_ON_ACCOUNT_CREATION && await deps().isAccountCreation(input.userId, input.sid, input.method)) {
      return 'account_creation';
    }
    const now = input.now ?? new Date();
    await deps().send({
      userId: input.userId,
      // Une seule alerte par (compte, appareil) ; sans empreinte, par session.
      dedupeKey: `security:new-device:${input.userId}:${input.client.deviceKey ?? `sid-${input.sid}`}`,
      payload: {
        at: now.toISOString(),
        deviceLabel: input.client.deviceLabel,
        browserLabel: input.client.browserLabel,
        clientType: input.client.clientType,
      },
    });
    return 'sent';
  } catch (e) {
    console.error('[new-device-alert] alerte « nouvel appareil » en échec :', (e as Error)?.message ?? e);
    return 'error';
  }
}
