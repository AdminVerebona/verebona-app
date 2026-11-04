/**
 * File technique des partages entrants — lot 108G (CDC 12 IMP-02..06, G0-07 ;
 * ticket « Partage iOS vers Verebona », décision PO du 03/11/2026).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN ÉLÉMENT PAR PARTAGE, GARDÉ JUSQU'À L'IMPORT OU L'ABANDON EXPLICITE
 *
 * Remplace l'ancien `pendingFiles` (mémoire seule : perdu au rechargement ou
 * à la connexion, écrasé par un 2e partage). Sources :
 *   · iOS : l'extension de partage dépose un dossier par partage dans le
 *     groupe d'apps ; plugin local `VerebonaShareInbox` (list / remove) ;
 *   · Android : l'événement `shareReceived` (@capgo/capacitor-share-target)
 *     donne des copies dans le cache privé de l'app ; leurs RÉFÉRENCES (pas
 *     le contenu) sont gardées dans le stockage local de la vue.
 *
 * Règles (pures, testées ci-dessous) :
 *   · jamais deux éléments pour les mêmes fichiers (rejeu d'un événement) ;
 *   · un élément est proposé dans le parcours d'ajout HABITUEL (aperçu,
 *     retrait d'un fichier, confirmation, quotas, envoi, T1) seulement si une
 *     session est ouverte et l'app déverrouillée ;
 *   · isolation par compte : le premier compte à qui un élément est proposé
 *     le « prend » ; un autre compte connecté ensuite ne le voit pas ; à la
 *     déconnexion de ce compte, ses éléments sont effacés du téléphone ;
 *   · effacement des copies locales après ajout confirmé (`success`) ou
 *     abandon explicite (« Abandonner ») ; purge automatique après
 *     `SHARE_INBOX_TTL_MS` (signalée à l'utilisateur) ; au plus
 *     `SHARE_INBOX_MAX_ITEMS` éléments.
 * Ce n'est PAS un mode hors connexion : aucune donnée de compte n'y est
 * stockée, rien n'est consultable sans le serveur.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NATIVE_PLUGINS, nativePlatform, nativePlugin } from './bridge';
import { triageSharedFiles, type SharedFileRef } from './share-in';

/** Durée de conservation d'un partage non importé (7 jours). */
export const SHARE_INBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Nombre maximal d'éléments en attente (le plus ancien au-delà : effacé et signalé). */
export const SHARE_INBOX_MAX_ITEMS = 20;

const ANDROID_KEY = 'verebona:native:share-inbox:android:v1';
const CLAIMS_KEY = 'verebona:native:share-inbox:claims:v1';

export interface InboxFile extends SharedFileRef { size?: number; convertedFrom?: string }
export interface InboxItem {
  id: string;
  source: 'ios' | 'android';
  receivedAt: number;
  files: InboxFile[];
  refused: Array<{ name: string; reason: string }>;
}
/** Élément → compte qui l'a pris (clé de compte opaque, `accountKey`). */
export type InboxClaims = Record<string, string>;

/** Clé de compte (identifiant interne, jamais d'e-mail). */
export function accountKey(userId: number | string | null | undefined): string | null {
  return userId === null || userId === undefined || userId === '' ? null : `u:${String(userId)}`;
}

// ── Règles pures ───────────────────────────────────────────────────────────

/** Éléments visibles pour un compte : non pris, ou pris par lui. */
export function visibleFor(items: readonly InboxItem[], claims: InboxClaims, account: string | null): InboxItem[] {
  if (!account) return [];
  return items.filter((i) => !claims[i.id] || claims[i.id] === account).sort((a, b) => a.receivedAt - b.receivedAt);
}

/** Prochain élément à proposer automatiquement (pas encore présenté pendant ce lancement). */
export function nextToPresent(items: readonly InboxItem[], claims: InboxClaims, account: string | null, presented: ReadonlySet<string>): InboxItem | null {
  return visibleFor(items, claims, account).find((i) => !presented.has(i.id) && i.files.length > 0) ?? null;
}

/** Signature d'un ensemble de fichiers (déduplication des rejeux d'événements). */
export function filesSignature(files: readonly SharedFileRef[]): string {
  return files.map((f) => f.uri).sort().join('\n');
}

