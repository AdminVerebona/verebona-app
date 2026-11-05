/**
 * Référentiel des versions de CGUV — lot 102B.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE SITE PUBLIC FAIT FOI, L'APPLICATION GARDE LE RÉFÉRENTIEL ET LES PREUVES
 *
 * Le texte officiel et ses archives immuables sont publiés par le site public.
 * L'application relit son manifeste machine (tâche planifiée
 * `legal-cguv-manifest-sync`, bouton BO « Relire le manifeste ») et tient en
 * base, pour chaque version : code, permalien public, empreinte SHA-256 du
 * texte, décision « substantielle » (`requiresReacceptance`, figée par le
 * déclencheur 0115 dès l'import), dates. AUCUN texte.
 *
 * Robustesse : manifeste indisponible ou invalide → rien n'est modifié, le
 * dernier état connu en base continue de servir (inscription, preuves,
 * réacceptation), une alerte Supervision est ouverte puis résolue d'elle-même
 * au retour. Une version déjà importée n'est JAMAIS réécrite par le manifeste :
 * un écart (empreinte, permalien, décision changés côté site, version disparue)
 * est une anomalie signalée, jamais une correction silencieuse.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { db } from '@/db';
import { legalDocumentVersions, legalManifestSyncState } from '@/db/schema';
import { and, desc, eq, sql } from 'drizzle-orm';
import { getAppBaseUrl } from '@/lib/app-url';
import {
  CGUV_FULL_LABEL, LEGAL_DOCUMENT_KEYS, cguvVersionPath, LEGAL_URL_ENV, decideLegalLinksMode, legalLinksList, resolveLegalLinks,
  type LegalDocumentKey, type LegalLinks, type LegalLinksMode,
} from '@/lib/legal/public-legal';
import { serverCacheDelete, serverCacheGet, serverCacheSet } from '@/lib/server-cache';
import { recordLegalAudit } from './legal-audit.service';
import {
  DOCUMENT_TYPE_CGVU, getCurrentVersion, getVersionById, setCurrentVersion, type LegalVersion,
} from './legal-versions.service';
import {
  LEGAL_MANIFEST_DEFAULTS, fetchCguvManifest, manifestUrl, parseCguvManifest, publicSiteBase, verifyTextBytes,
  CGUV_MANIFEST_SCHEMA, type CguvManifest, type FetchLike, type ManifestFailureReason, type TextVerification, type TextVerificationFailure,
} from './cguv-manifest';

type Env = Record<string, string | undefined>;

/** Lot 111O : `on_demand` — relecture déclenchée par un formulaire d'inscription bloqué (bornée). */
export type SyncTrigger = 'schedule' | 'manual' | 'bo' | 'seed' | 'startup' | 'on_demand';

export interface ReferentialAnomaly {
  kind:
    | 'VERSION_CHANGED_ON_SITE'
    | 'VERSION_MISSING_FROM_MANIFEST'
    | 'HASH_MISMATCH'
    | 'CURRENT_ROLLBACK_REFUSED'
    | 'LEGACY_DECISION_MISMATCH'
    // Lot 104A (P1-C / P1-D) : refus faute de vérification positive des octets.
    | 'TEXT_URL_MISSING'
    | 'TEXT_UNAVAILABLE'
    | 'CURRENT_NOT_VERIFIED'
    | 'LEGACY_LINK_REFUSED';
  code: string;
  detail: string;
}

export interface SyncResult {
  /** `awaiting_public_site` : manifeste jamais lu et absent — le site n'a pas encore livré (information). */
  status: 'ok' | 'ok_with_anomalies' | 'unavailable' | 'invalid' | 'awaiting_public_site';
  url: string;
  imported: string[];
  linkedLegacy: string[];
  /** Lot 104A : nouvelles versions refusées (texte non vérifié). */
  refused?: string[];
  current: string | null;
  anomalies: ReferentialAnomaly[];
  error?: string;
  /** Lot 111O : motif stable de l'échec de lecture (`MANIFEST_*`). */
  reason?: ManifestFailureReason;
  /** Lot 111O : statut HTTP observé (null : aucune réponse). */
  httpStatus?: number | null;
  /** Dernier état connu (toujours servi, même en panne). */
  lastKnown: { current: string | null; lastSuccessAt: Date | null };
}

export const MANIFEST_UNAVAILABLE_FINGERPRINT = 'other:legal-manifest:unavailable';
export const MANIFEST_ANOMALY_FINGERPRINT = 'other:legal-manifest:anomaly';
/** Information (pas un incident) : le site public n'a pas encore publié son manifeste. */
export const MANIFEST_AWAITING_FINGERPRINT = 'other:legal-manifest:awaiting-site';

/* ── Liens et preuves ─────────────────────────────────────────────────────── */

/** Variable explicite de bascule (serveur, sinon celle du build). */
function legalV2Flag(env: Env): string | undefined {
  return env.LEGAL_PUBLIC_V2 ?? env.NEXT_PUBLIC_LEGAL_PUBLIC_V2;
}

/** Surcharges par contenu lues à l'exécution (mapping unique `LEGAL_URL_ENV`). */
export function serverLegalOverrides(env: Env = process.env): Partial<Record<LegalDocumentKey, string | undefined>> {
  const out: Partial<Record<LegalDocumentKey, string | undefined>> = {};
  for (const k of LEGAL_DOCUMENT_KEYS) out[k] = env[LEGAL_URL_ENV[k]];
  return out;
}

const MODE_CACHE_KEY = 'legal-links-mode:v1';
/** Lot 111O : instant de mise en cache du mode (âge affiché par le BO), par instance. */
let modeCachedAt: number | null = null;

/** Lot 111O — âge du cache du mode des liens sur CETTE instance (null : rien en cache). */
export function legalModeCacheAgeMs(now: number = Date.now()): number | null {
  if (modeCachedAt === null || serverCacheGet<boolean>(MODE_CACHE_KEY) === null) return null;
  return Math.max(0, now - modeCachedAt);
}

/**
 * Lot 111O — invalide les caches juridiques de CETTE instance (mode des liens,
 * « réacceptation non requise »). La version en vigueur, elle, n'est jamais
 * mise en cache : elle est relue en base à chaque requête.
 */
