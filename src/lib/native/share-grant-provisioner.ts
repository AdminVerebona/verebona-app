/**
 * Remise du jeton d'import au natif — lot 111P (correctif du lot 110A,
 * ticket « partage iOS : “Vous n'êtes pas connecté” à tort »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI
 *
 * Au lot 110A, la vue demandait un jeton quand l'état natif changeait, une
 * fois : un échec (réseau, cookie d'accès expiré au retour au premier plan,
 * 5xx, écriture Keychain refusée…) rendait `false` sans motif, et — l'état
 * « aucun jeton » ne changeant plus — plus rien ne se passait jusqu'au
 * redémarrage. Un jeton refusé par le serveur (révoqué, remplacé, épuisé)
 * restait aussi « valide » pour l'app jusqu'à son échéance. L'extension de
 * partage affichait alors « Vous n'êtes pas connecté ».
 *
 * CE QUI EST GARANTI ICI (même circuit : route `grant`, garde de session)
 *
 *   · déclencheurs : session ouverte (connexion), démarrage, retour au
 *     premier plan, changement d'espace, état natif (jeton refusé par le
 *     serveur), échéance anticipée (24 h avant), nouvel essai temporisé ;
 *   · reprise BORNÉE d'un échec passager (4 essais : 5 s, 30 s, 2 min,
 *     10 min) ; un refus définitif (MFA, fonction coupée, session absente,
 *     natif, Keychain) n'est retenté qu'au déclencheur suivant, espacé d'au
 *     moins 30 s ; les événements natifs ne relancent jamais un échec ;
 *   · jeton refusé par le serveur : renouvelé une fois par jeton, 3 fois au
 *     plus par 30 min — jamais de boucle « refus → nouveau jeton → refus » ;
 *   · vérification serveur légère (référence non secrète du jeton) au
 *     démarrage / retour au premier plan / connexion, au plus toutes les
 *     10 min : jeton inconnu du serveur ou presque épuisé → renouvelé ;
 *   · chaque décision est écrite dans le journal technique (codes seuls).
 * ══════════════════════════════════════════════════════════════════════════
 */
import {
  SHARE_IMPORT_GRANT_CHECK_INTERVAL_MS, SHARE_IMPORT_PROVISION_MIN_GAP_MS,
  SHARE_IMPORT_REFUSAL_RENEWALS_MAX, SHARE_IMPORT_REFUSAL_RENEWALS_WINDOW_MS,
} from '@/lib/mobile/share-import-policy';
import {
  grantNeed, provisionRetryDelay, renewalDueAt, serverGrantVerdict,
  type GrantNeed, type NativeShareState, type ProvisionCode, type ProvisionResult,
} from './share-import';

export type ProvisionTrigger = 'session' | 'start' | 'resume' | 'account' | 'native' | 'retry' | 'renewal';

export type ProvisionPhase = 'idle' | 'checking' | 'provisioning' | 'ready' | 'retry_scheduled' | 'blocked';
export interface ProvisionStatus {
  phase: ProvisionPhase;
  /** Dernier code utile : motif du besoin, résultat d'une demande, ou limite atteinte. */
  code: ProvisionCode | GrantNeed | 'REFUSAL_LIMIT' | 'SERVER_NOT_ACTIVE' | 'SERVER_LOW_USES' | null;
  nextRetryAt: number | null;
}

export interface ProvisionerDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  readState(): Promise<NativeShareState>;
  provision(): Promise<ProvisionResult>;
  /** Références des jetons actifs côté serveur, ou null si la vérification n'a pas pu se faire. */
  checkServer(): Promise<Array<{ ref: string; usesLeft: number }> | null>;
  resume(): Promise<void>;
  journal(code: string, detail?: Record<string, unknown>): void;
  onStatus(s: ProvisionStatus): void;
}

/** Déclencheurs « humains » : ils lèvent un blocage (espacés d'au moins 30 s, sauf connexion / espace). */
const FRESH_TRIGGERS: ReadonlySet<ProvisionTrigger> = new Set(['session', 'start', 'resume', 'account']);
/** Déclencheurs qui autorisent la vérification serveur légère. */
const CHECK_TRIGGERS: ReadonlySet<ProvisionTrigger> = new Set(['session', 'start', 'resume', 'account']);
/** Échéance d'un minuteur : bornée (setTimeout ≤ 24,8 jours) et jamais immédiate. */
const MAX_TIMER_MS = 24 * 86_400_000;