/**
 * Ajoute un partage Android (pur) : ignoré s'il est vide ou déjà présent ;
 * purge des éléments expirés ; au-delà du plafond, les plus anciens sortent.
 */
export function addAndroidShare(
  items: readonly InboxItem[], files: unknown, now: number, newId: () => string,
): { items: InboxItem[]; added: InboxItem | null; refused: Array<{ name: string; reason: string }>; dropped: InboxItem[] } {
  const { accepted, refused } = triageSharedFiles(files);
  const { kept, expired } = purgeExpired(items, now);
  if (accepted.length === 0) return { items: kept, added: null, refused, dropped: expired };
  const sig = filesSignature(accepted);
  if (kept.some((i) => filesSignature(i.files) === sig)) return { items: kept, added: null, refused, dropped: expired };
  const added: InboxItem = { id: newId(), source: 'android', receivedAt: now, files: accepted, refused };
  const all = [...kept, added].sort((a, b) => a.receivedAt - b.receivedAt);
  const overflow = all.length > SHARE_INBOX_MAX_ITEMS ? all.slice(0, all.length - SHARE_INBOX_MAX_ITEMS) : [];
  return { items: all.slice(overflow.length), added, refused, dropped: [...expired, ...overflow] };
}

/** Éléments expirés (pur). */
export function purgeExpired(items: readonly InboxItem[], now: number): { kept: InboxItem[]; expired: InboxItem[] } {
  const kept: InboxItem[] = [];
  const expired: InboxItem[] = [];
  for (const i of items) (now - i.receivedAt > SHARE_INBOX_TTL_MS ? expired : kept).push(i);
  return { kept, expired };
}

/** Éléments pris par un compte (à effacer à sa déconnexion). */
export function claimedBy(claims: InboxClaims, account: string): string[] {
  return Object.entries(claims).filter(([, a]) => a === account).map(([id]) => id);
}

/** Validation d'un élément iOS rendu par le plugin (pur). */
export function parseIosItems(raw: unknown): InboxItem[] {
  const list = (raw as { items?: unknown } | null)?.items;
  if (!Array.isArray(list)) return [];
  const out: InboxItem[] = [];
  for (const r of list as Array<Record<string, unknown>>) {
    if (!r || typeof r.id !== 'string' || !/^[A-Fa-f0-9-]{8,64}$/.test(r.id)) continue;
    const { accepted, refused } = triageSharedFiles(r.files);
    const raws = r.files as Array<Record<string, unknown> | null>;
    const files: InboxFile[] = accepted.map((f) => {
      const src = raws.find((x) => x?.uri === f.uri);
      const conv = typeof src?.convertedFrom === 'string' ? src.convertedFrom : undefined;
      const size = typeof src?.size === 'number' ? src.size : undefined;
      return { ...f, ...(size !== undefined ? { size } : {}), ...(conv ? { convertedFrom: conv } : {}) };
    });
    const declared = Array.isArray(r.refused)
      ? (r.refused as Array<Record<string, unknown>>).filter((x) => typeof x?.name === 'string' && typeof x?.reason === 'string').map((x) => ({ name: x.name as string, reason: x.reason as string }))
      : [];
    out.push({ id: r.id, source: 'ios', receivedAt: Number(r.createdAt) || 0, files, refused: [...declared, ...refused] });
  }
  return out;
}

// ── Stockage local (références et attributions, jamais de contenu) ────────

