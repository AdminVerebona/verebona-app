/**
 * Activation des communications par canal — CDC Back-Office V1 §10
 * (COM-002, COM-011, COM-012, REC-MOD-01).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE CONTRÔLE EST FAIT AU MOMENT DE L'ENVOI, PAS DE L'ÉMISSION
 *
 * L'administrateur coupe un canal (e-mail, push ou in-app) d'un événement
 * depuis l'écran Communications. L'état est lu par le dispatcher juste avant
 * la livraison : un événement déjà en file au moment de la désactivation
 * n'est donc plus envoyé sur ce canal. Les autres canaux du même événement ne
 * sont pas touchés (REC-MOD-01).
 *
 * NOTIFICATIONS OBLIGATOIRES : un canal verrouillé par le catalogue
 * (`mandatoryBell`, `mandatoryEmail`, CDC notifications §2.11) ne peut pas
 * être désactivé. Le BO refuse la désactivation ; le dispatcher l'ignore en
 * plus, par défense en profondeur, si une ligne existait malgré tout.
 *
 * ÉCHEC DE LECTURE : on ENVOIE (fail-open). Une table absente (migration 0173
 * pas encore passée) ou une base momentanément injoignable ne doit pas
 * suspendre toutes les communications — dont les incidents de paiement et
 * les e-mails de sécurité. Le cas est journalisé.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';

/** Canaux du CDC BO (COM-001). `in_app` correspond à la cloche du moteur. */
export type CommunicationChannel = 'email' | 'push' | 'in_app';

export const COMMUNICATION_CHANNELS: readonly CommunicationChannel[] = ['email', 'push', 'in_app'];

/** Canal du moteur de notifications. */
export type EngineChannel = 'bell' | 'push' | 'email';

export function toCommunicationChannel(channel: EngineChannel): CommunicationChannel {
  return channel === 'bell' ? 'in_app' : channel;
}

/** Préfixe des e-mails transactionnels envoyés hors catalogue. */
export const TRANSACTIONAL_EMAIL_PREFIX = 'email:';

/** Clé d'activation d'un e-mail transactionnel (`email:WELCOME`). */
export function transactionalEventCode(templateCode: string): string {
  return `${TRANSACTIONAL_EMAIL_PREFIX}${templateCode.trim().toUpperCase()}`;
}

/**
 * E-mails transactionnels non désactivables : sécurité du compte, obligations
 * légales ou contractuelles, et seuls vecteurs d'une invitation. Le motif est
 * affiché dans le BO (UX-003).
 */
export const LOCKED_TRANSACTIONAL_EMAILS: Readonly<Record<string, string>> = {
  PASSWORD_RESET: 'E-mail de sécurité : indispensable à la réinitialisation du mot de passe.',
  EMAIL_VERIFICATION: 'E-mail de sécurité : indispensable à la vérification de l’adresse.',
  PREMIUM_CONFIRMATION: 'Confirmation du contrat sur support durable (point de départ du délai de rétractation).',
  WITHDRAWAL_VERIFICATION: 'Obligation légale : parcours de rétractation.',
  WITHDRAWAL_RECEIPT: 'Obligation légale : accusé de réception de la rétractation.',
  LEGAL_CONFIRMATION: 'Obligation légale : confirmation d’acceptation des conditions.',
  ACCOUNT_INVITATION: 'Seul vecteur du lien d’invitation au compte.',
  DUO_INVITATION: 'Seul vecteur du lien d’invitation Duo.',
};

export function transactionalLockReason(templateCode: string): string | null {
  return LOCKED_TRANSACTIONAL_EMAILS[templateCode.trim().toUpperCase()] ?? null;
}

// ── Lecture ─────────────────────────────────────────────────────────────────

/**
 * Canaux désactivés d'un événement. Ensemble vide si rien n'est désactivé ou
 * si la lecture échoue (fail-open, voir en-tête).
 */
export async function loadDisabledChannels(eventCode: string): Promise<Set<CommunicationChannel>> {
  try {
    const rows = await pgClient.unsafe<{ channel: CommunicationChannel }[]>(
      `SELECT channel FROM communication_channel_settings
        WHERE event_code = $1 AND is_active = false`,
      [eventCode],
    );
    return new Set(rows.map((r) => r.channel));
  } catch (error) {
    console.warn(
      `[channel-activation] lecture impossible pour ${eventCode}, envoi maintenu :`,
      (error as Error).message,
    );
    return new Set();
  }
}

/** Un e-mail transactionnel (hors catalogue) est-il actif ? */
export async function isTransactionalEmailActive(templateCode: string): Promise<boolean> {
  if (transactionalLockReason(templateCode)) return true;
  const disabled = await loadDisabledChannels(transactionalEventCode(templateCode));
  return !disabled.has('email');
}

// ── Décision (pure) ─────────────────────────────────────────────────────────

export interface EngineChannels {
  bell: boolean;
  push: boolean;
  email: boolean;
}

export interface ChannelActivationResult {
  /** Canaux à livrer. */
  channels: EngineChannels;
  /** Canaux prévus mais coupés par l'administrateur. */
  blocked: EngineChannel[];
}

/**
 * Applique l'activation par canal aux canaux résolus (préférences + catalogue).
 *
 * Un canal obligatoire n'est jamais bloqué. Le push n'est jamais obligatoire
 * (CDC notifications §5.2).
 */
export function applyChannelActivation(
  resolved: EngineChannels,
  disabled: ReadonlySet<CommunicationChannel>,
  mandatory: { bell: boolean; email: boolean },
): ChannelActivationResult {
  const channels: EngineChannels = { ...resolved };
  const blocked: EngineChannel[] = [];

  if (channels.bell && !mandatory.bell && disabled.has('in_app')) {
    channels.bell = false;
    blocked.push('bell');
  }
  if (channels.email && !mandatory.email && disabled.has('email')) {
    channels.email = false;
    blocked.push('email');
  }
  if (channels.push && disabled.has('push')) {
    channels.push = false;
    blocked.push('push');
  }
  return { channels, blocked };
}

/** Code d'erreur des livraisons ignorées pour canal désactivé (diagnostic). */
export const CHANNEL_DISABLED_ERROR_CODE = 'channel_disabled_by_admin';
