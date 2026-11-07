/**
 * Récupération d'un fichier d'export du BO — lot 113T (Trello #718, P1).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE BOUTON « TÉLÉCHARGER JSON » OUVRAIT UNE PAGE DE TEXTE BRUT SUR IPHONE
 *
 * Les exports JSON du BO étaient de simples liens vers la route d'API
 * (`<a href="…/export?download=1">`) ou un `Blob` + `<a download>`. Dans
 * l'application iOS, la vue WKWebView de Capacitor n'implémente ni
 * `decidePolicyForNavigationResponse` ni `WKDownloadDelegate` : WebKit
 * AFFICHE alors toute réponse qu'il sait montrer (application/json) au lieu
 * de la télécharger — l'en-tête `Content-Disposition: attachment` est ignoré —
 * et la vue, sans barre d'adresse ni bouton retour, reste sur le JSON brut.
 * Un lien `blob:` y est traité de même. Safari iOS / l'app web installée
 * n'offrent pas non plus de parcours fiable « Enregistrer dans Fichiers ».
 *
 * Désormais (un seul parcours pour tous les exports du BO) :
 *   1. `fetchExportFile` : lecture AUTHENTIFIÉE (cookie de session, jamais de
 *      jeton dans l'URL), renouvellement de session une fois sur 401, contrôle
 *      du statut, du Content-Type et — pour du JSON — de la validité du
 *      contenu : une erreur n'est JAMAIS enregistrée comme fichier ;
 *   2. `deliverFile` : remise du fichier lui-même —
 *        · app iOS / Android : fichier écrit dans le cache de l'app (plugin
 *          `Filesystem`) puis feuille de partage NATIVE avec ce fichier
 *          (plugin `Share`, option `files`) : « Enregistrer dans Fichiers »,
 *          Mail, AirDrop… Plugins déjà embarqués par la coque ;
 *        · navigateur mobile (tactile) qui sait partager ce fichier
 *          (`navigator.canShare({ files })`, Safari iOS / app web installée) :
 *          Web Share API niveau 2 ;
 *        · sinon (ordinateur…) : téléchargement `<a download>` d'un Blob.
 *      Fermer la feuille de partage = `cancelled` (aucun message, BO intact).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { clientPlatformHeaders } from '@/lib/client-platform';
import { NATIVE_PLUGINS, isNativeApp, nativePlugin } from '@/lib/native/bridge';
import { isCancel } from '@/lib/native/share';
import { fileNameFromDisposition } from './export-file-name';

export type ExportErrorCode =
  | 'SESSION_EXPIRED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'SERVER_ERROR'
  | 'INVALID_RESPONSE' | 'NETWORK' | 'ABORTED' | 'SHARE_FAILED' | 'UNAVAILABLE';

/** Messages affichés (textes à valider par le PO — lot 113T). */
export const EXPORT_MESSAGES: Record<ExportErrorCode, string> = {
  SESSION_EXPIRED: 'Session expirée : reconnectez-vous puis relancez l’export. Aucun fichier n’a été enregistré.',
  FORBIDDEN: 'Accès refusé à cet export.',
  NOT_FOUND: 'Export introuvable.',
  CONFLICT: 'Export pas encore disponible.',
  SERVER_ERROR: 'L’export n’a pas pu être généré (erreur serveur). Réessayez dans un instant.',
  INVALID_RESPONSE: 'Réponse inattendue du serveur : aucun fichier n’a été enregistré.',
  NETWORK: 'Connexion impossible : aucun fichier n’a été enregistré. Vérifiez la connexion puis réessayez.',
  ABORTED: 'Préparation interrompue.',
  SHARE_FAILED: 'Le fichier est prêt mais n’a pas pu être transmis à la feuille de partage. Réessayez.',
  UNAVAILABLE: 'Enregistrement de fichier indisponible dans cette version de l’application : mettez-la à jour ou utilisez un navigateur.',
};

export class ExportError extends Error {
  constructor(readonly code: ExportErrorCode, message?: string, readonly status = 0) {
    super(message || EXPORT_MESSAGES[code]);
    this.name = 'ExportError';
  }
}

export type ExportKind = 'json' | 'csv';

const CONTENT_TYPES: Record<ExportKind, RegExp> = {
  json: /^application\/([a-z0-9.+-]+\+)?json\b/i,
  csv: /^text\/csv\b/i,
};
const BLOB_TYPES: Record<ExportKind, string> = { json: 'application/json', csv: 'text/csv;charset=utf-8' };

export interface FetchExportDeps {
  fetch?: typeof fetch;
  /** Renouvellement de session (POST /api/auth/refresh) : true si renouvelée. */
  refresh?: () => Promise<boolean | 'server_error'>;
}

export interface ExportFile { blob: Blob; fileName: string; bytes: number }

