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
  CGUV_FULL_LABEL, LEGAL_DOCUMENT_KEYS, LEGAL_URL_ENV, decideLegalLinksMode, legalLinksList, resolveLegalLinks,
  type LegalDocumentKey, type LegalLinks, type LegalLinksMode,
} from '@/lib/legal/public-legal';
import { serverCacheDelete, serverCacheGet, serverCacheSet } from '@/lib/server-cache';
import { recordLegalAudit } from './legal-audit.service';
import {
  DOCUMENT_TYPE_CGVU, getCurrentVersion, getVersionById, setCurrentVersion, type LegalVersion,
} from './legal-versions.service';
import {
  LEGAL_MANIFEST_DEFAULTS, fetchCguvManifest, manifestUrl, parseCguvManifest, publicSiteBase, verifyTextSha256,
  CGUV_MANIFEST_SCHEMA, type CguvManifest, type FetchLike,
} from './cguv-manifest';

type Env = Record<string, string | undefined>;

export type SyncTrigger = 'schedule' | 'manual' | 'bo' | 'seed' | 'startup';

export interface ReferentialAnomaly {
  kind:
    | 'VERSION_CHANGED_ON_SITE'
    | 'VERSION_MISSING_FROM_MANIFEST'
    | 'HASH_MISMATCH'
    | 'CURRENT_ROLLBACK_REFUSED'
    | 'LEGACY_DECISION_MISMATCH';
  code: string;
  detail: string;
}