export interface KeyValueStore { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

function browserStore(): KeyValueStore | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

function readJson<T>(store: KeyValueStore | null, key: string, fallback: T): T {
  try { const v = store?.getItem(key); return v ? JSON.parse(v) as T : fallback; } catch { return fallback; }
}
function writeJson(store: KeyValueStore | null, key: string, value: unknown): void {
  try { store?.setItem(key, JSON.stringify(value)); } catch { /* stockage plein ou interdit */ }
}

export function readClaims(store: KeyValueStore | null = browserStore()): InboxClaims {
  const c = readJson<InboxClaims>(store, CLAIMS_KEY, {});
  return c && typeof c === 'object' ? c : {};
}
export function writeClaims(claims: InboxClaims, store: KeyValueStore | null = browserStore()): void {
  writeJson(store, CLAIMS_KEY, claims);
}
export function readAndroidItems(store: KeyValueStore | null = browserStore()): InboxItem[] {
  const v = readJson<InboxItem[]>(store, ANDROID_KEY, []);
  return Array.isArray(v) ? v.filter((i) => i && typeof i.id === 'string' && Array.isArray(i.files)) : [];
}
export function writeAndroidItems(items: InboxItem[], store: KeyValueStore | null = browserStore()): void {
  writeJson(store, ANDROID_KEY, items);
}

// ── Accès natif ────────────────────────────────────────────────────────────

interface ShareInboxPlugin {
  list(o: { maxAgeMs: number }): Promise<unknown>;
  remove(o: { id: string }): Promise<unknown>;
}
interface FilesystemDelete { deleteFile(o: { path: string }): Promise<void> }

/** Lecture de la file (iOS : plugin ; Android : références locales). */
export async function loadInbox(now = Date.now()): Promise<{ items: InboxItem[]; expired: number }> {
  const platform = nativePlatform();
  if (platform === 'ios') {
    const p = nativePlugin<ShareInboxPlugin>(NATIVE_PLUGINS.shareInbox);
    if (!p) return { items: [], expired: 0 };
    try {
      const raw = await p.list({ maxAgeMs: SHARE_INBOX_TTL_MS });
      const expired = Number((raw as { expired?: unknown })?.expired) || 0;
      return { items: parseIosItems(raw), expired };
    } catch {
      return { items: [], expired: 0 };
    }
  }
  if (platform === 'android') {
    const { kept, expired } = purgeExpired(readAndroidItems(), now);
    if (expired.length > 0) {
      writeAndroidItems(kept);
      for (const e of expired) await deleteAndroidCopies(e);
    }
    return { items: kept, expired: expired.length };
  }
  return { items: [], expired: 0 };
}

async function deleteAndroidCopies(item: InboxItem): Promise<void> {
  const fs = nativePlugin<FilesystemDelete>(NATIVE_PLUGINS.filesystem);
  for (const f of item.files) await fs?.deleteFile({ path: f.uri }).catch(() => undefined);
}

/** Ajout d'un partage Android reçu (persistant avant toute autre action). */
export function recordAndroidShare(files: unknown, now = Date.now()): ReturnType<typeof addAndroidShare> {
  const r = addAndroidShare(readAndroidItems(), files, now, () => globalThis.crypto?.randomUUID?.() ?? `${now}-${Math.random().toString(16).slice(2)}`);
  writeAndroidItems(r.items);
  for (const d of r.dropped) void deleteAndroidCopies(d);
  return r;
}

/** Effacement d'un élément (ajout confirmé ou abandon explicite) : copies locales et attribution. */
export async function removeInboxItem(item: InboxItem): Promise<void> {
  if (item.source === 'ios') {
    await nativePlugin<ShareInboxPlugin>(NATIVE_PLUGINS.shareInbox)?.remove({ id: item.id }).catch(() => undefined);
  } else {
    writeAndroidItems(readAndroidItems().filter((i) => i.id !== item.id));
    await deleteAndroidCopies(item);
  }
  const claims = readClaims();
  if (claims[item.id]) { delete claims[item.id]; writeClaims(claims); }
}

/** Attribution d'un élément au compte à qui il est proposé. */
export function claimInboxItem(id: string, account: string): void {
  const claims = readClaims();
  if (claims[id] === account) return;
  if (!claims[id]) { claims[id] = account; writeClaims(claims); }
}

/**
 * Les fichiers d'un élément ont-ils été remis à la file de dépôt ? (pur)
 * Le formulaire d'ajout vide sa sélection et confie les `File` à la file
 * (`lib/upload-queue`, idempotente, avec sa propre reprise) : dès lors,
 * l'élément ne doit plus être proposé (sinon second document).
 */
export function submittedToUploadQueue(
  queued: ReadonlyArray<{ nom: string; taille: number; derniereModif: number; creeLe: number }>,
  files: ReadonlyArray<{ name: string; size: number; lastModified: number }>,
  since: number,
): boolean {
  return files.some((f) => queued.some((q) => q.creeLe >= since && q.nom === f.name && q.taille === f.size && q.derniereModif === f.lastModified));
}