function withExtension(name: string, ext: string): string {
  return name.toLowerCase().endsWith(`.${ext}`) ? name : `${name}.${ext}`;
}

async function defaultRefresh(): Promise<boolean | 'server_error'> {
  const { apiClient } = await import('@/lib/api-client');
  return apiClient.refreshToken();
}

async function errorMessage(res: Response): Promise<string | undefined> {
  try {
    const body = await res.clone().json() as { message?: unknown; error?: unknown };
    const m = typeof body?.message === 'string' ? body.message : typeof body?.error === 'string' && /\s/.test(body.error) ? body.error : undefined;
    return m && m.length <= 300 ? m : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Lecture authentifiée d'un export : rend le fichier seulement si la réponse
 * est 200, du type attendu et (JSON) complète. Lève `ExportError` sinon.
 */
export async function fetchExportFile(
  url: string,
  opts: { kind?: ExportKind; fallbackName: string; signal?: AbortSignal },
  deps: FetchExportDeps = {},
): Promise<ExportFile> {
  const kind = opts.kind ?? 'json';
  const doFetch = deps.fetch ?? ((u: RequestInfo | URL, i?: RequestInit) => fetch(u, i));
  const refresh = deps.refresh ?? defaultRefresh;
  const init: RequestInit = {
    method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'follow', signal: opts.signal,
    headers: { Accept: kind === 'json' ? 'application/json' : 'text/csv', ...clientPlatformHeaders() },
  };
  let res: Response;
  try {
    res = await doFetch(url, init);
    if (res.status === 401) {
      const renewed = await refresh().catch(() => false);
      if (renewed === 'server_error') throw new ExportError('SERVER_ERROR', undefined, 503);
      if (renewed !== true) throw new ExportError('SESSION_EXPIRED', undefined, 401);
      res = await doFetch(url, init);
    }
  } catch (e) {
    if (e instanceof ExportError) throw e;
    if ((e as { name?: string })?.name === 'AbortError') throw new ExportError('ABORTED');
    throw new ExportError('NETWORK');
  }
  if (res.status === 401) throw new ExportError('SESSION_EXPIRED', undefined, 401);
  if (!res.ok) {
    const m = await errorMessage(res);
    const code: ExportErrorCode = res.status === 403 ? 'FORBIDDEN' : res.status === 404 ? 'NOT_FOUND' : res.status === 409 ? 'CONFLICT' : 'SERVER_ERROR';
    throw new ExportError(code, code === 'SERVER_ERROR' ? undefined : m, res.status);
  }
  const type = res.headers.get('content-type') ?? '';
  if (!CONTENT_TYPES[kind].test(type.trim())) {
    // Page de connexion servie à la place de l'export (redirection) : session perdue.
    if (res.redirected && /\/login(\b|\/|\?)/.test(res.url)) throw new ExportError('SESSION_EXPIRED', undefined, 401);
    throw new ExportError('INVALID_RESPONSE', undefined, res.status);
  }
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') throw new ExportError('ABORTED');
    throw new ExportError('NETWORK');
  }
  if (kind === 'json') {
    try { JSON.parse(text); } catch { throw new ExportError('INVALID_RESPONSE', undefined, res.status); }
  }
  const fileName = withExtension(fileNameFromDisposition(res.headers.get('content-disposition')) ?? opts.fallbackName, kind);
  const blob = new Blob([text], { type: BLOB_TYPES[kind] });
  return { blob, fileName, bytes: blob.size };
}

// ══════════════════════════════════════════════════════════════════════════
// Remise du fichier
// ══════════════════════════════════════════════════════════════════════════

export type DeliveryChannel = 'native-share' | 'web-share' | 'download' | 'unavailable';
export type DeliveryOutcome = 'shared' | 'downloaded' | 'cancelled' | 'needs-gesture';

interface NativeFiles {
  writeFile(o: { path: string; data: string; directory: string; encoding?: string; recursive?: boolean }): Promise<{ uri: string }>;
  rmdir?(o: { path: string; directory: string; recursive?: boolean }): Promise<unknown>;
}
interface NativeShare { share(o: { title?: string; files?: string[]; dialogTitle?: string }): Promise<unknown> }

export interface DeliveryEnv {
  /** Dans l'application iOS / Android (coque Capacitor). */
  isNative: boolean;
  nativeFiles: NativeFiles | null;
  nativeShare: NativeShare | null;
  webShare: ((d: ShareData) => Promise<void>) | null;
  webCanShare: ((d: ShareData) => boolean) | null;
  /** Appareil tactile (téléphone, tablette) : le partage y remplace le téléchargement. */
  touch: boolean;
  download: (blob: Blob, fileName: string) => void;
}

/** Téléchargement navigateur d'un Blob (lien `download` éphémère). */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Délai large : Safari iOS lit l'URL après le clic.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function browserDeliveryEnv(): DeliveryEnv {
  const nav = typeof navigator !== 'undefined' ? navigator as Navigator & { canShare?: (d: ShareData) => boolean } : null;
  let touch = false;
  try {
    touch = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)')?.matches && (nav?.maxTouchPoints ?? 0) > 0;
  } catch { touch = false; }
  return {
    isNative: isNativeApp(),
    nativeFiles: nativePlugin<NativeFiles>(NATIVE_PLUGINS.filesystem),
    nativeShare: nativePlugin<NativeShare>(NATIVE_PLUGINS.share),
    webShare: nav && typeof nav.share === 'function' ? (d) => nav.share(d) : null,
    webCanShare: nav && typeof nav.canShare === 'function' ? (d) => nav.canShare!(d) : null,
    touch,
    download: downloadBlob,
  };
}