export interface SyncResult {
  /** `awaiting_public_site` : manifeste jamais lu et absent — le site n'a pas encore livré (information). */
  status: 'ok' | 'ok_with_anomalies' | 'unavailable' | 'invalid' | 'awaiting_public_site';
  url: string;
  imported: string[];
  linkedLegacy: string[];
  current: string | null;
  anomalies: ReferentialAnomaly[];
  error?: string;
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
 * Permalien et empreinte qui IDENTIFIENT une version dans une preuve.
 *   · version publique (manifeste, saisie BO) : permalien et empreinte du site ;
 *   · archive APP_LEGACY republiée par le site : correspondance publique ;
 *   · archive APP_LEGACY seule : permalien historique de l'application
 *     (`/cguv/versions/<code>`, archive figée) et son empreinte d'origine.
 */
export function versionProofInfo(v: ProofSource, appBase: string = getAppBaseUrl()): { permalinkUrl: string; sha256: string | null } {
  if (v.source !== 'APP_LEGACY') return { permalinkUrl: v.permalink ?? '', sha256: v.sha256 };
  if (v.publicPermalink) return { permalinkUrl: v.publicPermalink, sha256: v.publicSha256 ?? v.sha256 };
  return {
    permalinkUrl: `${appBase.replace(/\/+$/, '')}/cguv/versions/${encodeURIComponent(v.versionCode)}`,
    sha256: v.sha256,
  };
}

export type ProofStatus = 'COMPLETE' | 'HISTORIQUE' | 'EN_ATTENTE_SITE_PUBLIC';

/**
 * Pur : statut d'une NOUVELLE preuve. Version connue seulement par son archive
 * applicative (le site public n'a pas encore livré ou republié cette version)
 * → « en attente du site public » ; sinon complète.
 */
export function proofStatusFor(v: Pick<LegalVersion, 'source' | 'publicPermalink'>): ProofStatus {
  return v.source === 'APP_LEGACY' && !v.publicPermalink ? 'EN_ATTENTE_SITE_PUBLIC' : 'COMPLETE';
}

/** Version courante présentée à l'utilisateur (métadonnées, aucun texte). */
export interface PublicCurrentCguv {
  versionCode: string;
  title: string;
  permalinkUrl: string;
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
    permalinkUrl: proof.permalinkUrl,
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
  };
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
 */
export async function applyCguvManifest(
  manifest: CguvManifest,
  opts: { actorUserId?: number | null; fetchImpl?: FetchLike; verifyTexts?: boolean } = {},
): Promise<{ imported: string[]; linkedLegacy: string[]; current: string | null; anomalies: ReferentialAnomaly[] }> {
  const rows = await db.select().from(legalDocumentVersions)
    .where(eq(legalDocumentVersions.documentType, DOCUMENT_TYPE_CGVU));
  const byCode = new Map(rows.map((r) => [r.versionCode, r]));
  const imported: string[] = [];
  const linkedLegacy: string[] = [];
  const anomalies: ReferentialAnomaly[] = [];
  const now = new Date();

  const ordered = [...manifest.versions].sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime());
  for (const v of ordered) {
    const row = byCode.get(v.code);
    if (!row) {
      if (opts.verifyTexts !== false && v.textUrl) {
        const ok = await verifyTextSha256(v.textUrl, v.sha256, { fetchImpl: opts.fetchImpl });
        if (ok === false) {
          anomalies.push({ kind: 'HASH_MISMATCH', code: v.code, detail: 'le texte figé servi ne correspond pas à l’empreinte du manifeste : version non importée' });
          continue;
        }
      }
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
          details: `sha256=${v.sha256} ; substantielle=${v.requiresReacceptance ? 'oui' : 'non'} ; ${v.permalink}`,
        });
      }
      continue;
    }

    if (row.source === 'APP_LEGACY') {
      if (row.requiresReacceptance !== v.requiresReacceptance) {
        anomalies.push({ kind: 'LEGACY_DECISION_MISMATCH', code: v.code, detail: `décision « substantielle » figée dans l’application (${row.requiresReacceptance ? 'oui' : 'non'}) différente du manifeste` });
      }
      if (!row.publicPermalink && !row.publicSha256) {
        await db.update(legalDocumentVersions)
          .set({ publicPermalink: v.permalink, publicSha256: v.sha256, syncedAt: now })
          .where(eq(legalDocumentVersions.id, row.id));
        linkedLegacy.push(v.code);
      } else if (row.publicPermalink !== v.permalink || row.publicSha256 !== v.sha256) {
        anomalies.push({ kind: 'VERSION_CHANGED_ON_SITE', code: v.code, detail: 'permalien ou empreinte publique différents de ceux enregistrés' });
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
  }

  // Version courante : celle du manifeste, si elle est importée.
  let current: string | null = (await getCurrentVersion(DOCUMENT_TYPE_CGVU))?.versionCode ?? null;
  const target = byCode.get(manifest.current);
  if (target && current !== manifest.current) {
    if (target.status === 'ARCHIVED') {
      anomalies.push({ kind: 'CURRENT_ROLLBACK_REFUSED', code: manifest.current, detail: 'une version archivée ne redevient pas courante : publier une nouvelle version' });
    } else {
      const fresh = await getVersionById(target.id);
      if (fresh) {
        await setCurrentVersion(fresh.id, opts.actorUserId ?? null);
        current = manifest.current;
      }
    }
  }

  for (const a of anomalies) {
    await recordLegalAudit({ action: 'MANIFEST_ANOMALY', actorUserId: opts.actorUserId, versionCode: a.code, result: 'failure', details: `${a.kind} : ${a.detail}` });
  }
  return { imported, linkedLegacy, current, anomalies };
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
    if (failures === 1 || opts.trigger === 'bo' || opts.trigger === 'manual') {
      await recordLegalAudit({ action: 'MANIFEST_SYNC_FAILED', actorUserId: opts.actorUserId, result: 'failure', details: `${status} : ${fetched.error} (${fetched.url})` });
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
          url: fetched.url, erreur: fetched.error, echecsConsecutifs: failures,
          dernierSucces: before?.lastSuccessAt?.toISOString() ?? null,
          versionCouranteConservee: lastKnownCurrent,
          action: 'Le dernier état connu continue de servir (aucun blocage). Vérifier la publication du manifeste par le site public, puis BO › CGUV › « Relire le manifeste ».',
        },
      });
    }
    return {
      status, url: fetched.url, imported: [], linkedLegacy: [], current: lastKnownCurrent,
      anomalies: [], error: fetched.error,
      lastKnown: { current: lastKnownCurrent, lastSuccessAt: before?.lastSuccessAt ?? null },
    };
  }

  const applied = await applyCguvManifest(fetched.manifest, { actorUserId: opts.actorUserId, fetchImpl: opts.fetchImpl });
  // Bascule automatique des liens légaux sur les nouvelles adresses /legal/….
  serverCacheDelete(MODE_CACHE_KEY);
  const status = applied.anomalies.length > 0 ? 'ok_with_anomalies' : 'ok';
  await writeState({
    manifestUrl: fetched.url, lastAttemptAt: now, lastSuccessAt: now, lastStatus: status, lastError: null,
    consecutiveFailures: 0, manifestSha256: fetched.sha256, currentVersionCode: applied.current,
    versionsCount: fetched.manifest.versions.length, anomalies: applied.anomalies, lastTrigger: opts.trigger,
  });
  const { reportAnomaly, autoResolveAnomaly } = await supervision();
  await autoResolveAnomaly(MANIFEST_UNAVAILABLE_FINGERPRINT, { origin: 'legal_manifest_sync', cause: `manifeste relu (${fetched.url})` });
  await autoResolveAnomaly(MANIFEST_AWAITING_FINGERPRINT, { origin: 'legal_manifest_sync', cause: `site public livré : manifeste lu (${fetched.url})` });
  if (applied.anomalies.length > 0) {
    await reportAnomaly({
      domain: 'other',
      fingerprint: MANIFEST_ANOMALY_FINGERPRINT,
      title: `Manifeste public des CGUV : ${applied.anomalies.length} écart(s) avec le référentiel`,
      detail: { url: fetched.url, ecarts: applied.anomalies.slice(0, 20), action: 'Une version publiée est immuable : corriger le manifeste côté site public (aucune correction automatique).' },
    });
  } else {
    await autoResolveAnomaly(MANIFEST_ANOMALY_FINGERPRINT, { origin: 'legal_manifest_sync', cause: 'aucun écart' });
  }
  if (applied.imported.length > 0 || applied.current !== lastKnownCurrent || opts.trigger === 'bo' || opts.trigger === 'manual') {
    await recordLegalAudit({
      action: 'MANIFEST_SYNCED', actorUserId: opts.actorUserId, versionCode: applied.current,
      details: `importées : ${applied.imported.join(', ') || 'aucune'} ; courante : ${applied.current ?? 'aucune'} ; écarts : ${applied.anomalies.length}`,
    });
  }
  return {
    status, url: fetched.url, imported: applied.imported, linkedLegacy: applied.linkedLegacy,
    current: applied.current, anomalies: applied.anomalies,
    lastKnown: { current: applied.current, lastSuccessAt: now },
  };
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
export async function recordManualCguvVersion(input: ManualVersionInput, actorUserId: number, env: Env = process.env): Promise<ReferentialRow> {
  const parsed = parseCguvManifest({
    schema: CGUV_MANIFEST_SCHEMA, document: 'CGUV', current: input.code,
    versions: [{
      code: input.code, permalink: input.permalink,
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
    details: `sha256=${v.sha256} ; substantielle=${v.requiresReacceptance ? 'oui' : 'non'} ; ${v.permalink}`,
  });
  if (input.makeCurrent === true) await setCurrentVersion(row.id, actorUserId);
  const list = await listCguvReferential();
  return list.find((r) => r.id === row.id)!;
}

/** URL du manifeste lue (pour l'écran BO et le diagnostic). */
export function configuredManifestUrl(env: Env = process.env): string {
  return manifestUrl(env);
}