export async function invalidateLegalCaches(): Promise<void> {
  serverCacheDelete(MODE_CACHE_KEY);
  modeCachedAt = null;
  const { onCguvReferentialChanged } = await import('./cguv-reacceptance.service');
  onCguvReferentialChanged();
}
/** Durée de cache (par instance) de « le manifeste a-t-il déjà été lu ? ». */
export const LEGAL_MODE_CACHE_MS = 60_000;

/**
 * Mode des liens légaux : `LEGAL_PUBLIC_V2=on|off` s'il est posé, sinon
 * AUTOMATIQUE — nouvelles adresses /legal/… dès que le manifeste a été lu
 * avec succès au moins une fois. Base injoignable : repli sur les adresses
 * actuelles (elles existent, jamais de 404).
 */
export async function getLegalLinksMode(env: Env = process.env): Promise<LegalLinksMode> {
  const flag = legalV2Flag(env);
  if (['on', 'true', '1', 'off', 'false', '0'].includes((flag ?? '').trim().toLowerCase())) return decideLegalLinksMode(flag, false);
  const cached = serverCacheGet<boolean>(MODE_CACHE_KEY);
  if (cached !== null) return decideLegalLinksMode(flag, cached);
  try {
    const [row] = await db.select({ at: legalManifestSyncState.lastSuccessAt }).from(legalManifestSyncState)
      .where(eq(legalManifestSyncState.documentType, DOCUMENT_TYPE_CGVU)).limit(1);
    const everRead = Boolean(row?.at);
    serverCacheSet(MODE_CACHE_KEY, everRead, LEGAL_MODE_CACHE_MS);
    modeCachedAt = Date.now();
    return decideLegalLinksMode(flag, everRead);
  } catch {
    return decideLegalLinksMode(flag, false);
  }
}

/** Les cinq liens résolus (serveur). */
export async function getServerLegalLinks(env: Env = process.env): Promise<{ mode: LegalLinksMode; links: LegalLinks }> {
  const mode = await getLegalLinksMode(env);
  return { mode, links: resolveLegalLinks(mode, publicSiteBase(env), serverLegalOverrides(env)) };
}

/** URL publique officielle d'un contenu (serveur, repli compris). */
export async function serverLegalUrl(key: LegalDocumentKey, env: Env = process.env): Promise<string> {
  return (await getServerLegalLinks(env)).links[key];
}

/** Les cinq liens, avec libellés (serveur). */
export async function serverLegalLinks(env: Env = process.env): Promise<Array<{ key: LegalDocumentKey; label: string; href: string }>> {
  return legalLinksList((await getServerLegalLinks(env)).links);
}

type ProofSource = Pick<LegalVersion, 'versionCode' | 'source' | 'permalink' | 'sha256' | 'publicPermalink' | 'publicSha256'>;

/**
 * Lot 104A (P1-D) — une archive APP_LEGACY n'est représentée par son
 * permalien PUBLIC que si l'empreinte publique est EXACTEMENT l'empreinte
 * historique. Un rattachement incohérent (antérieur au lot 104A) n'est
 * jamais utilisé : l'archive d'origine de l'application fait foi.
 */
