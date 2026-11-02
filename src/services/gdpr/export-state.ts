/**
 * Export RGPD « Mes données » — états, codes d'erreur stables et message
 * unique présenté à l'utilisateur (lot 103C, ticket P1 « Fiabilisation
 * complète de l'export », §3 F).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL MESSAGE, UNE ACTION SEULEMENT SI ELLE PEUT FONCTIONNER
 *
 * L'écran affichait simultanément l'échec de la génération précédente et
 * l'erreur de la relance (capture iPhone du 31/10). L'état affiché est
 * désormais calculé ici, côté serveur, une fois : `kind` détermine LE
 * message, `canRequest` dit si le bouton « Exporter / Relancer » a un sens.
 * Après plusieurs échecs consécutifs, la relance est remplacée par le
 * contact de l'assistance, avec la référence (identifiant de corrélation).
 *
 * Aucun détail technique ne sort d'ici : le code stable et la référence
 * suffisent au support, qui lit la cause en Supervision.
 *
 * Module PUR (aucune base, aucun import Node) : testé sans base, importable
 * par le composant client.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Codes d'erreur stables (journaux, Supervision, réponse API). */
export const GDPR_EXPORT_ERROR_CODES = [
  /** Le processus s'est arrêté pendant la génération (redémarrage, déploiement, mémoire) à répétition. */
  'GENERATION_INTERRUPTED',
  /** Délai global d'une tentative dépassé. */
  'GENERATION_TIMEOUT',
  /** Lecture des données en base impossible. */
  'COLLECTION_FAILED',
  /** Stockage objet injoignable ou en erreur (lecture des originaux, dépôt de l'archive). */
  'STORAGE_UNAVAILABLE',
  /** Construction de l'archive (ZIP) impossible (disque temporaire, format). */
  'ARCHIVE_FAILED',
  /** Toute autre erreur. */
  'GENERATION_FAILED',
] as const;
export type GdprExportErrorCode = (typeof GDPR_EXPORT_ERROR_CODES)[number];

/** Codes des réponses HTTP de la route (contrat client). */
export const GDPR_EXPORT_API_CODES = {
  requestFailed: 'GDPR_EXPORT_REQUEST_FAILED',
  readFailed: 'GDPR_EXPORT_READ_FAILED',
  invalidKey: 'GDPR_EXPORT_INVALID_REQUEST_KEY',
} as const;

/** Clé d'idempotence acceptée (en-tête `Idempotency-Key`) : 8 à 100 caractères sûrs. */
export function parseClientRequestKey(raw: string | null | undefined): string | null | 'invalid' {
  if (raw == null || raw === '') return null;
  return /^[A-Za-z0-9_.:-]{8,100}$/.test(raw) ? raw : 'invalid';
}


/* ── Paramètres (centralisés, surchargeables par variable Scalingo) ───── */

type Env = Record<string, string | undefined>;
function envInt(env: Env, name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const v = Number(env[name]);
  return Number.isFinite(v) && v >= min && v <= max ? Math.floor(v) : fallback;
}

/** Nombre maximal de tentatives automatiques d'une même demande. */
export const maxAttempts = (env: Env = process.env) => envInt(env, 'GDPR_EXPORT_MAX_ATTEMPTS', 4, 1, 10);
/** Délais avant nouvelle tentative (s) : 1 min, 5 min, 15 min, puis 15 min. */
export const RETRY_DELAYS_SECONDS: readonly number[] = [60, 300, 900];
export function retryDelaySeconds(attempt: number): number {
  const i = Math.max(1, Math.floor(attempt)) - 1;
  return RETRY_DELAYS_SECONDS[Math.min(i, RETRY_DELAYS_SECONDS.length - 1)];
}
/** Échecs consécutifs (demandes entières) au-delà desquels on oriente vers l'assistance. */
export const supportAfterFailures = (env: Env = process.env) => envInt(env, 'GDPR_EXPORT_SUPPORT_AFTER_FAILURES', 2, 1, 20);

/* ── État présenté à l'utilisateur ────────────────────────────────────── */

export type GdprExportViewKind =
  | 'none'          // aucune demande
  | 'in_progress'   // en file, en cours, ou nouvelle tentative automatique programmée
  | 'ready'         // archive COMPLÈTE prête
  | 'partial'       // archive prête mais INCOMPLÈTE (inventaire des manques)
  | 'interrupted'   // échec : nouvelle demande possible
  | 'needs_support' // échecs répétés : contacter l'assistance
  | 'expired';      // archive expirée (supprimée)

export interface GdprExportView {
  kind: GdprExportViewKind;
  /** Le message (unique) à afficher. */
  message: string;
  /** Le bouton « Exporter / Relancer » a-t-il un sens ? */
  canRequest: boolean;
  /** Libellé du bouton quand il est proposé. */
  requestLabel: string | null;
  /** Référence à communiquer au support (échecs seulement). */
  reference: string | null;
  /** Code d'erreur stable (échecs seulement). */
  errorCode: string | null;
}

export interface ExportRowForView {
  status: 'pending' | 'generating' | 'ready' | 'error' | 'expired' | string;
  completeness?: string | null;
  expiresAt?: string | Date | null;
  errorCode?: string | null;
  correlationId?: string | null;
  nextAttemptAt?: string | Date | null;
  /** Nombre d'éléments manquants (archive partielle). */
  missingCount?: number;
}

/** Référence courte et lisible (8 premiers caractères de l'identifiant de corrélation). */
export function shortReference(correlationId: string | null | undefined): string | null {
  if (!correlationId) return null;
  const s = correlationId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase();
  return s.length >= 4 ? s : null;
}

