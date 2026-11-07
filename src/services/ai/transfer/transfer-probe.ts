/**
 * Test d'ENVOI d'un fichier au fournisseur IA — lot 113R (carte #717).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI
 *
 * Le 6 novembre (compte 13, document 387), chaque analyse T1 échouait sur
 * « Upload Files API échoué : HTTP 403 » alors que le test de clé du BO
 * (liste des modèles + génération minimale) passait : il n'envoyait aucun
 * fichier. La réponse de Google était perdue ; le PO, sans accès à la base
 * ni au shell, ne pouvait pas établir la cause.
 *
 * Ce test envoie un PETIT PDF de test (aucune donnée utilisateur) par le
 * MÊME chemin que l'analyse (`transferBufferToFilesApi`), avec la clé et la
 * configuration EFFECTIVES, puis supprime le fichier. La réponse du
 * fournisseur est conservée sans secret (`ai_provider_transfer_checks`) et
 * rendue au BO : statut, code, message, raison, détails, identifiant de
 * requête. Aucune génération : aucun coût de modèle.
 *
 * Deux origines : `admin_test` (bouton du BO) et `auto_probe` (vérification
 * de rétablissement de `transfer-recovery`, avant toute reprise).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import type { AttachmentTransferFailure } from '../gateway/diagnostics/taxonomy';
import { transferHypotheses, type TransferHypothesis } from './transfer-hypotheses';

type Row = Record<string, unknown>;
type FetchLike = (input: string | Request, init?: RequestInit) => Promise<Response>;

/** PDF minimal valide (une page, texte neutre), sans aucune donnée utilisateur. */
export function probePdf(): Buffer {
  const objets = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const flux = 'BT /F1 10 Tf 10 50 Td (Verebona - test d envoi) Tj ET';
  objets[3] = `<< /Length ${flux.length} >>\nstream\n${flux}\nendstream`;
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objets.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objets.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

export const PROBE_FILE_NAME = 'verebona-test-envoi.pdf';

/** Configuration EFFECTIVE de l'envoi, sans secret (source de la clé par NOM). */
export interface TransferConfigView {
  provider: 'gemini';
  endpoint: string;
  apiVersion: 'v1beta';
  /** Vertex AI jamais utilisé (adaptateur Gemini, `vertexai: false`). */
  vertexai: false;
  keySource: 'BO_ACTIVE_CREDENTIAL' | 'ENV' | 'NONE';
  /** Identifiant de la clé active du BO (jamais sa valeur). */
  credentialId: number | null;
  /** Variable d'environnement retenue (NOM seulement). */
  envVariable: string | null;
  /** Variables consultées, par ordre (NOMS seulement). */
  envVariablesConsulted: string[];
}

export async function effectiveTransferConfig(): Promise<TransferConfigView> {
  let credentialId: number | null = null;
  try {
    const rows = (await pgClient.unsafe(
      `SELECT id FROM ai_provider_credential WHERE provider = 'gemini' AND status = 'ACTIVE' LIMIT 1`,
    )) as unknown as Row[];
    if (rows[0]) credentialId = Number(rows[0].id);
  } catch { /* table absente : environnement */ }
  const envVariable = credentialId !== null ? null
    : process.env.GEMINI_API_KEY ? 'GEMINI_API_KEY' : process.env.GOOGLE_AI_API_KEY ? 'GOOGLE_AI_API_KEY' : null;
  return {
    provider: 'gemini', endpoint: 'POST generativelanguage.googleapis.com/upload/v1beta/files', apiVersion: 'v1beta', vertexai: false,
    keySource: credentialId !== null ? 'BO_ACTIVE_CREDENTIAL' : envVariable ? 'ENV' : 'NONE',
    credentialId, envVariable, envVariablesConsulted: ['GEMINI_API_KEY', 'GOOGLE_AI_API_KEY'],
  };
}

export interface TransferCheckView {
  id: number | null;
  createdAt: string;
  origin: 'admin_test' | 'auto_probe';
  ok: boolean;
  /** Fichier accepté puis devenu ACTIVE (`ACTIVE`), ou état constaté. */
  fileState: string | null;
  /** Fichier de test supprimé chez le fournisseur après l'essai. */
  cleanupOk: boolean | null;
  durationMs: number | null;
  failure: AttachmentTransferFailure | null;
  /** Échec LOCAL (aucune clé, construction impossible) — jamais une réponse du fournisseur. */
  localError: string | null;
  config: TransferConfigView | Record<string, unknown>;
  /** Pistes à confirmer (jamais une conclusion). */
  hypotheses: TransferHypothesis[];
}

let fetchForTests: FetchLike | null = null;
/** Réservé aux tests : fournisseur simulé de la Files API. */
export function __setTransferProbeFetchForTests(f: FetchLike | null): void { fetchForTests = f; }

/**
 * Envoie le PDF de test par le chemin de l'analyse, supprime le fichier,
 * conserve et rend le résultat. Ne lève jamais.
 */
export async function runTransferProbe(p: { origin: 'admin_test' | 'auto_probe'; adminUserId?: number | null }): Promise<TransferCheckView> {
  const started = Date.now();
  const fetchImpl: FetchLike = fetchForTests ?? fetch;
  const config = await effectiveTransferConfig().catch(() => ({} as Record<string, unknown>));
  const { getProviderSecret } = await import('../provider/provider-secret');
  const { transferBufferToFilesApi, AttachmentRequestBuildError, transferFailureOf, sanitizeTransferText } = await import('../gateway/providers/gemini-files');
  const secret = await getProviderSecret('gemini');
  let failure: AttachmentTransferFailure | null = null;
  let localError: string | null = null;
  let fileState: string | null = null;
  let cleanupOk: boolean | null = null;
  if (!secret) {
    localError = 'Aucune clé fournisseur configurée (BO, GEMINI_API_KEY ni GOOGLE_AI_API_KEY) : aucun envoi tenté.';
  } else {
    try {
      const uri = await transferBufferToFilesApi(probePdf(), { mimeType: 'application/pdf', displayName: PROBE_FILE_NAME }, secret, fetchImpl);
      fileState = 'ACTIVE';
      const name = uri.split('/files/')[1];
      if (name) {
        try {
          const del = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/files/${name}?key=${secret}`, { method: 'DELETE' });
          cleanupOk = del.ok;
        } catch { cleanupOk = false; }
      }
    } catch (e) {
      failure = transferFailureOf(e);
      if (!failure) {
        localError = e instanceof AttachmentRequestBuildError
          ? `Échec local avant envoi : ${e.message}`
          : `Échec local avant envoi : ${sanitizeTransferText(e instanceof Error ? e.message : String(e), secret).slice(0, 300)}`;
      }
    }
  }
  const view: TransferCheckView = {
    id: null, createdAt: new Date().toISOString(), origin: p.origin, ok: failure === null && localError === null,
    fileState, cleanupOk, durationMs: Date.now() - started, failure, localError, config,
    hypotheses: transferHypotheses(failure),
  };
  view.id = await recordTransferCheck(view, p.adminUserId ?? null).catch(() => null);
  return view;
}

function dbDisponible(): boolean {
  return !(process.env.NODE_ENV === 'test' && !process.env.DATABASE_URL);
}

async function recordTransferCheck(v: TransferCheckView, adminUserId: number | null): Promise<number | null> {
  if (!dbDisponible()) return null;
  const f = v.failure;
  const rows = (await pgClient.unsafe(
    `INSERT INTO ai_provider_transfer_checks
       (origin, triggered_by, provider, ok, step, endpoint, http_status, provider_status, provider_code, provider_message,
        provider_reason, request_id, provider_detail, failure, config, duration_ms, file_state, cleanup_ok)
     VALUES ($1, $2, 'gemini', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15, $16, $17)
     RETURNING id`,
    [
      v.origin, adminUserId, v.ok, f?.step ?? null, f?.endpoint ?? null, f?.httpStatus ?? null, f?.providerStatus ?? null,
      f?.providerCode ?? null, f?.providerMessage ?? null, f?.providerReason ?? null, f?.requestId ?? null, f?.providerDetail ?? null,
      f ? JSON.stringify(f) : (v.localError ? JSON.stringify({ localError: v.localError }) : null),
      JSON.stringify(v.config ?? {}), v.durationMs, v.fileState, v.cleanupOk,
    ] as never[],
  )) as unknown as Row[];
  return rows[0] ? Number(rows[0].id) : null;
}

function toView(r: Row): TransferCheckView {
  const failureRaw = (typeof r.failure === 'string' ? JSON.parse(r.failure) : r.failure) as Record<string, unknown> | null;
  const failure = failureRaw && failureRaw.format === 'transfer-v1' ? failureRaw as unknown as AttachmentTransferFailure : null;
  return {
    id: Number(r.id), createdAt: new Date(String(r.created_at)).toISOString(),
    origin: r.origin === 'admin_test' ? 'admin_test' : 'auto_probe', ok: Boolean(r.ok),
    fileState: r.file_state == null ? null : String(r.file_state),
    cleanupOk: r.cleanup_ok == null ? null : Boolean(r.cleanup_ok),
    durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
    failure, localError: failureRaw && typeof failureRaw.localError === 'string' ? failureRaw.localError : null,
    config: (typeof r.config === 'string' ? JSON.parse(r.config) : r.config ?? {}) as Record<string, unknown>,
    hypotheses: transferHypotheses(failure),
  };
}

/** Dernières vérifications d'envoi (BO), plus récentes d'abord. */
export async function listTransferChecks(limit = 10): Promise<TransferCheckView[]> {
  if (!dbDisponible()) return [];
  try {
    const rows = (await pgClient.unsafe(
      `SELECT * FROM ai_provider_transfer_checks ORDER BY id DESC LIMIT $1`, [Math.min(Math.max(1, limit), 50)] as never[],
    )) as unknown as Row[];
    return rows.map(toView);
  } catch (e) {
    if ((e as { code?: string }).code === '42P01') return [];
    throw e;
  }
}

/** Rétention explicite des vérifications (jours, 365 par défaut, borné à [30, 3650]). */
export function transferCheckRetentionDays(): number {
  const n = Number(process.env.AI_TRANSFER_CHECK_RETENTION_DAYS);
  return Number.isFinite(n) && n >= 30 ? Math.min(Math.floor(n), 3650) : 365;
}

export async function purgeOldTransferChecks(): Promise<number> {
  if (!dbDisponible()) return 0;
  try {
    const rows = (await pgClient.unsafe(
      `DELETE FROM ai_provider_transfer_checks WHERE created_at < NOW() - ($1 || ' days')::interval RETURNING id`,
      [String(transferCheckRetentionDays())] as never[],
    )) as unknown as Row[];
    return rows.length;
  } catch {
    return 0;
  }
}