export function hasVerifiedPublicLink(v: Pick<LegalVersion, 'sha256' | 'publicPermalink' | 'publicSha256'>): boolean {
  if (!v.publicPermalink || !v.publicSha256) return false;
  return !!v.sha256 && v.publicSha256 === v.sha256;
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 108L — CONSULTATION ≠ PREUVE
 *
 * L'URL de CONSULTATION d'une version (lien montré à l'utilisateur : inscription,
 * Mon compte, e-mails, réacceptation) est TOUJOURS sur le site public de
 * l'environnement (`NEXT_PUBLIC_PUBLIC_SITE_URL`) : `/legal/cguv/versions/{code}`,
 * et SEULEMENT si le texte de cette version y est vérifié (version publiée par
 * le site, ou archive APP_LEGACY republiée avec l'empreinte d'origine). Sinon :
 * `null` = « texte non disponible sur le site public » — jamais une autre
 * version, jamais l'archive de l'application (app.*), jamais `/cgvu`.
 *
 * L'identifiant de PREUVE (`versionProofInfo`, figé dans `legal_acceptances`)
 * est distinct et n'est jamais réécrit ; pour une archive APP_LEGACY il peut
 * désigner l'archive technique de l'application, qui n'est jamais un lien
 * présenté à l'utilisateur.
 * ══════════════════════════════════════════════════════════════════════════
 */
export type PublicTextAvailability = 'VERIFIED' | 'NOT_ON_PUBLIC_SITE';

/** Pur : le texte de cette version est-il vérifié sur le site public ? */
export function publicTextAvailability(v: Pick<LegalVersion, 'source' | 'sha256' | 'publicPermalink' | 'publicSha256'>): PublicTextAvailability {
  if (v.source === 'APP_LEGACY') return hasVerifiedPublicLink(v) ? 'VERIFIED' : 'NOT_ON_PUBLIC_SITE';
  // PUBLIC_SITE / BO_MANUAL : importées seulement après vérification positive des octets (lot 104A).
  return v.sha256 ? 'VERIFIED' : 'NOT_ON_PUBLIC_SITE';
}

/** Pur : URL publique de consultation d'une version, ou `null` (texte non disponible). */
export function versionConsultationUrl(
  v: Pick<LegalVersion, 'versionCode' | 'source' | 'sha256' | 'publicPermalink' | 'publicSha256'>,
  siteBase: string = publicSiteBase(),
): string | null {
  if (publicTextAvailability(v) !== 'VERIFIED') return null;
  return `${siteBase.replace(/\/+$/, '')}${cguvVersionPath(v.versionCode)}`;
}

/**
 * Permalien et empreinte qui IDENTIFIENT une version dans une preuve.
 *   · version publique (manifeste, saisie BO) : permalien et empreinte du site ;
 *   · archive APP_LEGACY republiée par le site : correspondance publique ;
 *   · archive APP_LEGACY seule : permalien historique de l'application
 *     (`/cguv/versions/<code>`, archive figée) et son empreinte d'origine.
 */
export function versionProofInfo(v: ProofSource, appBase: string = getAppBaseUrl()): { permalinkUrl: string; sha256: string | null } {
  if (v.source !== 'APP_LEGACY') return { permalinkUrl: v.permalink ?? '', sha256: v.sha256 };
  if (hasVerifiedPublicLink(v)) return { permalinkUrl: v.publicPermalink!, sha256: v.sha256 };
  return {
    permalinkUrl: `${appBase.replace(/\/+$/, '')}/cguv/versions/${encodeURIComponent(v.versionCode)}`,
    sha256: v.sha256,
  };
}

export type ProofStatus = 'COMPLETE' | 'HISTORIQUE' | 'EN_ATTENTE_SITE_PUBLIC';

/**
 * Pur : statut d'une NOUVELLE preuve. Version connue seulement par son archive
 * applicative (le site public n'a pas encore livré ou republié cette version,
 * ou l'a republiée avec une empreinte différente — lot 104A) → « en attente du
 * site public » ; sinon complète.
 */
export function proofStatusFor(v: Pick<LegalVersion, 'source' | 'sha256' | 'publicPermalink' | 'publicSha256'>): ProofStatus {
  return v.source === 'APP_LEGACY' && !hasVerifiedPublicLink(v) ? 'EN_ATTENTE_SITE_PUBLIC' : 'COMPLETE';
}

/** Version courante présentée à l'utilisateur (métadonnées, aucun texte). */
export interface PublicCurrentCguv {
  versionCode: string;
  title: string;
  /**
   * Lot 108L : URL PUBLIQUE de consultation de cette version exacte
   * (`/legal/cguv/versions/{code}` du site de l'environnement), ou `null` si
   * son texte n'est pas vérifié sur le site public — jamais app.*, jamais /cgvu.
   */
  permalinkUrl: string | null;
  /** Lot 108L : texte vérifié sur le site public ? (sinon acceptation refusée, fail-closed). */
  publicText: PublicTextAvailability;
  sha256: string | null;
  effectiveAt: Date | null;
  publishedAt: Date | null;
  changeSummary: string;
  requiresReacceptance: boolean;
  source: LegalVersion['source'];
}

export async function getPublicCurrentCguv(): Promise<PublicCurrentCguv | null> {
  const current = await getCurrentVersion(DOCUMENT_TYPE_CGVU);
  if (!current) return null;
  const proof = versionProofInfo(current);
  return {
    versionCode: current.versionCode,
    title: current.source === 'APP_LEGACY' ? CGUV_FULL_LABEL : current.title,
    permalinkUrl: versionConsultationUrl(current),
    publicText: publicTextAvailability(current),
    sha256: proof.sha256,
    effectiveAt: current.effectiveAt,
    publishedAt: current.publishedAt,
    changeSummary: current.changeSummary,
    requiresReacceptance: current.requiresReacceptance,
    source: current.source,
  };
}

/* ── État de synchronisation ──────────────────────────────────────────────── */

export interface ManifestSyncState {
  manifestUrl: string | null;
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  lastStatus: string;
  lastError: string | null;
  consecutiveFailures: number;
  manifestSha256: string | null;
  currentVersionCode: string | null;
  versionsCount: number;
  anomalies: ReferentialAnomaly[];
  lastTrigger: string | null;
  /** Lot 111O : détail de la dernière lecture (null : jamais lue depuis le lot 111). */
  lastRead: ManifestLastRead | null;
}

/**
 * Lot 111O — détail de la DERNIÈRE lecture du manifeste (BO › Exploitation ›
 * Santé › « CGUV publiées »). Aucune donnée personnelle, aucun secret.
 */
export interface ManifestLastRead {
  at: string;
  trigger: string;
  url: string;
  finalUrl: string | null;
  httpStatus: number | null;
  /** `null` : lecture réussie. */
  reason: ManifestFailureReason | null;
  error: string | null;
  /** Destination d'une redirection refusée. */
  location: string | null;
  /** Origines étrangères rencontrées dans les liens du manifeste. */
  foreignOrigins: string[];
  /** Codes publiés lus (même si le manifeste est refusé, quand ils sont lisibles). */
  versions: string[];
  /** Version désignée « en vigueur » par le site. */
  manifestCurrent: string | null;
  /** Version en vigueur de l'application APRÈS cette lecture. */
  appCurrent: string | null;
  /** La version désignée par le site est-elle en vigueur ET son texte vérifié dans l'application ? */
  expectedVerified: boolean;
  /** Versions refusées faute de texte vérifié (lecture réussie). */
  refused: string[];
  durationMs: number;
}

export async function getManifestSyncState(): Promise<ManifestSyncState> {
  const [row] = await db.select().from(legalManifestSyncState)
    .where(eq(legalManifestSyncState.documentType, DOCUMENT_TYPE_CGVU)).limit(1);
  return {
    manifestUrl: row?.manifestUrl ?? null,
    lastAttemptAt: row?.lastAttemptAt ?? null,
    lastSuccessAt: row?.lastSuccessAt ?? null,
    lastStatus: row?.lastStatus ?? 'never',
    lastError: row?.lastError ?? null,
    consecutiveFailures: row?.consecutiveFailures ?? 0,
    manifestSha256: row?.manifestSha256 ?? null,
    currentVersionCode: row?.currentVersionCode ?? null,
    versionsCount: row?.versionsCount ?? 0,
    anomalies: Array.isArray(row?.anomalies) ? (row!.anomalies as ReferentialAnomaly[]) : [],
    lastTrigger: row?.lastTrigger ?? null,
    lastRead: row?.lastRead && typeof row.lastRead === 'object' ? (row.lastRead as ManifestLastRead) : null,
  };
}

/**
 * Lot 111O — enregistre le détail de la dernière lecture. Séparé de
 * `writeState` et sans effet bloquant : si la migration 1270 n'est pas encore
 * passée, la synchronisation continue exactement comme avant.
 */
async function writeLastRead(lastRead: ManifestLastRead): Promise<void> {
  try {
    await db.update(legalManifestSyncState).set({ lastRead }).where(eq(legalManifestSyncState.documentType, DOCUMENT_TYPE_CGVU));
  } catch (e) {
    console.error('[legal] détail de lecture du manifeste non enregistré :', (e as Error).message);
  }
}

async function writeState(patch: Partial<typeof legalManifestSyncState.$inferInsert>): Promise<void> {
  const now = new Date();
  await db.insert(legalManifestSyncState)
    .values({ documentType: DOCUMENT_TYPE_CGVU, updatedAt: now, ...patch })
    .onConflictDoUpdate({ target: legalManifestSyncState.documentType, set: { ...patch, updatedAt: now } });
}

async function supervision() {
  return import('@/services/admin/anomaly.service');
}

/* ── Synchronisation ─────────────────────────────────────────────────────── */

function sameInstant(a: Date | null, b: Date): boolean {
  return !!a && Math.abs(a.getTime() - b.getTime()) < 1000;
}

/** Échecs consécutifs avant alerte (variable `LEGAL_MANIFEST_ALERT_AFTER_FAILURES`). */
export function alertThreshold(env: Env = process.env): number {
  const n = Number(env.LEGAL_MANIFEST_ALERT_AFTER_FAILURES);
  return Number.isInteger(n) && n >= 1 && n <= 50 ? n : LEGAL_MANIFEST_DEFAULTS.alertAfterFailures;
}

/**
 * Pur : phase de transition ? (manifeste JAMAIS lu avec succès et simplement
 * absent / injoignable). Un manifeste publié mais invalide est un incident.
 */
export function isAwaitingPublicSite(lastSuccessAt: Date | null, kind: 'unavailable' | 'invalid'): boolean {
  return lastSuccessAt === null && kind === 'unavailable';
}

/** Pur : faut-il alerter la Supervision après cet échec ? */
export function shouldAlertOnFailure(consecutiveFailures: number, lastSuccessAt: Date | null, threshold: number): boolean {
  return lastSuccessAt === null || consecutiveFailures >= threshold;
}

/**
 * Applique un manifeste valide au référentiel (idempotent). Exporté pour les
 * tests et la saisie BO.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 104A — AUCUNE VERSION SANS VÉRIFICATION POSITIVE DE SON TEXTE
 *
 *   P1-C · NOUVELLE version publiée par le site : `textUrl` OBLIGATOIRE
 *          (HTTPS, origine du site public — contrôlé par le manifeste) et
 *          vérification des octets servis === `sha256` AVANT import. URL
 *          absente, 404, réseau, délai, empreinte différente → version
 *          REFUSÉE (non importée), rien d'autre ne change : le dernier état
 *          fiable reste en service, la version courante n'est pas déplacée.
 *          Activation (version désignée `current`, pas encore en vigueur
 *          ici) : même exigence sur l'empreinte enregistrée.
 *          Chaque refus est un écart : Supervision (anomalie regroupée
 *          `other:legal-manifest:anomaly`), BO › CGUV (écarts de la
 *          dernière lecture), journal juridique — sans secret. La version
 *          est retentée à chaque lecture : la correction côté site suffit.
 *   P1-D · archive APP_LEGACY (versions publiées autrefois par
 *          l'application, déjà acceptées) : rattachée au permalien public
 *          SEULEMENT si l'empreinte publique === l'empreinte HISTORIQUE
 *          (`sha256` d'origine) ET si les octets publics sont effectivement
 *          vérifiés. Sinon : aucun rattachement, l'archive d'origine reste
 *          servie (`/cguv/versions/<code>`), écart signalé ; reprise
 *          automatique dès que le site sert le bon fichier.
 *   Les preuves existantes (`legal_acceptances`) et les versions déjà
 *   importées ne sont JAMAIS modifiées ni supprimées (déclencheurs 0910).
 * ══════════════════════════════════════════════════════════════════════════
 */
export async function applyCguvManifest(
  manifest: CguvManifest,
  opts: { actorUserId?: number | null; fetchImpl?: FetchLike; textTimeoutMs?: number } = {},
): Promise<{ imported: string[]; linkedLegacy: string[]; current: string | null; anomalies: ReferentialAnomaly[]; refused: string[] }> {
  const rows = await db.select().from(legalDocumentVersions)
    .where(eq(legalDocumentVersions.documentType, DOCUMENT_TYPE_CGVU));
  const byCode = new Map(rows.map((r) => [r.versionCode, r]));
  const imported: string[] = [];
  const linkedLegacy: string[] = [];
  const refused: string[] = [];
  const anomalies: ReferentialAnomaly[] = [];
  /** Versions dont les octets ont été vérifiés positivement pendant CETTE lecture. */
  const verified = new Set<string>();
  const now = new Date();
  const verify = (url: string | null, sha: string | null) => verifyTextBytes(url, sha, { fetchImpl: opts.fetchImpl, timeoutMs: opts.textTimeoutMs });

  const ordered = [...manifest.versions].sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime());
  for (const v of ordered) {
    const row = byCode.get(v.code);
    if (!row) {
      // P1-C : vérification POSITIVE exigée avant tout import.
      const check = await verify(v.textUrl, v.sha256);
      if (!check.ok) {
        refused.push(v.code);
        anomalies.push({ kind: anomalyKindFor(check.reason), code: v.code, detail: `${check.detail} : version non importée (dernier état fiable conservé)` });
        continue;
      }
      verified.add(v.code);
      const inserted = await db.insert(legalDocumentVersions).values({
        documentType: DOCUMENT_TYPE_CGVU,
        versionCode: v.code,
        title: v.title ?? CGUV_FULL_LABEL,
        status: 'PUBLISHED',
        source: 'PUBLIC_SITE',
        effectiveAt: v.effectiveAt,
        publishedAt: v.publishedAt,
        changeSummary: v.changeSummary ?? 'Version publiée sur le site public.',
        requiresReacceptance: v.requiresReacceptance,
        permalink: v.permalink,
        sha256: v.sha256,
        syncedAt: now,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing().returning({ id: legalDocumentVersions.id });
      if (inserted[0]) {
        imported.push(v.code);
        const [fresh] = await db.select().from(legalDocumentVersions).where(eq(legalDocumentVersions.id, inserted[0].id)).limit(1);
        if (fresh) byCode.set(v.code, fresh);
        await recordLegalAudit({
          action: 'VERSION_IMPORTED', actorUserId: opts.actorUserId, versionCode: v.code, versionId: inserted[0].id,
          details: `sha256=${v.sha256} (octets vérifiés : ${check.bytes} o) ; substantielle=${v.requiresReacceptance ? 'oui' : 'non'} ; ${v.permalink}`,
        });
      }
      continue;
    }

    if (row.source === 'APP_LEGACY') {
      // Archive historique déjà acceptée : jamais purgée ni réécrite.
      if (row.requiresReacceptance !== v.requiresReacceptance) {
        anomalies.push({ kind: 'LEGACY_DECISION_MISMATCH', code: v.code, detail: `décision « substantielle » figée dans l’application (${row.requiresReacceptance ? 'oui' : 'non'}) différente du manifeste` });
      }
      if (!row.publicPermalink && !row.publicSha256) {
        // P1-D : rattachement seulement sur empreinte historique identique ET octets publics vérifiés.
        const decision = await decideLegacyLink({ historicSha256: row.sha256, publicSha256: v.sha256, textUrl: v.textUrl }, verify);
        if (!decision.link) {
          anomalies.push({ kind: 'LEGACY_LINK_REFUSED', code: v.code, detail: `${decision.detail} : archive d’origine de l’application conservée et servie, aucun rattachement` });
          continue;
        }
        verified.add(v.code);
        await db.update(legalDocumentVersions)
          .set({ publicPermalink: v.permalink, publicSha256: v.sha256, syncedAt: now })
          .where(eq(legalDocumentVersions.id, row.id));
        linkedLegacy.push(v.code);
        await recordLegalAudit({
          action: 'VERSION_IMPORTED', actorUserId: opts.actorUserId, versionCode: v.code, versionId: row.id,
          details: `archive historique rattachée au permalien public (empreinte d’origine identique, octets vérifiés) ; sha256=${v.sha256} ; ${v.permalink}`,
        });
      } else if (row.publicPermalink !== v.permalink || row.publicSha256 !== v.sha256) {
        anomalies.push({ kind: 'VERSION_CHANGED_ON_SITE', code: v.code, detail: 'permalien ou empreinte publique différents de ceux enregistrés' });
      } else if (!hasVerifiedPublicLink(row)) {
        // Rattachement antérieur au lot 104A dont l'empreinte publique diffère
        // de l'empreinte d'origine : l'archive d'origine reste la référence.
        anomalies.push({ kind: 'LEGACY_LINK_REFUSED', code: v.code, detail: 'empreinte publique différente de l’empreinte historique : archive d’origine de l’application servie' });
      }
      continue;
    }

    // PUBLIC_SITE / BO_MANUAL : jamais réécrite.
    const diffs: string[] = [];
    if (row.permalink !== v.permalink) diffs.push('permalien');
    if (row.sha256 !== v.sha256) diffs.push('empreinte');
    if (row.requiresReacceptance !== v.requiresReacceptance) diffs.push('décision « substantielle »');
    if (!sameInstant(row.publishedAt ?? null, v.publishedAt)) diffs.push('date de publication');
    if (diffs.length > 0) {
      anomalies.push({ kind: 'VERSION_CHANGED_ON_SITE', code: v.code, detail: `${diffs.join(', ')} modifié(s) côté site : une version publiée est immuable, valeurs enregistrées conservées` });
    }
  }

  const listed = new Set(manifest.versions.map((v) => v.code));
  for (const r of rows) {
    if (r.source === 'PUBLIC_SITE' && !listed.has(r.versionCode)) {
      anomalies.push({ kind: 'VERSION_MISSING_FROM_MANIFEST', code: r.versionCode, detail: 'version déjà importée absente du manifeste : les versions historiques doivent rester publiées' });
    }
    // APP_LEGACY absente du manifeste : normal tant que le site ne l'a pas
    // republiée — l'archive de l'application reste servie (aucune purge).
  }

  // Version courante : celle du manifeste, si elle est importée ET vérifiée.
  let current: string | null = (await getCurrentVersion(DOCUMENT_TYPE_CGVU))?.versionCode ?? null;
  const currentBefore = current;
  const target = byCode.get(manifest.current);
  if (!target && current !== manifest.current) {
    anomalies.push({ kind: 'CURRENT_NOT_VERIFIED', code: manifest.current, detail: `version désignée « en vigueur » par le site non importée : version en vigueur conservée (${current ?? 'aucune'})` });
  } else if (target && current !== manifest.current) {
    if (target.status === 'ARCHIVED') {
      anomalies.push({ kind: 'CURRENT_ROLLBACK_REFUSED', code: manifest.current, detail: 'une version archivée ne redevient pas courante : publier une nouvelle version' });
    } else {
      // Activation : octets vérifiés pendant cette lecture, sinon vérifiés maintenant
      // contre l'empreinte ENREGISTRÉE (une version importée avant le lot 104A
      // sans vérification n'est jamais activée « à l'aveugle »).
      let activable = verified.has(manifest.current);
      if (!activable) {
        const mv = manifest.versions.find((x) => x.code === manifest.current);
        const proof = versionProofInfo(target as unknown as ProofSource);
        const check = await verify(mv?.textUrl ?? null, proof.sha256);
        activable = check.ok;
        if (!check.ok) {
          anomalies.push({ kind: 'CURRENT_NOT_VERIFIED', code: manifest.current, detail: `${check.detail} : version non activée, version en vigueur conservée (${current ?? 'aucune'})` });
        }
      }
      const fresh = activable ? await getVersionById(target.id) : null;
      if (fresh) {
        await setCurrentVersion(fresh.id, opts.actorUserId ?? null);
        current = manifest.current;
      }
    }
  }

  for (const a of anomalies) {
    await recordLegalAudit({ action: 'MANIFEST_ANOMALY', actorUserId: opts.actorUserId, versionCode: a.code, result: 'failure', details: `${a.kind} : ${a.detail}` });
  }
  if (imported.length > 0 || linkedLegacy.length > 0 || current !== currentBefore) {
    // Nouvelle version (éventuellement substantielle) : les « non requis »
    // mis en cache par la garde de réacceptation sont oubliés.
    const { onCguvReferentialChanged } = await import('./cguv-reacceptance.service');
    onCguvReferentialChanged();
  }
  return { imported, linkedLegacy, current, anomalies, refused };
}

/** Pur : type d'écart pour un échec de vérification d'octets. */
export function anomalyKindFor(reason: TextVerificationFailure): ReferentialAnomaly['kind'] {
  if (reason === 'TEXT_URL_MISSING') return 'TEXT_URL_MISSING';
  if (reason === 'SHA_MISMATCH' || reason === 'EXPECTED_SHA_INVALID') return 'HASH_MISMATCH';
  return 'TEXT_UNAVAILABLE';
}

/**
 * P1-D — décision de rattachement d'une archive APP_LEGACY au permalien
 * public. Exige les DEUX conditions : empreinte publique annoncée ===
 * empreinte historique, et octets publics effectivement vérifiés.
 */
export async function decideLegacyLink(
  input: { historicSha256: string | null; publicSha256: string; textUrl: string | null },
  verify: (url: string | null, sha: string | null) => Promise<TextVerification>,
): Promise<{ link: true } | { link: false; detail: string }> {
  const historic = (input.historicSha256 ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(historic)) return { link: false, detail: 'empreinte historique de l’archive inconnue : comparaison impossible' };
  if (input.publicSha256 !== historic) {
    return { link: false, detail: `empreinte publique (${input.publicSha256.slice(0, 12)}…) différente de l’empreinte historique (${historic.slice(0, 12)}…)` };
  }
  const check = await verify(input.textUrl, historic);
  if (!check.ok) return { link: false, detail: check.detail };
  return { link: true };
}

/** Relit le manifeste public et met à jour le référentiel. Ne lève jamais. */
export async function syncCguvManifest(opts: {
  trigger: SyncTrigger;
  actorUserId?: number | null;
  fetchImpl?: FetchLike;
  env?: Env;
}): Promise<SyncResult> {
  const env = opts.env ?? process.env;
  const before = await getManifestSyncState().catch(() => null);
  const lastKnownCurrent = (await getCurrentVersion(DOCUMENT_TYPE_CGVU).catch(() => null))?.versionCode ?? null;
  const startedAt = Date.now();
  const fetched = await fetchCguvManifest({ fetchImpl: opts.fetchImpl, env });
  const now = new Date();

  if (!fetched.ok) {
    const failures = (before?.consecutiveFailures ?? 0) + 1;
    // Jamais lu avec succès ET absent / injoignable : le site public n'a pas
    // encore livré. Phase de transition normale → information, pas incident.
    const awaiting = isAwaitingPublicSite(before?.lastSuccessAt ?? null, fetched.kind);
    const status: SyncResult['status'] = awaiting ? 'awaiting_public_site' : fetched.kind;
    await writeState({
      manifestUrl: fetched.url, lastAttemptAt: now, lastStatus: status, lastError: fetched.error,
      consecutiveFailures: failures, lastTrigger: opts.trigger,
    }).catch((e) => console.error('[legal] état du manifeste non enregistré :', (e as Error).message));
    await writeLastRead({
      at: now.toISOString(), trigger: opts.trigger, url: fetched.url, finalUrl: fetched.finalUrl, httpStatus: fetched.httpStatus,
      reason: fetched.reason, error: fetched.error, location: fetched.location ?? null, foreignOrigins: fetched.foreignOrigins ?? [],
      versions: fetched.codes ?? [], manifestCurrent: fetched.manifestCurrent ?? null, appCurrent: lastKnownCurrent,
      expectedVerified: false, refused: [], durationMs: Date.now() - startedAt,
    });
    // Lot 111O : motif journalisé (code stable + statut HTTP), sans secret.
    console.warn(`[legal] lecture du manifeste des CGUV en échec : ${fetched.reason} (HTTP ${fetched.httpStatus ?? '—'}) ${fetched.url} — ${fetched.error.slice(0, 200)}`);
    if (failures === 1 || opts.trigger === 'bo' || opts.trigger === 'manual') {
      await recordLegalAudit({ action: 'MANIFEST_SYNC_FAILED', actorUserId: opts.actorUserId, result: 'failure', details: `${status} : ${fetched.reason} — ${fetched.error} (${fetched.url})` });
    }
    const { reportAnomaly } = await supervision();
    if (awaiting) {
      if (failures === 1) {
        await reportAnomaly({
          domain: 'other',
          fingerprint: MANIFEST_AWAITING_FINGERPRINT,
          title: 'Information — CGUV : le site public n’a pas encore publié son manifeste (liens sur les adresses actuelles)',
          detail: {
            niveau: 'information',
            url: fetched.url, erreur: fetched.error,
            versionCouranteConservee: lastKnownCurrent,
            effet: 'Liens légaux sur les adresses actuelles du site (/cgu, /mentions-legales, /confidentialite) ; aucune réacceptation exigée ; preuves « en attente du site public ».',
            action: 'Aucune action urgente. Se résout seule à la première lecture réussie du manifeste.',
          },
        });
      }
    } else if (shouldAlertOnFailure(failures, before?.lastSuccessAt ?? null, alertThreshold(env))) {
      await reportAnomaly({
        domain: 'other',
        fingerprint: MANIFEST_UNAVAILABLE_FINGERPRINT,
        title: fetched.kind === 'invalid' ? 'Manifeste public des CGUV invalide' : 'Manifeste public des CGUV indisponible',
        detail: {
          url: fetched.url, motif: fetched.reason, statutHttp: fetched.httpStatus, erreur: fetched.error, echecsConsecutifs: failures,
          dernierSucces: before?.lastSuccessAt?.toISOString() ?? null,
          versionCouranteConservee: lastKnownCurrent,
          action: 'Le dernier état connu continue de servir (aucun blocage). Vérifier la publication du manifeste par le site public, puis BO › CGUV › « Relire le manifeste ».',
        },
      });
    }
    return {
      status, url: fetched.url, imported: [], linkedLegacy: [], current: lastKnownCurrent,
      anomalies: [], error: fetched.error, reason: fetched.reason, httpStatus: fetched.httpStatus,
      lastKnown: { current: lastKnownCurrent, lastSuccessAt: before?.lastSuccessAt ?? null },
    };
  }

  const applied = await applyCguvManifest(fetched.manifest, { actorUserId: opts.actorUserId, fetchImpl: opts.fetchImpl });
  // Bascule automatique des liens légaux sur les nouvelles adresses /legal/….
  serverCacheDelete(MODE_CACHE_KEY);
  modeCachedAt = null;
  const status = applied.anomalies.length > 0 ? 'ok_with_anomalies' : 'ok';
  await writeState({
    manifestUrl: fetched.url, lastAttemptAt: now, lastSuccessAt: now, lastStatus: status, lastError: null,
    consecutiveFailures: 0, manifestSha256: fetched.sha256, currentVersionCode: applied.current,
    versionsCount: fetched.manifest.versions.length, anomalies: applied.anomalies, lastTrigger: opts.trigger,
  });
  {
    const cur = await getCurrentVersion(DOCUMENT_TYPE_CGVU).catch(() => null);
    await writeLastRead({
      at: now.toISOString(), trigger: opts.trigger, url: fetched.url, finalUrl: fetched.finalUrl, httpStatus: fetched.httpStatus,
      reason: null, error: null, location: null, foreignOrigins: [],
      versions: fetched.manifest.versions.map((v) => v.code), manifestCurrent: fetched.manifest.current, appCurrent: applied.current,
      expectedVerified: !!cur && cur.versionCode === fetched.manifest.current && publicTextAvailability(cur) === 'VERIFIED',
      refused: applied.refused, durationMs: Date.now() - startedAt,
    });
  }
  const { reportAnomaly, autoResolveAnomaly } = await supervision();
  await autoResolveAnomaly(MANIFEST_UNAVAILABLE_FINGERPRINT, { origin: 'legal_manifest_sync', cause: `manifeste relu (${fetched.url})` });
  await autoResolveAnomaly(MANIFEST_AWAITING_FINGERPRINT, { origin: 'legal_manifest_sync', cause: `site public livré : manifeste lu (${fetched.url})` });
  if (applied.anomalies.length > 0) {
    await reportAnomaly({
      domain: 'other',
      fingerprint: MANIFEST_ANOMALY_FINGERPRINT,
      title: applied.refused.length > 0
        ? `CGUV : ${applied.refused.length} version(s) refusée(s) (texte non vérifié) — ${applied.anomalies.length} écart(s) avec le référentiel`
        : `Manifeste public des CGUV : ${applied.anomalies.length} écart(s) avec le référentiel`,
      detail: {
        url: fetched.url,
        ecarts: applied.anomalies.slice(0, 20),
        versionsRefusees: applied.refused,
        versionEnVigueurConservee: applied.current,
        action: applied.refused.length > 0
          ? 'Une version n’est importée qu’après vérification de son texte figé (textUrl, empreinte SHA-256). Corriger la publication côté site public, puis BO › CGUV › « Relire le manifeste ». Rien n’a été modifié dans l’application.'
          : 'Une version publiée est immuable : corriger le manifeste côté site public (aucune correction automatique).',
      },
    });
  } else {
    await autoResolveAnomaly(MANIFEST_ANOMALY_FINGERPRINT, { origin: 'legal_manifest_sync', cause: 'aucun écart' });
  }
  await superviseCurrentPublicText();
  if (applied.imported.length > 0 || applied.refused.length > 0 || applied.current !== lastKnownCurrent || opts.trigger === 'bo' || opts.trigger === 'manual') {
    await recordLegalAudit({
      action: 'MANIFEST_SYNCED', actorUserId: opts.actorUserId, versionCode: applied.current,
      details: `importées : ${applied.imported.join(', ') || 'aucune'} ; refusées : ${applied.refused.join(', ') || 'aucune'} ; courante : ${applied.current ?? 'aucune'} ; écarts : ${applied.anomalies.length}`,
    });
  }
  return {
    status, url: fetched.url, imported: applied.imported, linkedLegacy: applied.linkedLegacy, refused: applied.refused,
    current: applied.current, anomalies: applied.anomalies, httpStatus: fetched.httpStatus,
    lastKnown: { current: applied.current, lastSuccessAt: now },
  };
}

/** Lot 108L : anomalie Supervision « version en vigueur sans texte vérifié sur le site public ». */
export const CURRENT_PUBLIC_TEXT_FINGERPRINT = 'other:legal-cguv:public-text-unavailable';

/**
 * Lot 108L — Supervision de la disponibilité juridique : la version en vigueur
 * doit être consultable sur le site public (sinon aucune nouvelle acceptation
 * n'est enregistrée : `assertCguvAcceptable`). Résolue d'elle-même au retour.
 * Ne lève jamais.
 */
export async function superviseCurrentPublicText(versionCode?: string | null): Promise<void> {
  try {
    const current = await getCurrentVersion(DOCUMENT_TYPE_CGVU);
    const { reportAnomaly, autoResolveAnomaly } = await supervision();
    if (current && publicTextAvailability(current) === 'VERIFIED') {
      await autoResolveAnomaly(CURRENT_PUBLIC_TEXT_FINGERPRINT, { origin: 'legal_public_text', cause: `CGUV ${current.versionCode} vérifiées sur le site public` });
      return;
    }
    await reportAnomaly({
      domain: 'other',
      fingerprint: CURRENT_PUBLIC_TEXT_FINGERPRINT,
      title: 'CGUV : la version présentée à l’acceptation n’est pas disponible sur le site public — inscriptions et acceptations suspendues',
      detail: {
        versionEnVigueur: current?.versionCode ?? null,
        versionDemandee: versionCode ?? null,
        effet: 'Aucune acceptation non opposable : l’inscription (classique, Google / Apple), la réacceptation et la demande de démarrage immédiat sont refusées (CGUV_PUBLIC_TEXT_UNAVAILABLE) ; aucun lien vers l’application (app.*) ni vers une autre version n’est proposé.',
        action: 'Publier le texte de cette version sur le site public (ou y reprendre l’archive octet pour octet), puis BO › CGUV › « Relire le manifeste ». Reprise automatique.',
      },
    });
  } catch (e) {
    console.error('[legal] supervision du texte public impossible :', (e as Error).message);
  }
}

/* ── Lecture BO et saisie de secours ──────────────────────────────────────── */

export interface ReferentialRow {
  id: string;
  versionCode: string;
  status: string;
  source: string;
  permalinkUrl: string;
  sha256: string | null;
  requiresReacceptance: boolean;
  publishedAt: Date | null;
  effectiveAt: Date | null;
  changeSummary: string;
  acceptances: number;
  hasArchive: boolean;
}

export async function listCguvReferential(): Promise<ReferentialRow[]> {
  const rows = await db.select({
    id: legalDocumentVersions.id,
    versionCode: legalDocumentVersions.versionCode,
    status: legalDocumentVersions.status,
    source: legalDocumentVersions.source,
    permalink: legalDocumentVersions.permalink,
    sha256: legalDocumentVersions.sha256,
    publicPermalink: legalDocumentVersions.publicPermalink,
    publicSha256: legalDocumentVersions.publicSha256,
    requiresReacceptance: legalDocumentVersions.requiresReacceptance,
    publishedAt: legalDocumentVersions.publishedAt,
    effectiveAt: legalDocumentVersions.effectiveAt,
    changeSummary: legalDocumentVersions.changeSummary,
    hasArchive: sql<boolean>`(${legalDocumentVersions.htmlContent} IS NOT NULL)`,
    acceptances: sql<number>`(SELECT count(*)::int FROM legal_acceptances la WHERE la.legal_document_version_id = ${legalDocumentVersions.id})`,
  }).from(legalDocumentVersions)
    .where(and(eq(legalDocumentVersions.documentType, DOCUMENT_TYPE_CGVU), sql`${legalDocumentVersions.status} <> 'DRAFT'`))
    .orderBy(desc(legalDocumentVersions.publishedAt));
  return rows.map((r) => {
    const proof = versionProofInfo({ ...r, source: r.source as LegalVersion['source'] });
    return {
      id: r.id, versionCode: r.versionCode, status: r.status, source: r.source,
      permalinkUrl: proof.permalinkUrl, sha256: proof.sha256, requiresReacceptance: r.requiresReacceptance,
      publishedAt: r.publishedAt ?? null, effectiveAt: r.effectiveAt ?? null, changeSummary: r.changeSummary,
      acceptances: Number(r.acceptances) || 0, hasArchive: Boolean(r.hasArchive),
    };
  });
}

export interface ManualVersionInput {
  code: unknown;
  permalink: unknown;
  /** Lot 104A : texte figé à vérifier (défaut : `<permalien>.html`, contrat § 3.2). */
  textUrl?: unknown;
  sha256: unknown;
  publishedAt: unknown;
  effectiveAt?: unknown;
  requiresReacceptance: unknown;
  changeSummary?: unknown;
  makeCurrent?: unknown;
}

export class ReferentialInputError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ReferentialInputError';
  }
}