export class ShareGrantProvisioner {
  private account: string | null = null;
  private enabled = false;
  private busy = false;
  private pending: { t: ProvisionTrigger; s?: NativeShareState } | null = null;
  private attempts = 0;
  private blocked = false;
  private lastAttemptAt = 0;
  private lastCheckAt = 0;
  private retryTimer: unknown = null;
  private renewalTimer: unknown = null;
  private renewals: number[] = [];
  private renewedRefs = new Set<string>();
  private status: ProvisionStatus = { phase: 'idle', code: null, nextRetryAt: null };
  private disposed = false;

  constructor(private readonly deps: ProvisionerDeps) {}

  getStatus(): ProvisionStatus { return this.status; }

  /** Session / espace / interrupteur serveur. Un nouveau compte repart de zéro (essais, vérification). */
  setContext(account: string | null, enabled: boolean): void {
    const changed = account !== this.account;
    const wasActive = !!this.account && this.enabled;
    this.account = account;
    this.enabled = enabled;
    if (!account || !enabled) {
      this.clearTimers();
      this.attempts = 0;
      this.blocked = false;
      this.setStatus({ phase: 'idle', code: null, nextRetryAt: null });
      return;
    }
    if (changed) {
      this.clearTimers();
      this.attempts = 0;
      this.blocked = false;
      this.lastCheckAt = 0;
      void this.trigger(wasActive ? 'account' : 'session');
    } else if (!wasActive) {
      void this.trigger('session');
    }
  }

  /** (Re)mise en service — un démontage/remontage de la vue (mode strict de React) ne la laisse pas éteinte. */
  activate(): void {
    this.disposed = false;
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimers();
  }

  /** Évalue le besoin de jeton pour ce déclencheur ; `state` : état natif déjà lu, sinon relu. */
  async trigger(t: ProvisionTrigger, state?: NativeShareState): Promise<void> {
    if (this.disposed || !this.account || !this.enabled) return;
    if (this.busy) {
      // Un seul déclencheur en attente ; un déclencheur « humain » l'emporte sur un événement natif.
      if (!this.pending || FRESH_TRIGGERS.has(t) || !FRESH_TRIGGERS.has(this.pending.t)) this.pending = { t, s: state };
      return;
    }
    this.busy = true;
    try {
      await this.run(t, state);
    } finally {
      this.busy = false;
      const next = this.pending;
      this.pending = null;
      if (next && !this.disposed) void this.trigger(next.t, next.s);
    }
  }

  private async run(t: ProvisionTrigger, given?: NativeShareState): Promise<void> {
    const account = this.account as string;
    const now = this.deps.now();
    const state = given ?? await this.deps.readState();
    if (account !== this.account) return; // compte changé pendant la lecture : le nouveau déclencheur s'en charge
    let need: GrantNeed | 'SERVER_NOT_ACTIVE' | 'SERVER_LOW_USES' = grantNeed(state.grant, account, now);

    if (need === 'OK') {
      this.scheduleRenewal(state);
      if (CHECK_TRIGGERS.has(t) && state.grant?.ref && now - this.lastCheckAt >= SHARE_IMPORT_GRANT_CHECK_INTERVAL_MS) {
        this.lastCheckAt = now;
        this.setStatus({ phase: 'checking', code: null, nextRetryAt: null });
        const active = await this.deps.checkServer();
        if (account !== this.account) return;
        const verdict = active ? serverGrantVerdict(state.grant.ref, active) : 'UNVERIFIABLE';
        this.deps.journal('GRANT_CHECK', { trigger: t, verdict });
        if (verdict === 'NOT_ACTIVE') need = 'SERVER_NOT_ACTIVE';
        else if (verdict === 'LOW_USES') need = 'SERVER_LOW_USES';
      }
      if (need === 'OK') {
        this.attempts = 0;
        this.blocked = false;
        this.setStatus({ phase: 'ready', code: null, nextRetryAt: null });
        return;
      }
    }

    // Garde-fous anti-boucle.
    if (t === 'native' && (this.blocked || this.retryTimer)) return; // un échec n'est jamais relancé par un événement natif
    if (FRESH_TRIGGERS.has(t)) {
      if (t !== 'session' && t !== 'account' && this.lastAttemptAt && now - this.lastAttemptAt < SHARE_IMPORT_PROVISION_MIN_GAP_MS) return;
      if (this.blocked || this.retryTimer) { this.blocked = false; this.attempts = 0; this.clearRetry(); }
    }
    const refusedRef = need === 'REFUSED' || need === 'SERVER_NOT_ACTIVE' ? state.grant?.ref ?? null : null;
    if (need === 'REFUSED') {
      this.renewals = this.renewals.filter((x) => now - x < SHARE_IMPORT_REFUSAL_RENEWALS_WINDOW_MS);
      if ((refusedRef && this.renewedRefs.has(refusedRef)) || this.renewals.length >= SHARE_IMPORT_REFUSAL_RENEWALS_MAX) {
        this.blocked = true;
        this.deps.journal('GRANT_RENEWAL_LIMIT', { trigger: t, reason: state.grant?.refusedCode ?? null, renewals: this.renewals.length });
        this.setStatus({ phase: 'blocked', code: 'REFUSAL_LIMIT', nextRetryAt: null });
        return;
      }
    }

    this.lastAttemptAt = now;
    this.setStatus({ phase: 'provisioning', code: need, nextRetryAt: null });
    const res = await this.deps.provision();
    if (account !== this.account) return;
    this.deps.journal('GRANT_PROVISION', {
      trigger: t, reason: need, outcome: res.code, detail: res.detail ?? null, attempt: this.attempts,
      grantStatus: state.grantStatus ?? null, storeCode: state.storeCode ?? null,
    });
    if (res.ok) {
      this.attempts = 0;
      this.blocked = false;
      this.clearRetry();
      if (need === 'REFUSED') {
        this.renewals.push(now);
        if (refusedRef) this.renewedRefs.add(refusedRef);
      }
      await this.deps.resume().catch(() => undefined);
      this.setStatus({ phase: 'ready', code: null, nextRetryAt: null });
      try { this.scheduleRenewal(await this.deps.readState()); } catch { /* échéance relue au prochain déclencheur */ }
      return;
    }
    const delay = provisionRetryDelay(res, this.attempts);
    if (delay !== null) {
      this.attempts += 1;
      this.clearRetry();
      const at = this.deps.now() + delay;
      this.retryTimer = this.deps.setTimer(() => { this.retryTimer = null; void this.trigger('retry'); }, delay);
      this.deps.journal('GRANT_RETRY_SCHEDULED', { attempt: this.attempts, delayMs: delay, outcome: res.code });
      this.setStatus({ phase: 'retry_scheduled', code: res.code, nextRetryAt: at });
    } else {
      this.blocked = true;
      this.clearRetry();
      this.setStatus({ phase: 'blocked', code: res.code, nextRetryAt: null });
    }
  }

