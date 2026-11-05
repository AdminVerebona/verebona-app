/**
 * Partage natif vers Verebona — contrat unique iOS / Android (lot 110A,
 * décision PO du 04/11/2026, ticket « Partage natif : trois choix »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SOURCE UNIQUE (module PUR, sans accès base : serveur, interface, tests)
 *
 *   · Interface native de réception : exactement trois choix —
 *       « Importer et ouvrir Verebona », « Importer sans ouvrir », « Annuler ».
 *     Les choix 1 et 2 lancent l'import SANS seconde confirmation. Sur iOS,
 *     le choix 1 n'est PAS proposé tant qu'aucune API publique ne permet à
 *     une extension de partage d'ouvrir l'application (voir
 *     docs/mobile/partage-natif-110a.md § 4 et `mobile/config/environments.mjs`
 *     › SHARE_IMPORT, point unique de bascule après arbitrage PO).
 *   · Une seule opération d'import serveur : la route
 *     `/api/mobile/share-import/upload` enchaîne les MÊMES traitements que le
 *     dépôt de l'application (`/api/files/presign` puis `/api/files/confirm` :
 *     validations, quotas, droits, idempotence par `operationId`, T1).
 *   · Jeton d'import (« jeton de dépôt partagé ») : dérivé d'une session
 *     ouverte (garde de session actuelle), import SEUL, un compte, durée
 *     courte, nombre d'usages borné, révocable, aucune lecture possible.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { MAX_DOCUMENTS_PAR_DEPOT, TAILLE_MAX_DOCUMENT } from '@/lib/upload-limits';

/** Libellés validés par le PO (04/11/2026) — identiques sur iOS et Android. */
export const SHARE_IMPORT_LABELS = Object.freeze({
  importAndOpen: 'Importer et ouvrir Verebona',
  importOnly: 'Importer sans ouvrir',
  cancel: 'Annuler',
});

/** Statuts FIDÈLES affichés (jamais « ajouté » avant l'accusé serveur). */
export const SHARE_IMPORT_STATUS_LABELS = Object.freeze({
  queued: 'Importation en cours',
  uploading: 'Importation en cours',
  waiting_network: 'En attente de connexion',
  waiting_auth: 'En attente de connexion',
  imported: 'Document ajouté',
  failed: 'Échec de l’import',
});
export type ShareImportFileState = keyof typeof SHARE_IMPORT_STATUS_LABELS;

/** Préfixe du jeton d'import (repérable dans un journal par erreur, jamais une session). */
export const SHARE_IMPORT_TOKEN_PREFIX = 'vbsi_';
/** Jeton : préfixe + 32 octets aléatoires en base64url (43 caractères). */
export const SHARE_IMPORT_TOKEN_PATTERN = /^vbsi_[A-Za-z0-9_-]{43}$/;

/**
 * Durée de validité d'un jeton d'import : 72 h. Assez pour partager sans
 * rouvrir l'app pendant quelques jours ; au-delà, le partage reste sur le
 * téléphone « En attente de connexion » et se termine à la prochaine
 * ouverture de Verebona (aucune nouvelle sélection, aucune confirmation).
 * Variable Scalingo facultative : MOBILE_SHARE_IMPORT_GRANT_TTL_HOURS (1 à 168).
 */
export const SHARE_IMPORT_GRANT_TTL_HOURS_DEFAULT = 72;
export const SHARE_IMPORT_GRANT_TTL_HOURS_MAX = 168;
/** Le jeton est renouvelé par l'app quand il lui reste moins de 24 h. */
export const SHARE_IMPORT_GRANT_RENEW_BEFORE_MS = 24 * 60 * 60 * 1000;
/** Nombre maximal de requêtes d'import par jeton (rejeux compris). */
export const SHARE_IMPORT_GRANT_MAX_USES = 100;

/** Fichiers par partage : comme le dépôt de l'application. */
export const SHARE_IMPORT_MAX_FILES = MAX_DOCUMENTS_PAR_DEPOT;
/** Taille maximale d'un fichier partagé (document analysé). */
export const SHARE_IMPORT_MAX_BYTES = TAILLE_MAX_DOCUMENT;
/** Conservation sur le téléphone d'un partage non abouti (puis purge signalée). */
export const SHARE_IMPORT_LOCAL_TTL_DAYS = 7;

