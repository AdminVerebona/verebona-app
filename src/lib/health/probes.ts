/**
 * Sondes de santé bornées (APP-PERF-37).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TROIS CONTRATS, TROIS CONSOMMATEURS
 *
 *   GET /api/health/live   VITALITÉ — le processus répond. Aucune E/S :
 *                          toujours 200. À utiliser pour une décision de
 *                          REDÉMARRAGE : une panne de base ou de stockage ne
 *                          doit jamais provoquer une boucle de redémarrages.
 *   GET /api/health/ready  DISPONIBILITÉ CRITIQUE — base joignable ET schéma
 *                          critique appliqué (APP-PERF-16). 200 `ready`,
 *                          503 `not_ready`. À utiliser pour ROUTER le trafic
 *                          ou valider un déploiement. Le stockage S3 n'en fait
 *                          pas partie : sans lui, l'application sert encore
 *                          comptes, fiches et agenda (mode dégradé).
 *   GET /api/health        DIAGNOSTIC — endpoint historique conservé (même
 *                          forme, mêmes codes : 200 `ok`/`degraded`, 503
 *                          `down` si la base ne répond pas). Détails (messages
 *                          SQL, causes S3, variables) réservés à l'en-tête
 *                          `x-health-token` = HEALTH_DIAGNOSTIC_TOKEN.
 *
 * BORNES : chaque contrôle a son délai, ils s'exécutent en parallèle (le
 * total est celui du plus long). Un contrôle en vol est PARTAGÉ par les
 * appels concurrents et son résultat gardé un court instant : une dépendance
 * bloquée et des sondes à haute fréquence n'accumulent pas de requêtes.
 * Le SELECT 1 mesure la joignabilité, pas les requêtes métier (APM).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { db, getSchemaReadiness, type SchemaReadiness } from '@/db';
import { classifyS3Error, getS3Bucket, getS3Client, s3ConfigDiagnostics } from '@/lib/s3-config';

export const HEALTH_BUDGET_MS = {
  database: 1_500,
  schema: 1_500,
  s3: 3_000,
} as const;

/** Durée de conservation d'un résultat (ms) : bornes de fréquence réelle. */
export const HEALTH_CACHE_MS = {
  database: 2_000,
  s3: 30_000,
} as const;

export type ProbeStatus = 'ok' | 'error' | 'timeout';

export interface ProbeResult {
  status: ProbeStatus;
  responseTime: number;
  /** Code public (TIMEOUT, UNAVAILABLE, ACCESS_DENIED…). */
  code?: string;
  /** Détail technique — jamais renvoyé sans autorisation de diagnostic. */
  detail?: string;
  /** Horodatage de la mesure (le résultat peut venir du cache). */
  checkedAt: string;
}

class DelaiDepasse extends Error {
  constructor(ms: number) { super(`délai de ${ms} ms dépassé`); }
}

export function withDeadline<T>(p: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => { onTimeout?.(); reject(new DelaiDepasse(ms)); }, ms);
    t.unref?.();
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

interface Memo { enVol: Promise<ProbeResult> | null; dernier: ProbeResult | null; at: number }
const memos = new Map<string, Memo>();

/** Un seul contrôle en vol par clé ; résultat réutilisé pendant `ttlMs`. */
function partage(cle: string, ttlMs: number, fn: () => Promise<ProbeResult>): Promise<ProbeResult> {
  let m = memos.get(cle);
  if (!m) { m = { enVol: null, dernier: null, at: 0 }; memos.set(cle, m); }
  if (m.dernier && Date.now() - m.at < ttlMs) return Promise.resolve(m.dernier);
  if (m.enVol) return m.enVol;
  const memo = m;
  memo.enVol = fn().then((r) => {
    memo.dernier = r;
    memo.at = Date.now();
    return r;
  }).finally(() => { memo.enVol = null; });
  return memo.enVol;
}

/** Tests uniquement. */
export function resetHealthProbesForTests(): void {
  memos.clear();
}