function fileOf(blob: Blob, fileName: string): File | null {
  try {
    return new File([blob], fileName, { type: blob.type || 'application/octet-stream' });
  } catch {
    return null;
  }
}

/** Canal choisi pour remettre ce fichier dans cet environnement. Pur. */
export function chooseDeliveryChannel(file: File | null, env: DeliveryEnv): DeliveryChannel {
  if (env.isNative) {
    return env.nativeFiles && typeof env.nativeFiles.writeFile === 'function' && env.nativeShare && typeof env.nativeShare.share === 'function'
      ? 'native-share' : 'unavailable';
  }
  if (env.touch && file && env.webShare && env.webCanShare) {
    try {
      if (env.webCanShare({ files: [file] })) return 'web-share';
    } catch { /* repli : téléchargement */ }
  }
  return 'download';
}

/** Feuille de partage fermée par l'utilisateur — même règle que le partage sortant existant (lot 100D). */
export const isShareCancel = isCancel;

const TEXT_TYPE = /^(text\/|application\/([a-z0-9.+-]+\+)?json)/i;

async function nativeData(blob: Blob): Promise<{ data: string; encoding?: string }> {
  if (TEXT_TYPE.test(blob.type)) return { data: await blob.text(), encoding: 'utf8' };
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { data: btoa(bin) };
}

/** Dossier du cache de l'app où sont posés les fichiers à partager (vidé à chaque export). */
export const NATIVE_EXPORT_DIR = 'exports-verebona';

/**
 * Remet le fichier à l'utilisateur. Rend `cancelled` si la feuille de partage
 * est fermée, `needs-gesture` si le navigateur exige un nouveau geste avant
 * de partager (délai de préparation trop long) — l'appelant propose alors un
 * bouton « Partager le fichier », ou passe `onNeedsGesture: 'download'`.
 */
export async function deliverFile(
  blob: Blob,
  fileName: string,
  opts: { title?: string; onNeedsGesture?: 'report' | 'download' } = {},
  env: DeliveryEnv = browserDeliveryEnv(),
): Promise<{ outcome: DeliveryOutcome; channel: DeliveryChannel }> {
  const file = fileOf(blob, fileName);
  const channel = chooseDeliveryChannel(file, env);
  if (channel === 'unavailable') throw new ExportError('UNAVAILABLE');

  if (channel === 'native-share') {
    let uri: string;
    try {
      await env.nativeFiles!.rmdir?.({ path: NATIVE_EXPORT_DIR, directory: 'CACHE', recursive: true }).catch(() => undefined);
      const { data, encoding } = await nativeData(blob);
      ({ uri } = await env.nativeFiles!.writeFile({
        path: `${NATIVE_EXPORT_DIR}/${fileName}`, data, directory: 'CACHE', recursive: true, ...(encoding ? { encoding } : {}),
      }));
    } catch {
      throw new ExportError('SHARE_FAILED');
    }
    try {
      await env.nativeShare!.share({ title: opts.title ?? fileName, files: [uri], dialogTitle: opts.title ?? fileName });
      return { outcome: 'shared', channel };
    } catch (e) {
      if (isShareCancel(e)) return { outcome: 'cancelled', channel };
      throw new ExportError('SHARE_FAILED');
    }
  }

  if (channel === 'web-share') {
    try {
      await env.webShare!({ files: [file!], title: opts.title ?? fileName });
      return { outcome: 'shared', channel };
    } catch (e) {
      if (isShareCancel(e)) return { outcome: 'cancelled', channel };
      if ((e as { name?: string })?.name === 'NotAllowedError') {
        if (opts.onNeedsGesture === 'download') {
          env.download(blob, fileName);
          return { outcome: 'downloaded', channel: 'download' };
        }
        return { outcome: 'needs-gesture', channel };
      }
      // Partage refusé pour une autre raison : téléchargement classique.
      env.download(blob, fileName);
      return { outcome: 'downloaded', channel: 'download' };
    }
  }

  env.download(blob, fileName);
  return { outcome: 'downloaded', channel };
}