/**
 * Formats acceptés par le partage = formats DOCUMENTAIRES acceptés par le
 * serveur (`lib/file-validation.ts › ALLOWED_MIME_TYPES`). Les vidéos, admises
 * par le dépôt manuel (100 Mo), ne sont pas proposées au partage : transfert
 * de fond lourd, aucun traitement T1. Contrôlé par test contre le serveur et
 * contre les listes natives (Swift, Java, AndroidManifest, Info.plist).
 */
export const SHARE_IMPORT_TYPES = Object.freeze([
  { mime: 'application/pdf', ext: 'pdf', uti: 'com.adobe.pdf' },
  { mime: 'image/jpeg', ext: 'jpg', uti: 'public.jpeg' },
  { mime: 'image/png', ext: 'png', uti: 'public.png' },
  { mime: 'image/webp', ext: 'webp', uti: 'org.webmproject.webp' },
  { mime: 'image/gif', ext: 'gif', uti: 'com.compuserve.gif' },
  { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx', uti: 'org.openxmlformats.wordprocessingml.document' },
  { mime: 'application/msword', ext: 'doc', uti: 'com.microsoft.word.doc' },
  { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx', uti: 'org.openxmlformats.spreadsheetml.sheet' },
  { mime: 'application/vnd.ms-excel', ext: 'xls', uti: 'com.microsoft.excel.xls' },
  { mime: 'text/plain', ext: 'txt', uti: 'public.plain-text' },
  { mime: 'text/csv', ext: 'csv', uti: 'public.comma-separated-values-text' },
] as const);

/**
 * Photos HEIC / HEIF (format par défaut de l'appareil photo iPhone, et de
 * nombreux Android récents) : NON acceptées par le serveur. Stratégie
 * explicite, identique sur les deux OS : conversion en JPEG SUR LE TÉLÉPHONE
 * avant l'envoi (qualité maximale, orientation appliquée), signalée dans
 * l'interface de réception (« photo HEIC convertie en JPEG »). Conversion
 * impossible (Android < 9) : refus avec le nom et le motif, jamais en silence.
 */
export const SHARE_IMPORT_HEIC_STRATEGY = 'convert-to-jpeg' as const;
export const SHARE_IMPORT_HEIC_MIMES = Object.freeze(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);

export function isShareImportMime(mime: string | null | undefined): boolean {
  const m = (mime ?? '').toLowerCase();
  return SHARE_IMPORT_TYPES.some((t) => t.mime === m);
}

/** Clé de compte d'un partage (identifiants internes, jamais d'e-mail). */
export function shareImportAccountKey(userId: number, accountId: number): string {
  return `u${userId}-a${accountId}`;
}

// ── Réponses de la route d'import : catégories stables (lues par le natif) ──

/**
 * `imported` : document enregistré (accusé serveur) ; `refused` : refus
 * DÉFINITIF (format, taille, quota, droits) — le fichier local est purgé et
 * la cause affichée ; `auth` : jeton absent/expiré/révoqué, session close,
 * CGUV à accepter — le fichier reste « En attente de connexion » jusqu'au
 * prochain jeton ; `retry` : incident passager (réseau, stockage, 5xx) —
 * nouvel essai automatique (même `operationId`, aucun doublon).
 */
export type ShareImportOutcome = 'imported' | 'refused' | 'auth' | 'retry';

export interface ShareImportResponseBody {
  outcome: ShareImportOutcome;
  code: string;
  message: string;
  operationId?: string;
  fileId?: number;
  replay?: boolean;
}

/** Messages utilisateur (français simple) des codes de refus connus. */
const MESSAGES: Record<string, string> = {
  GRANT_INVALID: 'Connexion à Verebona nécessaire : ouvrez l’application pour terminer l’import.',
  GRANT_EXPIRED: 'Connexion à Verebona nécessaire : ouvrez l’application pour terminer l’import.',
  GRANT_REVOKED: 'Connexion à Verebona nécessaire : ouvrez l’application pour terminer l’import.',
  GRANT_EXHAUSTED: 'Connexion à Verebona nécessaire : ouvrez l’application pour terminer l’import.',
  SESSION_REVOKED: 'Votre session Verebona est terminée : reconnectez-vous pour terminer l’import.',
  ACCOUNT_ACCESS_REVOKED: 'Vous n’avez plus accès à cet espace Verebona : le document n’a pas été importé.',
  ACCOUNT_READ_ONLY: 'Cet espace Verebona est en lecture seule : le document n’a pas été importé.',
  MFA_REQUIRED: 'Reconnectez-vous à Verebona avec la double authentification pour terminer l’import.',
  ACCOUNT_SUSPENDED: 'Compte Verebona indisponible : le document n’a pas été importé.',
  ACCOUNT_PENDING_DELETION: 'Compte Verebona en cours de suppression : le document n’a pas été importé.',
  CGUV_REACCEPTANCE_REQUIRED: 'Ouvrez Verebona pour accepter les nouvelles conditions : l’import reprendra ensuite.',
  FEATURE_OFF: 'Le partage vers Verebona est momentanément suspendu : l’import reprendra plus tard.',
  INVALID_MIME_TYPE: 'Format non pris en charge par Verebona.',
  EXTENSION_MIME_MISMATCH: 'Le type du fichier ne correspond pas à son extension.',
  INVALID_FILENAME: 'Nom de fichier non accepté.',
  FILE_TOO_LARGE: 'Fichier trop volumineux (25 Mo au plus).',
  EMPTY_FILE: 'Fichier vide.',
  INTEGRITY_MISMATCH: 'Le fichier reçu est incomplet ou altéré : nouvel essai automatique.',
  DOCUMENT_QUOTA_REACHED: 'Nombre maximal de documents atteint pour votre offre.',
  STORAGE_QUOTA_EXCEEDED: 'Espace de stockage de votre compte plein.',
  ACCOUNT_FILE_QUOTA_EXCEEDED: 'Nombre maximal de fichiers atteint.',
  IDEMPOTENCY_KEY_REUSED: 'Import incohérent : partagez de nouveau le document.',
  RATE_LIMIT_EXCEEDED: 'Trop d’envois en même temps : nouvel essai automatique.',
  STORAGE_UNAVAILABLE: 'Stockage momentanément indisponible : nouvel essai automatique.',
  INTERNAL_ERROR: 'Incident Verebona : nouvel essai automatique.',
};

export function shareImportMessage(code: string, fallback?: string | null): string {
  return MESSAGES[code] ?? (fallback && /[àâçéèêëîïôûùüÿœ’]|\b(le|la|les|de|du|un|une)\b/i.test(fallback) ? fallback : 'Le document n’a pas pu être importé.');
}

/**
 * Catégorie d'une réponse des étapes de dépôt (presign / confirm) — pur, testé.
 * Les refus de contrat (4xx) sont définitifs ; 401, 409 « objet absent »,
 * 429 et 5xx ne le sont pas.
 */
export function classifyDepotStatus(status: number, code: string | null | undefined): ShareImportOutcome {
  if (status >= 200 && status < 300) return 'imported';
  if (status === 401) return 'auth';
  if (code === 'CGUV_REACCEPTANCE_REQUIRED' || code === 'SESSION_UNAVAILABLE') return code === 'SESSION_UNAVAILABLE' ? 'retry' : 'auth';
  if (status === 409 && code === 'OBJECT_MISSING') return 'retry';
  if (status === 429 || status >= 500) return 'retry';
  return 'refused';
}

/** Statut HTTP de la réponse d'import selon la catégorie (lu aussi par le natif). */
export function outcomeHttpStatus(outcome: ShareImportOutcome, replay = false): number {
  switch (outcome) {
    case 'imported': return replay ? 200 : 201;
    case 'auth': return 401;
    case 'retry': return 503;
    default: return 422;
  }
}
