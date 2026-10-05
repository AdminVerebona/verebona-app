/**
 * Contrat de dépôt — limites de taille et de nombre (APP-PERF-28).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE SOURCE POUR LE CLIENT, LE PRESIGN ET LA CONFIRMATION
 *
 * Les valeurs vivaient en trois copies : `presign` acceptait une vidéo de
 * 500 Mo, alors que la confirmation (et le dialogue) plafonnaient le dépôt à
 * 100 Mo — un fichier pouvait être annoncé autorisé, transféré en entier,
 * puis refusé à la confirmation. Ce module est importé par :
 *   · le dialogue de dépôt et la file de transfert (refus AVANT transfert) ;
 *   · `POST /api/files/presign` (refus avant URL signée) ;
 *   · `POST /api/files/confirm` (refus avant COMPLETED, appel direct compris).
 *
 * Aucune dépendance serveur : il est embarqué tel quel dans le navigateur.
 *
 * ── ARBITRAGE VIDÉO (à valider par le produit) ─────────────────────────────
 * Le plafond vidéo de 500 Mo n'a jamais été utilisable : le dialogue refusait
 * tout dépôt de plus de 100 Mo et la confirmation aussi. Le contrat retient
 * donc la limite RÉELLEMENT praticable aujourd'hui, 100 Mo, sans l'augmenter
 * ni retirer une capacité qui fonctionnait. Relever ce plafond se fait ICI,
 * en un seul endroit, et suppose de relever `TAILLE_MAX_LOT` en même temps
 * (invariant vérifié par les tests : un fichier autorisé seul tient toujours
 * dans un lot).
 *
 * Capacité de stockage (plafond du compte, `storage-quota.ts`) et nombre de
 * documents de l'offre (`canAddDocument`) restent des contrôles serveur
 * distincts : ils dépendent du compte, pas du fichier.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { ALLOWED_MIME_TYPES } from '@/lib/file-validation';

/** Version du contrat — à incrémenter avec les messages si une valeur change. */
export const CONTRAT_DEPOT_VERSION = 2;

/**
 * Document analysé : contrainte du fournisseur d'analyse (Gemini plafonne
 * autour de 20 Mo pour un PDF). Au-delà, l'analyse échouerait après transfert.
 */
export const TAILLE_MAX_DOCUMENT = 25_000_000;
/** Vidéo (non analysée) — voir l'arbitrage en en-tête. */
export const TAILLE_MAX_VIDEO = 100_000_000;
/** Documents par dépôt — au-delà, la mémoire du conteneur souffre. */
export const MAX_DOCUMENTS_PAR_DEPOT = 10;
/** Taille cumulée d'un dépôt. */
export const TAILLE_MAX_LOT = 100_000_000;
/** Limites techniques du compte et du bien (serveur). */
export const MAX_FICHIERS_COMPTE = 1000;
export const MAX_FICHIERS_PAR_BIEN = 100;

export function estVideo(mimeType: string | null | undefined): boolean {
  return typeof mimeType === 'string' && mimeType.startsWith('video/');
}

/** Plafond applicable à un fichier selon son type. */
export function tailleMaxPour(mimeType: string | null | undefined): number {
  return estVideo(mimeType) ? TAILLE_MAX_VIDEO : TAILLE_MAX_DOCUMENT;
}

/** « 25 Mo » — unités décimales, comme les constantes (1 Mo = 10⁶ octets). */
export function enMo(octets: number): string {
  const mo = octets / 1_000_000;
  return `${Number.isInteger(mo) ? mo : mo.toFixed(1).replace('.', ',')} Mo`;
}

export type CodeRefusFichier = 'INVALID_SIZE' | 'FILE_EMPTY' | 'FILE_TOO_LARGE' | 'INVALID_MIME_TYPE';

export interface RefusFichier {
  code: CodeRefusFichier;
  message: string;
  /** Plafond applicable, en octets (FILE_TOO_LARGE). */
  max?: number;
}

/**
 * Contrôle d'un fichier seul (taille exacte en octets, type).
 * `null` : fichier conforme au contrat. Le plafond est INCLUS (25 000 000
 * octets passent, 25 000 001 sont refusés).
 */
