/**
 * Anti-force brute de la CONNEXION — lot 53A, retour PO D1 ; CDC 18 §9.1,
 * §32, §33 (« Limiter par IP + signal par identifiant/email hashé ; éviter
 * qu'une IP distribuée contourne totalement le contrôle »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI CHANGE (décision PO D1 : solution du lot 37 non validée)
 *
 * Lot 37 : 5 échecs sur une ADRESSE la verrouillaient 15, puis 30, puis
 * 60 min — pour tout le monde. Un tiers qui connaît l'adresse pouvait donc
 * empêcher le titulaire de se connecter pendant une heure, renouvelable.
 *
 * Désormais, la règle dépend de QUI tente, et le verrou sur l'adresse ne
 * touche jamais un appareil reconnu (`device-trust.ts`) :
 *
 *  A. APPAREIL RECONNU pour ce compte (déjà connecté avec succès, ou ayant
 *     activé l'adresse / réinitialisé le mot de passe) : seul compte son
 *     propre compteur — `login:dev` = (appareil, compte) : 10 échecs /
 *     15 min → pause de 1 min, puis 2, 4, 8, 15 min (plafond). Les compteurs
 *     de l'adresse et de l'IP ne s'appliquent pas : une attaque en cours ne
 *     bloque pas le titulaire sur ses appareils habituels.
 *
 *  B. APPAREIL NON RECONNU (attaquant, ou titulaire sur un nouvel appareil) :
 *     1. ORIGINE — `login:ip` : 20 échecs / 15 min, tous comptes confondus,
 *        depuis une même IP (IPv6 : préfixe /64, qu'un seul abonné possède
 *        en entier) → verrou de cette origine 15, 30, 60 min ;
 *     2. ORIGINE × IDENTIFIANT — `login:pair` : 5 échecs / 15 min sur une
 *        adresse depuis une même IP → RALENTISSEMENT progressif de cette
 *        paire : 1 min, puis 2, 4, 8, 15 min (plafond) ;
 *     3. IDENTIFIANT, toutes origines (attaque distribuée) — `login:acctu` :
 *        10 échecs / 1 h sur une adresse depuis des appareils non reconnus →
 *        pause des appareils NON RECONNUS pour cette adresse : 15, 30, 60 min
 *        (plafond). Les appareils reconnus du titulaire ne sont pas concernés.
 *     Vérification supplémentaire pendant une pause : « Mot de passe
 *     oublié ? » (lien reçu par e-mail = preuve de contrôle de la boîte).
 *     La réinitialisation réussie lève les compteurs de l'adresse (2 et 3)
 *     et fait reconnaître le navigateur utilisé.
 *
 * Invariants :
 *   · AUCUNE réponse ne révèle l'existence d'un compte : toutes les clés sont
 *     calculées sur l'adresse SAISIE (inscrite ou non) ; une adresse sans
 *     compte se ralentit exactement comme une adresse inscrite ; le refus
 *     (429) intervient avant toute lecture du compte ; le message ne parle
 *     que de « tentatives » ;
 *   · seuls les ÉCHECS comptent ; les refus pendant une pause ne prolongent
 *     pas la pause ;
 *   · une connexion réussie remet à zéro le compteur de l'appareil reconnu
 *     ou de la paire (IP, adresse) — jamais celui de l'IP ni celui de
 *     l'adresse toutes origines (une réussite ne doit pas rendre son crédit
 *     à une attaque distribuée en cours) ;
 *   · traçabilité : chaque échec est journalisé (LOGIN_FAILED, règle et
 *     appareil reconnu ou non) ; chaque pause déclenchée aussi
 *     (AUTH_LOGIN_THROTTLED) — visibles dans BO › Utilisateurs › fiche ›
 *     « Connexions et tentatives » quand l'adresse correspond à un compte.
 *     Clés pseudonymisées (HMAC) : ni e-mail ni IP en clair dans les
 *     compteurs.
 * ══════════════════════════════════════════════════════════════════════════
 */
import {
  type AuthLimitPolicy, type AuthRateLimiter, type LimitDecision, type LimitEntry, limitKey,
} from './auth-rate-limit';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Politiques de la connexion (D1). Toutes : seuls les ÉCHECS comptent. */
export const LOGIN_THROTTLE_POLICIES = {
  /** A. Appareil reconnu × compte. */
  trustedDevice: { maxAttempts: 10, windowMs: 15 * MIN, lockMs: MIN, progressive: true, maxLockMs: 15 * MIN, levelResetMs: 24 * HOUR },
  /** B1. Origine (IP ou préfixe IPv6 /64), tous comptes confondus. */
  origin: { maxAttempts: 20, windowMs: 15 * MIN, lockMs: 15 * MIN, progressive: true, maxLockMs: HOUR, levelResetMs: 24 * HOUR },
  /** B2. Origine × adresse : ralentissement progressif. */
  originIdentifier: { maxAttempts: 5, windowMs: 15 * MIN, lockMs: MIN, progressive: true, maxLockMs: 15 * MIN, levelResetMs: 24 * HOUR },
  /** B3. Adresse, toutes origines, appareils non reconnus (attaque distribuée). */
  identifierUntrusted: { maxAttempts: 10, windowMs: HOUR, lockMs: 15 * MIN, progressive: true, maxLockMs: HOUR, levelResetMs: 24 * HOUR },
} as const satisfies Record<string, AuthLimitPolicy>;