/**
 * État unique à présenter. `consecutiveFailures` : nombre de demandes
 * TERMINÉES EN ÉCHEC consécutives de l'utilisateur (la plus récente incluse).
 */
export function gdprExportView(row: ExportRowForView | null, opts: { now?: Date; consecutiveFailures?: number; env?: Env } = {}): GdprExportView {
  const now = opts.now ?? new Date();
  const base = { reference: null, errorCode: null } as const;
  if (!row) {
    return { ...base, kind: 'none', message: 'Aucune archive n’a encore été préparée.', canRequest: true, requestLabel: 'Exporter mes données' };
  }
  if (row.status === 'pending' || row.status === 'generating') {
    const retrying = row.nextAttemptAt != null && new Date(row.nextAttemptAt).getTime() > now.getTime();
    return {
      ...base,
      kind: 'in_progress',
      message: retrying
        ? 'Préparation de votre archive en cours : une nouvelle tentative automatique est programmée. Vous pouvez quitter cette page, une notification vous préviendra dès qu’elle sera prête.'
        : 'Préparation de votre archive en cours. Vous pouvez quitter cette page : une notification vous préviendra dès qu’elle sera prête.',
      canRequest: false,
      requestLabel: null,
    };
  }
  const expired = row.status === 'expired'
    || (row.status === 'ready' && row.expiresAt != null && new Date(row.expiresAt).getTime() <= now.getTime());
  if (expired) {
    return { ...base, kind: 'expired', message: 'Votre dernière archive a expiré. Demandez-en une nouvelle si besoin.', canRequest: true, requestLabel: 'Exporter mes données' };
  }
  if (row.status === 'ready') {
    if (row.completeness === 'partial') {
      const n = Math.max(0, row.missingCount ?? 0);
      return {
        kind: 'partial',
        message: `Archive prête mais incomplète : ${n > 0 ? `${n} élément(s) n’ont pas pu être inclus` : 'certains éléments n’ont pas pu être inclus'} (liste ci-dessous et dans le fichier manifest.json). Vous pouvez relancer la préparation pour tenter de les récupérer.`,
        canRequest: true,
        requestLabel: 'Relancer pour compléter',
        reference: shortReference(row.correlationId),
        errorCode: null,
      };
    }
    return { ...base, kind: 'ready', message: 'Archive prête.', canRequest: true, requestLabel: 'Générer une nouvelle archive' };
  }
  // Échec.
  const reference = shortReference(row.correlationId);
  const errorCode = row.errorCode ?? 'GENERATION_FAILED';
  if ((opts.consecutiveFailures ?? 1) >= supportAfterFailures(opts.env)) {
    return {
      kind: 'needs_support',
      message: `La préparation de votre archive a échoué à plusieurs reprises malgré les nouvelles tentatives automatiques. Contactez l’assistance${reference ? ` en indiquant la référence ${reference}` : ''} : nous la traiterons pour vous.`,
      canRequest: false,
      requestLabel: null,
      reference,
      errorCode,
    };
  }
  return {
    kind: 'interrupted',
    message: `La préparation de votre dernière archive n’a pas abouti. Vous pouvez relancer la demande${reference ? ` (référence ${reference})` : ''}.`,
    canRequest: true,
    requestLabel: 'Relancer la demande',
    reference,
    errorCode,
  };
}

/* ── Erreurs de la demande (POST) côté client ─────────────────────────── */

/**
 * Message unique d'une demande refusée ou en échec, à partir de ce que le
 * client a VRAIMENT reçu. `status` 0 : pas de réponse (réseau). Une réponse
 * non JSON (page d'erreur d'un proxy, processus arrêté) n'est plus
 * confondue avec « demande non enregistrée » : on ne sait pas si elle l'a
 * été — l'état est relu.
 */
export function requestErrorMessage(input: { status: number; code?: string | null; message?: string | null; requestId?: string | null }): string {
  const ref = shortReference(input.requestId ?? null);
  const suffix = ref ? ` (référence ${ref})` : '';
  switch (input.code) {
    case 'CSRF_ORIGIN_REJECTED':
      return `Requête refusée par sécurité : rechargez la page puis réessayez${suffix}.`;
    case 'APP_UPDATE_REQUIRED':
      return 'Une mise à jour de l’application Verebona est nécessaire pour continuer.';
    case 'UNAUTHORIZED':
    case 'AUTH_REQUIRED':
    case 'INVALID_TOKEN':
      return 'Votre session a expiré. Reconnectez-vous puis réessayez.';
    case 'ACCOUNT_SUSPENDED':
      return 'Votre compte est suspendu : l’export n’est pas disponible.';
    case 'REQUEST_TIMEOUT':
    case 'NETWORK_ERROR':
      return 'Connexion interrompue : nous vérifions si votre demande a bien été reçue.';
    case 'INVALID_RESPONSE':
    case 'UNKNOWN_ERROR':
      return `Le service n’a pas répondu correctement. Nous vérifions si votre demande a bien été reçue${suffix}.`;
    default:
      break;
  }
  if (input.status >= 500 || input.status === 0) {
    return `Le service est momentanément indisponible. Réessayez dans quelques minutes${suffix}.`;
  }
  return (input.message && input.message.trim()) ? `${input.message.trim()}${suffix && !input.message.includes('référence') ? suffix : ''}` : `Votre demande n’a pas pu être traitée${suffix}.`;
}