export function probeDatabase(): Promise<ProbeResult> {
  return partage('database', HEALTH_CACHE_MS.database, async () => {
    const debut = Date.now();
    try {
      await withDeadline(db.execute(sql`SELECT 1`), HEALTH_BUDGET_MS.database);
      return { status: 'ok', responseTime: Date.now() - debut, checkedAt: new Date().toISOString() };
    } catch (e) {
      const timeout = e instanceof DelaiDepasse;
      console.error(`[HEALTH] base : ${timeout ? 'délai dépassé' : (e as Error).message}`);
      return {
        status: timeout ? 'timeout' : 'error',
        responseTime: Date.now() - debut,
        code: timeout ? 'TIMEOUT' : 'UNAVAILABLE',
        detail: (e as Error).message?.slice(0, 300),
        checkedAt: new Date().toISOString(),
      };
    }
  });
}

export interface S3ProbeResult extends ProbeResult {
  configured: boolean;
  /** Configuration partielle ou contradictoire. */
  misconfigured: boolean;
  configErrors: string[];
  configWarnings: string[];
}

export async function probeS3(): Promise<S3ProbeResult> {
  const diag = s3ConfigDiagnostics();
  const misconfigured = !diag.configured
    && (diag.errors.some((e) => e.code !== 'MISSING') || diag.errors.length < 4);
  const base = {
    configured: diag.configured,
    misconfigured,
    configErrors: diag.errors.map((e) => e.message),
    configWarnings: diag.warnings.map((w) => w.message),
  };
  if (!diag.configured) {
    return { ...base, status: 'error', responseTime: 0, code: 'NOT_CONFIGURED', checkedAt: new Date().toISOString() };
  }
  // Appel RÉSEAU réel (une signature locale ne prouve rien), annulé au délai.
  const r = await partage('s3', HEALTH_CACHE_MS.s3, async () => {
    const controller = new AbortController();
    const debut = Date.now();
    try {
      await withDeadline(
        getS3Client('interactive').send(new ListObjectsV2Command({ Bucket: getS3Bucket(), MaxKeys: 1 }), { abortSignal: controller.signal }),
        HEALTH_BUDGET_MS.s3,
        () => controller.abort(),
      );
      return { status: 'ok', responseTime: Date.now() - debut, checkedAt: new Date().toISOString() };
    } catch (error) {
      const timeout = error instanceof DelaiDepasse || controller.signal.aborted;
      const info = classifyS3Error(error);
      const kind = timeout ? 'TIMEOUT' : info.kind;
      console.error(`[HEALTH] S3 : ${kind} (${info.name})`);
      return {
        status: timeout ? 'timeout' : 'error',
        responseTime: Date.now() - debut,
        code: kind,
        detail: `${info.name}${info.httpStatus ? `, HTTP ${info.httpStatus}` : ''}`,
        checkedAt: new Date().toISOString(),
      };
    }
  });
  return { ...base, ...r };
}

/** Schéma critique, borné. Une lecture impossible vaut « non prêt ». */
export async function probeSchema(): Promise<SchemaReadiness> {
  try {
    return await withDeadline(getSchemaReadiness({ timeoutMs: HEALTH_BUDGET_MS.schema }), HEALTH_BUDGET_MS.schema + 250);
  } catch {
    return { ready: false, phase: 'unknown', pendingCritical: 0, pendingOptional: 0, firstFailure: null };
  }
}

/**
 * Diagnostic détaillé autorisé ? En-tête `x-health-token` égal à
 * HEALTH_DIAGNOSTIC_TOKEN (16 caractères au moins). Sans variable : jamais.
 */
export function isDiagnosticAuthorized(headers: Headers, env: Record<string, string | undefined> = process.env): boolean {
  const attendu = (env.HEALTH_DIAGNOSTIC_TOKEN ?? '').trim();
  const recu = headers.get('x-health-token') ?? '';
  if (attendu.length < 16 || !recu) return false;
  const a = Buffer.from(attendu);
  const b = Buffer.from(recu);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const NO_STORE_HEADERS = {
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  'Pragma': 'no-cache',
  'Expires': '0',
} as const;