/**
 * Saisie de secours dans le BO (manifeste momentanément illisible) : mêmes
 * règles que le manifeste (format, origine du site public, empreinte), source
 * BO_MANUAL. Le manifeste la confirme ensuite ; tout écart est signalé.
 */
export async function recordManualCguvVersion(
  input: ManualVersionInput,
  actorUserId: number,
  env: Env = process.env,
  opts: { fetchImpl?: FetchLike } = {},
): Promise<ReferentialRow> {
  const textUrl = typeof input.textUrl === 'string' && input.textUrl.trim()
    ? input.textUrl.trim()
    : (typeof input.permalink === 'string' && input.permalink.trim() ? `${input.permalink.trim().replace(/\/+$/, '')}.html` : undefined);
  const parsed = parseCguvManifest({
    schema: CGUV_MANIFEST_SCHEMA, document: 'CGUV', current: input.code,
    versions: [{
      code: input.code, permalink: input.permalink, textUrl,
      sha256: typeof input.sha256 === 'string' ? input.sha256.trim() : input.sha256,
      publishedAt: input.publishedAt, effectiveAt: input.effectiveAt ?? null,
      requiresReacceptance: input.requiresReacceptance, changeSummary: input.changeSummary,
    }],
  }, env);
  if (!parsed.ok) throw new ReferentialInputError('INVALID_VERSION', parsed.errors.join(' ; '));
  const v = parsed.manifest.versions[0];
  const existing = await db.select({ id: legalDocumentVersions.id }).from(legalDocumentVersions)
    .where(and(eq(legalDocumentVersions.documentType, DOCUMENT_TYPE_CGVU), eq(legalDocumentVersions.versionCode, v.code))).limit(1);
  if (existing.length > 0) throw new ReferentialInputError('VERSION_CODE_TAKEN', `La version ${v.code} existe déjà : une version n’est jamais modifiée.`);
  // Lot 104A (P1-C) : même exigence que le manifeste — octets du texte figé vérifiés AVANT tout enregistrement.
  const check = await verifyTextBytes(v.textUrl, v.sha256, { fetchImpl: opts.fetchImpl });
  if (!check.ok) {
    await recordLegalAudit({ action: 'MANIFEST_ANOMALY', actorUserId, versionCode: v.code, result: 'failure', details: `${anomalyKindFor(check.reason)} : saisie BO refusée — ${check.detail}` });
    throw new ReferentialInputError('TEXT_NOT_VERIFIED', `Version non enregistrée : ${check.detail}. Le texte figé doit être servi par le site public (${v.textUrl ?? 'adresse absente'}) avec exactement cette empreinte.`);
  }
  const now = new Date();
  const [row] = await db.insert(legalDocumentVersions).values({
    documentType: DOCUMENT_TYPE_CGVU, versionCode: v.code, title: CGUV_FULL_LABEL, status: 'PUBLISHED', source: 'BO_MANUAL',
    effectiveAt: v.effectiveAt, publishedAt: v.publishedAt, publishedBy: actorUserId,
    changeSummary: v.changeSummary ?? 'Version saisie dans le back-office (à confirmer par le manifeste).',
    requiresReacceptance: v.requiresReacceptance, permalink: v.permalink, sha256: v.sha256,
    createdAt: now, updatedAt: now,
  }).returning({ id: legalDocumentVersions.id });
  await recordLegalAudit({
    action: 'VERSION_MANUAL_ENTRY', actorUserId, versionCode: v.code, versionId: row.id,
    details: `sha256=${v.sha256} (octets vérifiés : ${check.bytes} o) ; substantielle=${v.requiresReacceptance ? 'oui' : 'non'} ; ${v.permalink}`,
  });
  if (input.makeCurrent === true) await setCurrentVersion(row.id, actorUserId);
  const { onCguvReferentialChanged } = await import('./cguv-reacceptance.service');
  onCguvReferentialChanged();
  const list = await listCguvReferential();
  return list.find((r) => r.id === row.id)!;
}

/** URL du manifeste lue (pour l'écran BO et le diagnostic). */
export function configuredManifestUrl(env: Env = process.env): string {
  return manifestUrl(env);
}
