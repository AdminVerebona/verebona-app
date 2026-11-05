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
  SHARE_IMPORT_GRANT_RENEW_BEFORE_MS, SHARE_IMPORT_GRANT_RENEW_USES_LEFT, SHARE_IMPORT_PROVISION_RETRY_DELAYS_MS,
  SHARE_IMPORT_RENEWABLE_REFUSALS, SHARE_IMPORT_STATUS_LABELS, type ShareImportFileState,
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
/**
 * Lot 111P — état du jeton d'import LU PAR LE NATIF (Keychain iOS / Keystore
 * Android), distinct de la session de l'application :
 *   present (valide localement) · missing · expired · refused (dernier refus
 *   serveur pour CE jeton) · unreadable (lecture Keychain/Keystore impossible)
 *   · unknown (binaire 110A, qui ne le dit pas).
 */
export type NativeGrantStatus = 'present' | 'missing' | 'expired' | 'refused' | 'unreadable' | 'unknown';
export interface NativeGrant {
  accountKey: string;
  expiresAt: string;
  /** Référence NON secrète (12 hex de l'empreinte SHA-256 du jeton) ; absente sur un binaire 110A. */
  ref?: string | null;
  /** Code du dernier refus serveur de CE jeton (GRANT_REVOKED, SESSION_REVOKED, MFA_REQUIRED…). */
  refusedCode?: string | null;
}
/** Événement de diagnostic natif (codes seulement). */
export interface NativeDiagEntry { t: number; c: string; s: string }
export interface NativeShareState {
  available: boolean;
  grant: NativeGrant | null;
  items: NativeShareItem[];
  grantStatus?: NativeGrantStatus;
  /** Code du Keychain / Keystore (OK, NOT_FOUND, LOCKED, MISSING_ENTITLEMENT, DECODE, OS_-25308…). */
  storeCode?: string | null;
  diagnostics?: NativeDiagEntry[];
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
  const code = (v: unknown, max = 48) => (typeof v === 'string' && new RegExp(`^[A-Za-z0-9_:.-]{1,${max}}$`).test(v) ? v : null);
  const grant: NativeGrant | null = g && typeof g.accountKey === 'string' && typeof g.expiresAt === 'string'
    ? {
        accountKey: g.accountKey, expiresAt: g.expiresAt,
        ref: typeof g.ref === 'string' && /^[0-9a-f]{12}$/.test(g.ref) ? g.ref : null,
        refusedCode: code(g.refusedCode, 40),
      }
    : null;
  const statuses: NativeGrantStatus[] = ['present', 'missing', 'expired', 'refused', 'unreadable'];
  const grantStatus: NativeGrantStatus = typeof r.grantStatus === 'string' && (statuses as string[]).includes(r.grantStatus)
    ? r.grantStatus as NativeGrantStatus
    : grant ? (grant.refusedCode ? 'refused' : 'present') : 'unknown';
  const diagnostics: NativeDiagEntry[] = [];
  for (const d of Array.isArray(r.diagnostics) ? (r.diagnostics as Array<Record<string, unknown>>).slice(-40) : []) {
    const c = code(d?.c);
    if (c && Number.isFinite(Number(d.t))) diagnostics.push({ t: Number(d.t), c, s: code(d.s, 8) ?? '?' });
  }
  return {
    available: r.available === true,
    grant,
    items: items.sort((a, b) => a.createdAt - b.createdAt),
    grantStatus,
    storeCode: code(r.storeCode, 40),
    diagnostics,
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

/**
 * Lot 111P — motif d'un (re)provisionnement du jeton (pur, testé) :
 *   NO_SESSION (aucune session : rien à faire) · OK · MISSING · OTHER_ACCOUNT
 *   · EXPIRING (moins de 24 h) · REFUSED (le serveur a refusé ce jeton).
 */
export type GrantNeed = 'NO_SESSION' | 'OK' | 'MISSING' | 'OTHER_ACCOUNT' | 'EXPIRING' | 'REFUSED';
export function grantNeed(grant: NativeShareState['grant'], account: string | null, now = Date.now()): GrantNeed {
  if (!account) return 'NO_SESSION';
  if (!grant) return 'MISSING';
  if (grant.accountKey !== account) return 'OTHER_ACCOUNT';
  if (grant.refusedCode && (SHARE_IMPORT_RENEWABLE_REFUSALS as readonly string[]).includes(grant.refusedCode)) return 'REFUSED';
  const exp = Date.parse(grant.expiresAt);
  return !Number.isFinite(exp) || exp - now < SHARE_IMPORT_GRANT_RENEW_BEFORE_MS ? 'EXPIRING' : 'OK';
}

/** Faut-il (re)demander un jeton ? Aucun, autre compte, échéance à moins de 24 h, ou refusé par le serveur. */
export function needsGrant(grant: NativeShareState['grant'], account: string | null, now = Date.now()): boolean {
  const n = grantNeed(grant, account, now);
  return n !== 'NO_SESSION' && n !== 'OK';
}

/** Instant du renouvellement anticipé (24 h avant l'échéance), ou null (pur, testé). */
export function renewalDueAt(grant: NativeShareState['grant']): number | null {
  if (!grant) return null;
  const exp = Date.parse(grant.expiresAt);
  return Number.isFinite(exp) ? exp - SHARE_IMPORT_GRANT_RENEW_BEFORE_MS : null;
}

/**
 * Lot 111P — verdict de la vérification serveur légère (pur, testé) : le
 * jeton local (par sa référence non secrète) est-il encore actif côté
 * serveur, et lui reste-t-il assez d'usages ?
 */
export type ServerGrantVerdict = 'ACTIVE' | 'NOT_ACTIVE' | 'LOW_USES' | 'UNVERIFIABLE';
export function serverGrantVerdict(localRef: string | null | undefined, active: ReadonlyArray<{ ref: string; usesLeft: number }>): ServerGrantVerdict {
  if (!localRef) return 'UNVERIFIABLE';
  const hit = active.find((g) => g.ref === localRef);
  if (!hit) return 'NOT_ACTIVE';
  return hit.usesLeft <= SHARE_IMPORT_GRANT_RENEW_USES_LEFT ? 'LOW_USES' : 'ACTIVE';
}

/**
 * Lot 111P — résultat d'une demande de jeton : code STABLE (journal technique,
 * carte d'état), et s'il vaut la peine de réessayer automatiquement.
 */
export type ProvisionCode =
  | 'OK' | 'NO_PLUGIN' | 'NETWORK' | 'SESSION_RENEWING' | 'SESSION_UNAVAILABLE' | 'MFA_REQUIRED' | 'CGUV_REACCEPTANCE_REQUIRED'
  | 'ACCOUNT_NOT_FOUND' | 'FEATURE_OFF' | 'UNSUPPORTED' | 'RATE_LIMITED' | 'SERVER_ERROR' | 'HTTP_ERROR' | 'INVALID_RESPONSE'
  | 'NATIVE_REJECTED' | 'KEYCHAIN_WRITE';
export interface ProvisionResult {
  ok: boolean;
  code: ProvisionCode;
  /** Échec passager : nouvel essai temporisé autorisé. */
  retryable: boolean;
  /** Détail court, sans secret (statut HTTP, code natif). */
  detail?: string;
}

const RETRYABLE: ReadonlySet<ProvisionCode> = new Set(['NETWORK', 'SESSION_RENEWING', 'RATE_LIMITED', 'SERVER_ERROR', 'INVALID_RESPONSE']);

/** Catégorie d'une réponse HTTP de la route `grant` (pur, testé). */
export function classifyGrantHttp(status: number, code: string | null | undefined): ProvisionCode {
  if (status >= 200 && status < 300) return 'OK';
  if (status === 401) return 'SESSION_UNAVAILABLE';
  if (code === 'MFA_REQUIRED') return 'MFA_REQUIRED';
  if (code === 'CGUV_REACCEPTANCE_REQUIRED') return 'CGUV_REACCEPTANCE_REQUIRED';
  if (status === 409) return 'ACCOUNT_NOT_FOUND';
  if (status === 503 && code === 'UNSUPPORTED') return 'FEATURE_OFF';
  if (status === 400) return 'UNSUPPORTED';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'SERVER_ERROR';
  return 'HTTP_ERROR';
}

export function provisionResult(code: ProvisionCode, detail?: string): ProvisionResult {
  return { ok: code === 'OK', code, retryable: RETRYABLE.has(code), ...(detail ? { detail } : {}) };
}

/** Délai du n-ième nouvel essai automatique (0 = premier), null au-delà de la borne (pur, testé). */
export function provisionRetryDelay(result: ProvisionResult, attempt: number): number | null {
  if (result.ok || !result.retryable) return null;
  return attempt >= 0 && attempt < SHARE_IMPORT_PROVISION_RETRY_DELAYS_MS.length ? SHARE_IMPORT_PROVISION_RETRY_DELAYS_MS[attempt] : null;
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

/** Renouvellement de la session web (cookie d'accès de 15 min) — `apiClient.refreshToken`, injecté. */
export type RenewSession = () => Promise<boolean | 'server_error'>;

async function errorCode(res: Response): Promise<string | null> {
  try {
    const b = await res.json() as { code?: unknown };
    return typeof b?.code === 'string' ? b.code : null;
  } catch { return null; }
}

/**
 * Demande un jeton pour la session ouverte et le remet au natif (qui reprend
 * aussitôt les imports « En attente de connexion » de ce compte).
 *
 * Lot 111P : le motif d'un échec est rendu (jamais un simple `false`) ; un
 * 401 (cookie d'accès expiré, typiquement au retour au premier plan) passe
 * par le renouvellement de session COMMUN puis UNE nouvelle demande — jamais
 * de cookie ni de jeton lu ici.
 */
export async function provisionShareGrant(headers: Record<string, string>, renewSession?: RenewSession): Promise<ProvisionResult> {
  const p = plugin();
  if (!p) return provisionResult('NO_PLUGIN');
  const ask = () => fetch('/api/mobile/share-import/grant', {
    method: 'POST', credentials: 'include', cache: 'no-store', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}',
  });
  let res: Response;
  try {
    res = await ask();
    if (res.status === 401 && renewSession) {
      const renewed = await renewSession().catch(() => 'server_error' as const);
      if (renewed === 'server_error') return provisionResult('SESSION_RENEWING', 'HTTP_401');
      if (renewed !== true) return provisionResult('SESSION_UNAVAILABLE', 'HTTP_401');
      res = await ask();
    }
  } catch {
    return provisionResult('NETWORK');
  }
  if (!res.ok) {
    const code = await errorCode(res);
    return provisionResult(classifyGrantHttp(res.status, code), `HTTP_${res.status}${code ? `:${code}` : ''}`.slice(0, 48));
  }
  let g: { token?: unknown; expiresAt?: unknown; accountKey?: unknown; uploadPath?: unknown };
  try { g = await res.json() as typeof g; } catch { return provisionResult('INVALID_RESPONSE'); }
  if (typeof g.token !== 'string' || typeof g.expiresAt !== 'string' || typeof g.accountKey !== 'string') return provisionResult('INVALID_RESPONSE');
  const uploadUrl = new URL(typeof g.uploadPath === 'string' ? g.uploadPath : '/api/mobile/share-import/upload', window.location.origin).toString();
  try {
    await p.setGrant({ token: g.token, expiresAt: g.expiresAt, accountKey: g.accountKey, uploadUrl });
  } catch (e) {
    // Rejet du plugin : INVALID_GRANT (origine / format) ou KEYCHAIN_<code> / KEYSTORE_<code> (écriture non vérifiée).
    const c = String((e as { code?: unknown })?.code ?? '');
    const detail = /^[A-Z0-9_-]{1,40}$/.test(c) ? c : 'UNKNOWN';
    return provisionResult(/^KEY(CHAIN|STORE)/.test(detail) ? 'KEYCHAIN_WRITE' : 'NATIVE_REJECTED', detail);
  }
  return provisionResult('OK');
}

/**
 * Lot 111P — vérification serveur légère : références non secrètes des jetons
 * actifs de la session (aucun usage consommé). null si la vérification n'a pas
 * pu se faire (réseau, session) : rien n'est alors conclu.
 */
export async function fetchActiveGrantRefs(headers: Record<string, string>): Promise<Array<{ ref: string; usesLeft: number }> | null> {
  try {
    const res = await fetch('/api/mobile/share-import/grant', { method: 'GET', credentials: 'include', cache: 'no-store', headers });
    if (!res.ok) return null;
    const b = await res.json() as { grants?: Array<{ ref?: unknown; usesLeft?: unknown }> };
    return (Array.isArray(b.grants) ? b.grants : [])
      .filter((g) => typeof g?.ref === 'string' && typeof g?.usesLeft === 'number')
      .map((g) => ({ ref: g.ref as string, usesLeft: g.usesLeft as number }));
  } catch {
    return null;
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