  private scheduleRenewal(state: NativeShareState): void {
    if (this.renewalTimer) { this.deps.clearTimer(this.renewalTimer); this.renewalTimer = null; }
    const due = renewalDueAt(state.grant);
    if (due === null) return;
    // 1 s après l'entrée dans la fenêtre de renouvellement (jamais moins d'une minute).
    const ms = Math.min(Math.max(due - this.deps.now() + 1000, 60_000), MAX_TIMER_MS);
    this.renewalTimer = this.deps.setTimer(() => { this.renewalTimer = null; void this.trigger('renewal'); }, ms);
  }

  private clearRetry(): void {
    if (this.retryTimer) { this.deps.clearTimer(this.retryTimer); this.retryTimer = null; }
  }

  private clearTimers(): void {
    this.clearRetry();
    if (this.renewalTimer) { this.deps.clearTimer(this.renewalTimer); this.renewalTimer = null; }
  }

  private setStatus(s: ProvisionStatus): void {
    this.status = s;
    this.deps.onStatus(s);
  }
}

/**
 * Texte de la carte d'état pour les imports « En attente » quand l'app est
 * ouverte (pur, testé) : il décrit ce que fait l'app, jamais une déconnexion
 * non vérifiée. Les codes techniques sont affichés à part (recette).
 */
export function provisionNotice(s: ProvisionStatus): string {
  switch (s.phase) {
    case 'checking':
    case 'provisioning':
      return 'Autorisation d’import en cours de renouvellement…';
    case 'retry_scheduled':
      return 'Autorisation d’import momentanément indisponible : nouvel essai automatique.';
    case 'ready':
      return 'Reprise de l’import en cours.';
    case 'blocked':
      switch (s.code) {
        case 'MFA_REQUIRED': return 'Confirmez votre connexion (double authentification) pour terminer l’import.';
        case 'CGUV_REACCEPTANCE_REQUIRED': return 'Acceptez les nouvelles conditions pour terminer l’import.';
        case 'FEATURE_OFF': return 'Le partage vers Verebona est momentanément suspendu : l’import reprendra plus tard.';
        case 'SESSION_UNAVAILABLE': return 'Reconnectez-vous à Verebona pour terminer l’import.';
        case 'KEYCHAIN_WRITE':
        case 'NATIVE_REJECTED': return 'L’autorisation d’import n’a pas pu être enregistrée sur ce téléphone : l’import reprendra à la prochaine ouverture de Verebona.';
        default: return 'L’import reprendra à la prochaine ouverture de Verebona.';
      }
    default:
      return 'L’import reprendra à la prochaine ouverture de Verebona.';
  }
}