export function verifierFichier(size: unknown, mimeType: string | null | undefined): RefusFichier | null {
  const n = typeof size === 'string' && size.trim() !== '' ? Number(size) : size;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) {
    return { code: 'INVALID_SIZE', message: 'La taille du fichier est invalide.' };
  }
  if (n === 0) {
    return { code: 'FILE_EMPTY', message: 'Les fichiers vides (0 octet) sont refusés.' };
  }
  if (!mimeType || !ALLOWED_MIME_TYPES.includes(mimeType)) {
    return {
      code: 'INVALID_MIME_TYPE',
      message: 'Type de fichier non pris en charge. Formats acceptés : PDF, images (JPEG, PNG, WebP, GIF), Word, Excel, texte, vidéos.',
    };
  }
  const max = tailleMaxPour(mimeType);
  if (n > max) {
    return {
      code: 'FILE_TOO_LARGE',
      max,
      message: estVideo(mimeType)
        ? `Vidéo trop volumineuse (maximum ${enMo(max)}).`
        : `Document trop volumineux (maximum ${enMo(max)}). Au-delà, l'analyse automatique échouerait.`,
    };
  }
  return null;
}

/** Refus d'un lot entier (nombre ou taille cumulée). */
export function verifierLot(tailles: number[]): { code: 'TOO_MANY_FILES' | 'BATCH_TOO_LARGE'; message: string; max: number; provided: number } | null {
  if (tailles.length > MAX_DOCUMENTS_PAR_DEPOT) {
    return {
      code: 'TOO_MANY_FILES',
      message: `Vous pouvez déposer ${MAX_DOCUMENTS_PAR_DEPOT} documents à la fois. Ce dépôt en contient ${tailles.length}.`,
      max: MAX_DOCUMENTS_PAR_DEPOT,
      provided: tailles.length,
    };
  }
  const cumul = tailles.reduce((t, s) => t + s, 0);
  if (cumul > TAILLE_MAX_LOT) {
    return {
      code: 'BATCH_TOO_LARGE',
      message: `Ce dépôt pèse ${enMo(cumul)}. Le maximum est de ${enMo(TAILLE_MAX_LOT)} par dépôt.`,
      max: TAILLE_MAX_LOT,
      provided: cumul,
    };
  }
  return null;
}

export interface FichierCandidat {
  name: string;
  size: number;
  /** Type normalisé (voir `normalizeMimeType`). */
  mimeType: string;
}

export interface TriDepot<T> {
  retenus: T[];
  /** Fichiers refusés un par un, avec leur motif. */
  refuses: Array<{ fichier: T; refus: RefusFichier }>;
  /** Écartés parce que le nombre maximal de documents est atteint. */
  horsNombre: T[];
  /** Écartés parce que la taille cumulée dépasserait le plafond du lot. */
  horsLot: T[];
}

/**
 * Tri des fichiers proposés pour un dépôt, dans l'ordre : contrôle unitaire,
 * nombre, puis taille cumulée — appliqué à TOUTES les entrées (sélecteur,
 * glisser-déposer, appareil photo, fichier initial du menu mobile).
 */
export function trierFichiersPourDepot<T>(
  dejaRetenus: FichierCandidat[],
  nouveaux: T[],
  decrire: (f: T) => FichierCandidat,
): TriDepot<T> {
  const tri: TriDepot<T> = { retenus: [], refuses: [], horsNombre: [], horsLot: [] };
  let nombre = dejaRetenus.length;
  let cumul = dejaRetenus.reduce((t, f) => t + f.size, 0);
  for (const f of nouveaux) {
    const d = decrire(f);
    const refus = verifierFichier(d.size, d.mimeType);
    if (refus) { tri.refuses.push({ fichier: f, refus }); continue; }
    if (nombre >= MAX_DOCUMENTS_PAR_DEPOT) { tri.horsNombre.push(f); continue; }
    if (cumul + d.size > TAILLE_MAX_LOT) { tri.horsLot.push(f); continue; }
    nombre += 1;
    cumul += d.size;
    tri.retenus.push(f);
  }
  return tri;
}

/** Valeur `accept` des sélecteurs de fichiers, dérivée du contrat. */
export const ACCEPT_DEPOT = ['image/*', ...ALLOWED_MIME_TYPES.filter((m) => !m.startsWith('image/'))].join(',');
