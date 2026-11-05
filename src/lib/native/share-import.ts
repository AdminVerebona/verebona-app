/**
 * Partage natif vers Verebona : côté interface (vue web de l'app) — lot 110A.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * L'IMPORT EST FAIT PAR LE NATIF ; L'INTERFACE NE FAIT QUE TROIS CHOSES
 *
 *   1. Remettre au natif le JETON D'IMPORT de la session ouverte
 *      (`POST /api/mobile/share-import/grant`, garde de session habituelle),
 *      puis le retirer à la déconnexion / au changement d'espace. Le jeton
 *      ne transite qu'en mémoire : jamais dans le stockage de la vue.
 *   2. Afficher l'état FIDÈLE des imports en cours sur ce téléphone pour le
 *      compte connecté (« Importation en cours », « En attente de connexion »,
 *      « Document ajouté » seulement après accusé serveur, « Échec » + cause),
 *      puis les acquitter (purge locale).
 *   3. « Importer et ouvrir Verebona » : ouvrir le suivi / le document.
 *
 * Plus de carte « Document partagé en attente d'import », plus de
 * formulaire « Ajouter un document » prérempli pour un partage déjà validé.
 * Plugin natif `VerebonaShareImport` (iOS : mobile/ios/App/App/VerebonaShareImportPlugin.swift ;
 * Android : mobile/android/…/VerebonaShareImportPlugin.java). Absent des
 * binaires antérieurs : tout ce module est sans effet.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NATIVE_PLUGINS, nativePlugin } from './bridge';
import {
  SHARE_IMPORT_GRANT_RENEW_BEFORE_MS, SHARE_IMPORT_STATUS_LABELS, type ShareImportFileState,
} from '@/lib/mobile/share-import-policy';

export interface NativeShareFile {
  operationId: string;
  name: string;
  size?: number;
  mimeType?: string;
  state: ShareImportFileState;
  code?: string | null;
  message?: string | null;
  fileId?: number | null;
  convertedFrom?: string | null;
}
export interface NativeShareItem {
  id: string;
  createdAt: number;
  /** Compte du jeton utilisé au partage ; null si aucun jeton valide n'était présent. */
  accountKey: string | null;
  /** Dernier compte connu de l'appareil au moment du partage (jeton expiré compris). */
  accountHint: string | null;
  openRequested?: boolean;
  files: NativeShareFile[];
  refused: Array<{ name: string; reason: string }>;
}
export interface NativeShareState {
  available: boolean;
  grant: { accountKey: string; expiresAt: string } | null;
  items: NativeShareItem[];
}

interface ShareImportPlugin {
  getState(): Promise<unknown>;
  setGrant(o: { token: string; expiresAt: string; accountKey: string; uploadUrl: string }): Promise<unknown>;
  clearGrant(): Promise<unknown>;
  acknowledge(o: { id: string }): Promise<unknown>;
  resume(): Promise<unknown>;
  consumeOpenRequest(): Promise<unknown>;
}

const FILE_STATES = new Set(Object.keys(SHARE_IMPORT_STATUS_LABELS));

/** Clé de compte de la session (même règle que le serveur, `shareImportAccountKey`). */
export function sessionAccountKey(userId: number | null | undefined, accountId: number | null | undefined): string | null {
  return userId && accountId ? `u${userId}-a${accountId}` : null;
}

// ── Règles pures (testées) ────────────────────────────────────────────────

/** État natif validé (tout champ inattendu est ignoré). */
export function parseNativeState(raw: unknown): NativeShareState {
  const r = (raw ?? {}) as Record<string, unknown>;
  const g = r.grant as Record<string, unknown> | null | undefined;
  const items: NativeShareItem[] = [];
  for (const it of Array.isArray(r.items) ? r.items as Array<Record<string, unknown>> : []) {
    if (!it || typeof it.id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(it.id)) continue;
    const files: NativeShareFile[] = [];
    for (const f of Array.isArray(it.files) ? it.files as Array<Record<string, unknown>> : []) {
      if (!f || typeof f.operationId !== 'string' || typeof f.name !== 'string') continue;
      const state = typeof f.state === 'string' && FILE_STATES.has(f.state) ? f.state as ShareImportFileState : 'queued';
      files.push({
        operationId: f.operationId, name: f.name, state,
        size: typeof f.size === 'number' ? f.size : undefined,
        mimeType: typeof f.mimeType === 'string' ? f.mimeType : undefined,
        code: typeof f.code === 'string' ? f.code : null,
        message: typeof f.message === 'string' ? f.message : null,
        fileId: typeof f.fileId === 'number' ? f.fileId : null,
        convertedFrom: typeof f.convertedFrom === 'string' ? f.convertedFrom : null,
      });
    }
    items.push({
      id: it.id,
      createdAt: Number(it.createdAt) || 0,
      accountKey: typeof it.accountKey === 'string' && it.accountKey ? it.accountKey : null,
      accountHint: typeof it.accountHint === 'string' && it.accountHint ? it.accountHint : null,
      openRequested: it.openRequested === true,
      files,
      refused: Array.isArray(it.refused)
        ? (it.refused as Array<Record<string, unknown>>).filter((x) => typeof x?.name === 'string' && typeof x?.reason === 'string').map((x) => ({ name: x.name as string, reason: x.reason as string }))
        : [],
    });
  }
  return {
    available: r.available === true,
    grant: g && typeof g.accountKey === 'string' && typeof g.expiresAt === 'string' ? { accountKey: g.accountKey, expiresAt: g.expiresAt } : null,
    items: items.sort((a, b) => a.createdAt - b.createdAt),
  };
}