export type LoginThrottleRule = 'trusted_device' | 'origin' | 'origin_identifier' | 'identifier_untrusted';

/**
 * Origine pour le comptage : IPv4 telle quelle ; IPv6 réduite à son préfixe
 * /64 (un abonné dispose en général d'un /64 entier : sans cela, il
 * changerait d'« origine » à chaque requête).
 */
export function originBucket(ip: string): string {
  const v = (ip || 'unknown').trim().toLowerCase();
  if (!v.includes(':')) return v;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
  if (mapped) return mapped[1];
  // Développe « :: » pour obtenir les 4 premiers groupes.
  const [head, tail] = v.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const groups = tail !== undefined ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  if (groups.length < 4) return v;
  return `${groups.slice(0, 4).map((g) => (g || '0').replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

export interface LoginAttemptContext {
  /** Adresse saisie, normalisée (trim + minuscules). */
  identifier: string;
  /** IP réelle (`client-ip.ts`). */
  ip: string;
  /** Identifiant d'appareil si reconnu POUR CETTE ADRESSE (`device-trust.ts`), sinon `null`. */
  trustedDeviceId: string | null;
}

interface RuleEntry extends LimitEntry { rule: LoginThrottleRule }

/** Compteurs applicables à une tentative. */
export function loginThrottleEntries(ctx: LoginAttemptContext): RuleEntry[] {
  const P = LOGIN_THROTTLE_POLICIES;
  if (ctx.trustedDeviceId) {
    return [{ rule: 'trusted_device', key: limitKey('login', 'dev', `${ctx.trustedDeviceId}|${ctx.identifier}`), policy: P.trustedDevice }];
  }
  const origin = originBucket(ctx.ip);
  return [
    { rule: 'origin', key: limitKey('login', 'ip', origin), policy: P.origin },
    { rule: 'origin_identifier', key: limitKey('login', 'pair', `${origin}|${ctx.identifier}`), policy: P.originIdentifier },
    { rule: 'identifier_untrusted', key: limitKey('login', 'acctu', ctx.identifier), policy: P.identifierUntrusted },
  ];
}

/** Clés remises à zéro par une connexion RÉUSSIE (voir l'en-tête). */
function loginSuccessResetKeys(ctx: LoginAttemptContext): string[] {
  return loginThrottleEntries(ctx)
    .filter((e) => e.rule === 'trusted_device' || e.rule === 'origin_identifier')
    .map((e) => e.key);
}

/**
 * Clés levées par une RÉINITIALISATION de mot de passe réussie (preuve de
 * contrôle de la boîte e-mail) : compteurs de l'adresse, toutes origines et
 * depuis l'IP de la réinitialisation.
 */
export function passwordResetReleaseKeys(identifier: string, ip: string): string[] {
  return [
    limitKey('login', 'acctu', identifier),
    limitKey('login', 'pair', `${originBucket(ip)}|${identifier}`),
  ];
}

export interface ThrottleVerdict extends LimitDecision {
  /** Règle qui refuse (ou qui vient de poser une pause), pour le journal. */
  rule: LoginThrottleRule | null;
}

function ruleOf(entries: RuleEntry[], key: string | null): LoginThrottleRule | null {
  return entries.find((e) => e.key === key)?.rule ?? null;
}

/** Avant le contrôle du mot de passe : une pause est-elle en cours ? Ne compte rien. */
export async function checkLoginThrottle(limiter: AuthRateLimiter, ctx: LoginAttemptContext): Promise<ThrottleVerdict> {
  const entries = loginThrottleEntries(ctx);
  const d = await limiter.check(entries);
  return { ...d, rule: ruleOf(entries, d.blockedKey) };
}

/** Échec (adresse inconnue ou mot de passe faux) : compté sur chaque clé applicable. */
export async function recordLoginFailure(limiter: AuthRateLimiter, ctx: LoginAttemptContext): Promise<ThrottleVerdict> {
  const entries = loginThrottleEntries(ctx);
  const d = await limiter.recordFailure(entries);
  return { ...d, rule: ruleOf(entries, d.blockedKey) };
}

/** Réussite : remise à zéro des seuls compteurs de l'appareil reconnu / de la paire. */
export async function recordLoginSuccess(limiter: AuthRateLimiter, ctx: LoginAttemptContext): Promise<void> {
  for (const key of loginSuccessResetKeys(ctx)) await limiter.reset(key);
}

/**
 * Message du refus (429) — identique quelle que soit l'adresse et la règle :
 * il ne parle que de tentatives et propose la vérification par e-mail.
 */
export function loginThrottledBody(retryAfterSeconds: number): {
  error: string; code: 'RATE_LIMIT_EXCEEDED'; message: string; retryAfterSeconds: number;
} {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  const message = `Trop de tentatives de connexion. Réessayez dans ${minutes} minute${minutes > 1 ? 's' : ''}, `
    + 'ou utilisez « Mot de passe oublié ? » pour recevoir un lien de réinitialisation par e-mail.';
  return { error: message, code: 'RATE_LIMIT_EXCEEDED', message, retryAfterSeconds };
}