/**
 * Isolation des comptes : un partage n'est montré (et repris) que pour le
 * compte de son jeton ; sans jeton au moment du partage, pour le dernier
 * compte connu de l'appareil ; sans aucun compte connu, pour le premier
 * compte qui se connecte (c'est la personne qui tient le téléphone).
 */
export function visibleShareItems(items: readonly NativeShareItem[], account: string | null): NativeShareItem[] {
  if (!account) return [];
  return items.filter((i) => i.accountKey ? i.accountKey === account : (!i.accountHint || i.accountHint === account));
}

/** Faut-il (re)demander un jeton ? Aucun, autre compte, ou échéance à moins de 24 h. */
export function needsGrant(grant: NativeShareState['grant'], account: string | null, now = Date.now()): boolean {
  if (!account) return false;
  if (!grant || grant.accountKey !== account) return true;
  const exp = Date.parse(grant.expiresAt);
  return !Number.isFinite(exp) || exp - now < SHARE_IMPORT_GRANT_RENEW_BEFORE_MS;
}

/** Un partage est terminé quand chaque fichier est enregistré ou en échec définitif. */
export function isSettled(item: NativeShareItem): boolean {
  return item.files.length > 0 && item.files.every((f) => f.state === 'imported' || f.state === 'failed');
}

export interface ShareSummary { inProgress: number; waiting: number; imported: number; failed: number }
export function summarize(items: readonly NativeShareItem[]): ShareSummary {
  const s: ShareSummary = { inProgress: 0, waiting: 0, imported: 0, failed: 0 };
  for (const i of items) for (const f of i.files) {
    if (f.state === 'imported') s.imported += 1;
    else if (f.state === 'failed') s.failed += 1;
    else if (f.state === 'waiting_auth' || f.state === 'waiting_network') s.waiting += 1;
    else s.inProgress += 1;
  }
  return s;
}

/** Chemin du suivi d'un partage (« Importer et ouvrir Verebona »). */
export const SHARE_IMPORT_TRACKING_PATH = '/documents/import-partage';
export function trackingPath(item: Pick<NativeShareItem, 'id' | 'files'>): string {
  const ops = item.files.map((f) => f.operationId).filter((o) => /^[A-Za-z0-9_-]{16,64}$/.test(o));
  return `${SHARE_IMPORT_TRACKING_PATH}?partage=${encodeURIComponent(item.id)}${ops.length ? `&ops=${ops.join(',')}` : ''}`;
}

// ── Accès natif ────────────────────────────────────────────────────────────

function plugin(): ShareImportPlugin | null {
  return nativePlugin<ShareImportPlugin>(NATIVE_PLUGINS.shareImport);
}

export function shareImportAvailable(): boolean {
  return plugin() !== null;
}

export async function readNativeShareState(): Promise<NativeShareState> {
  const p = plugin();
  if (!p) return { available: false, grant: null, items: [] };
  try { return parseNativeState(await p.getState()); } catch { return { available: false, grant: null, items: [] }; }
}

/**
 * Demande un jeton pour la session ouverte et le remet au natif (qui reprend
 * aussitôt les imports « En attente de connexion » de ce compte).
 */
export async function provisionShareGrant(headers: Record<string, string>): Promise<boolean> {
  const p = plugin();
  if (!p) return false;
  try {
    const res = await fetch('/api/mobile/share-import/grant', {
      method: 'POST', credentials: 'include', cache: 'no-store', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}',
    });
    if (!res.ok) return false;
    const g = await res.json() as { token?: unknown; expiresAt?: unknown; accountKey?: unknown; uploadPath?: unknown };
    if (typeof g.token !== 'string' || typeof g.expiresAt !== 'string' || typeof g.accountKey !== 'string') return false;
    const uploadUrl = new URL(typeof g.uploadPath === 'string' ? g.uploadPath : '/api/mobile/share-import/upload', window.location.origin).toString();
    await p.setGrant({ token: g.token, expiresAt: g.expiresAt, accountKey: g.accountKey, uploadUrl });
    return true;
  } catch {
    return false;
  }
}

/** Déconnexion / changement d'espace : jeton retiré du téléphone et révoqué côté serveur. */
export async function dropShareGrant(headers: Record<string, string>, revokeOnServer: boolean): Promise<void> {
  await plugin()?.clearGrant().catch(() => undefined);
  if (!revokeOnServer) return;
  await fetch('/api/mobile/share-import/grant', { method: 'DELETE', credentials: 'include', cache: 'no-store', headers }).catch(() => undefined);
}

export async function acknowledgeShare(id: string): Promise<void> {
  await plugin()?.acknowledge({ id }).catch(() => undefined);
}

export async function resumeShares(): Promise<void> {
  await plugin()?.resume().catch(() => undefined);
}

/** Demande d'ouverture laissée par l'interface de partage (« Importer et ouvrir Verebona »). */
export async function consumeOpenRequest(): Promise<string | null> {
  try {
    const r = await plugin()?.consumeOpenRequest() as { id?: unknown } | null | undefined;
    return typeof r?.id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(r.id) ? r.id : null;
  } catch {
    return null;
  }
}
