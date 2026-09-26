/**
 * Contenu de l'archive « Mes données » — CDC Back-Office V1 GDP-020.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * MODULE PUR : reçoit les lignes déjà lues, décide de ce qui sort.
 *
 * La collecte (`export-collector.ts`) ne tient pas une liste de tables : elle
 * parcourt le schéma, comme le workflow de suppression, pour qu'une nouvelle
 * table soit exportée sans qu'on y pense. Le revers est qu'elle ramène aussi
 * ce qui ne doit PAS sortir : secrets d'authentification, journaux internes
 * du support, commentaire interne RGPD (GDP-013), traces techniques. Ce
 * module est le filtre, et il est testé sans base.
 * ══════════════════════════════════════════════════════════════════════════
 */

/**
 * Tables jamais exportées.
 *  - sécurité : jetons, révocations, verrous — les exposer affaiblit le compte ;
 *  - interne support : journaux d'administration, invisibles de l'utilisateur ;
 *  - technique : files, idempotence, livraisons — aucune donnée personnelle
 *    utile, seulement la mécanique de traitement.
 */
export const EXCLUDED_TABLES: ReadonlySet<string> = new Set([
  // Sécurité / authentification
  'revoked_tokens', 'user_session_revocations', 'withdrawal_verification_tokens',
  'idempotency_keys', 'ai_operation_idempotency', 'ai_security_lock',
  // Journaux internes du support et de l'administration
  'admin_audit_log', 'ai_admin_audit_log', 'legal_audit_log', 'account_audit_log',
  // Mécanique technique
  '_migrations', 'job_locks', 'pending_blob_deletions', 'notification_outbox', 'notification_deliveries',
  'stripe_webhook_logs', 'ai_job_queue', 'ai_treatment_state', 'impact_queue',
  'ai_usage_event', 'ai_usage_events', 'ai_usage_account_counter',
  'verebona_ai_runs', 'verebona_request_runs', 'ai_pipeline_step', 'ai_pipeline_version',
  'field_origin_migration_audit', 'home_mascot_cache', 'home_mascot_generations',
  // L'export lui-même (clés de stockage)
  'gdpr_exports',
]);

/** Colonnes jamais exportées, quelle que soit la table. */
const OMITTED_COLUMN_PATTERNS: RegExp[] = [
  /password/i, /passwd/i, /(^|_)hash$/i, /_hash_/i, /secret/i, /token/i, /(^|_)otp(_|$)/i,
  /api_?key/i, /private_key/i, /(^|_)salt$/i, /^p256dh$/i, /^auth$/i, /^endpoint$/i,
  // Emplacements de stockage internes (les fichiers sont fournis à part).
  /^s3_(key|bucket|region)$/i, /^storage_path$/i, /^thumbnail_s3_key$/i,
];

/** Colonnes internes propres à certaines tables. */
const OMITTED_COLUMNS_BY_TABLE: Record<string, ReadonlySet<string>> = {
  // GDP-013 : commentaire interne invisible de l'utilisateur ; identifiants
  // des administrateurs et erreurs techniques du support.
  gdpr_requests: new Set([
    'internal_comment', 'last_error', 'created_by', 'updated_by', 'reopened_by', 'source_ref',
  ]),
  users: new Set(['role', 'feature_flags']),
  accounts: new Set(['feature_flags', 'checkout_session_id', 'checkout_session_created_at']),
  asset_files: new Set(['category_confidence', 'type_confidence']),
};

export function isColumnExported(table: string, column: string): boolean {
  if (OMITTED_COLUMNS_BY_TABLE[table]?.has(column)) return false;
  return !OMITTED_COLUMN_PATTERNS.some((re) => re.test(column));
}

/** Valeur JSON sûre : dates ISO, binaires omis, grands entiers en texte. */
export function toJsonValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return '[binaire omis]';
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toJsonValue(v)]));
  }
  return value;
}

export interface CollectedTable {
  table: string;
  rows: Record<string, unknown>[];
  /** Plafond de lignes atteint à la lecture. */
  truncated?: boolean;
}

export interface DocumentCandidate {
  id: number;
  originalFilename: string | null;
  filename: string | null;
  mimeType: string | null;
  size: number | null;
  s3Key: string | null;
  s3Bucket: string | null;
}

export interface DocumentPlan {
  include: Array<DocumentCandidate & { path: string }>;
  skipped: Array<{ id: number; name: string; reason: 'TOTAL_SIZE_LIMIT' | 'NO_STORED_FILE' }>;
  includedBytes: number;
}

function safeName(name: string): string {
  const cleaned = name.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return (cleaned || 'document').slice(0, 120);
}

/**
 * Sélection des fichiers joints à l'archive : dans l'ordre, jusqu'au plafond
 * de taille totale ; au-delà, listés comme non inclus (ils restent
 * téléchargeables dans l'application). Noms uniques, préfixés par l'id.
 */
export function planDocumentFiles(docs: DocumentCandidate[], maxTotalBytes: number): DocumentPlan {
  const plan: DocumentPlan = { include: [], skipped: [], includedBytes: 0 };
  for (const d of [...docs].sort((a, b) => a.id - b.id)) {
    const name = safeName(d.originalFilename || d.filename || `document-${d.id}`);
    if (!d.s3Key) {
      plan.skipped.push({ id: d.id, name, reason: 'NO_STORED_FILE' });
      continue;
    }
    const size = Math.max(0, Number(d.size ?? 0));
    if (plan.includedBytes + size > maxTotalBytes) {
      plan.skipped.push({ id: d.id, name, reason: 'TOTAL_SIZE_LIMIT' });
      continue;
    }
    plan.includedBytes += size;
    plan.include.push({ ...d, path: `documents/${d.id}_${name}` });
  }
  return plan;
}

export interface ExportManifest {
  format: 'verebona-gdpr-export';
  version: 1;
  generatedAt: string;
  subject: { userId: number; accountIds: number[] };
  tables: Array<{ table: string; rows: number; truncated: boolean; omittedColumns: string[] }>;
  excludedTables: string[];
  documents: { included: number; includedBytes: number; skipped: DocumentPlan['skipped'] };
}

export interface ExportContent {
  manifest: ExportManifest;
  /** Fichiers texte de l'archive (chemin → contenu). */
  textFiles: Record<string, string>;
}

/**
 * Construit le contenu textuel de l'archive à partir des tables lues.
 * Tables exclues écartées, colonnes sensibles retirées, valeurs normalisées,
 * tables vides omises, ordre stable.
 */
export function buildGdprExportContent(input: {
  generatedAt: Date;
  userId: number;
  accountIds: number[];
  tables: CollectedTable[];
  documents: DocumentPlan;
}): ExportContent {
  const textFiles: Record<string, string> = {};
  const manifestTables: ExportManifest['tables'] = [];
  const excluded = new Set<string>();

  const byTable = new Map<string, CollectedTable>();
  for (const t of input.tables) {
    if (EXCLUDED_TABLES.has(t.table)) { excluded.add(t.table); continue; }
    const prev = byTable.get(t.table);
    byTable.set(t.table, prev
      ? { table: t.table, rows: [...prev.rows, ...t.rows], truncated: prev.truncated || t.truncated }
      : t);
  }

  for (const table of [...byTable.keys()].sort()) {
    const t = byTable.get(table)!;
    const omitted = new Set<string>();
    const seen = new Set<string>();
    const rows: Record<string, unknown>[] = [];
    for (const row of t.rows) {
      const out: Record<string, unknown> = {};
      for (const [col, v] of Object.entries(row)) {
        if (isColumnExported(table, col)) out[col] = toJsonValue(v);
        else omitted.add(col);
      }
      // Une même ligne peut être atteinte par plusieurs chemins.
      const key = 'id' in row && row.id != null ? `id:${String(row.id)}` : JSON.stringify(out);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(out);
    }
    if (rows.length === 0) continue;
    rows.sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
    textFiles[`donnees/${table}.json`] = JSON.stringify(rows, null, 2);
    manifestTables.push({ table, rows: rows.length, truncated: !!t.truncated, omittedColumns: [...omitted].sort() });
  }

  const manifest: ExportManifest = {
    format: 'verebona-gdpr-export',
    version: 1,
    generatedAt: input.generatedAt.toISOString(),
    subject: { userId: input.userId, accountIds: [...input.accountIds].sort((a, b) => a - b) },
    tables: manifestTables,
    excludedTables: [...excluded].sort(),
    documents: {
      included: input.documents.include.length,
      includedBytes: input.documents.includedBytes,
      skipped: input.documents.skipped,
    },
  };
  textFiles['manifest.json'] = JSON.stringify(manifest, null, 2);
  textFiles['LISEZ-MOI.txt'] = readme(manifest);
  return { manifest, textFiles };
}

function readme(m: ExportManifest): string {
  const lines = [
    'EXPORT DE VOS DONNÉES PERSONNELLES — VEREBONA',
    '',
    `Généré le ${new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'long', timeStyle: 'short' }).format(new Date(m.generatedAt))}.`,
    '',
    'Cette archive contient les données de votre compte utilisateur et du compte',
    'Verebona auquel vous êtes rattaché, au format JSON (dossier « donnees »),',
    'ainsi que les documents que vous avez déposés (dossier « documents »).',
    '',
    'Chaque fichier JSON correspond à une catégorie de données (biens, documents,',
    'échéances, notifications…). Le fichier manifest.json en dresse l’inventaire.',
    '',
    'Ne figurent pas dans l’archive : les éléments de sécurité (mots de passe,',
    'jetons de session), les journaux techniques internes et les notes internes',
    'du support.',
  ];
  if (m.documents.skipped.some((s) => s.reason === 'TOTAL_SIZE_LIMIT')) {
    lines.push(
      '',
      `${m.documents.skipped.filter((s) => s.reason === 'TOTAL_SIZE_LIMIT').length} document(s) n’ont pas été joints`,
      'en raison de la taille de l’archive ; ils restent téléchargeables depuis',
      'l’application et sont listés dans manifest.json.',
    );
  }
  if (m.tables.some((t) => t.truncated)) {
    lines.push('', 'Certaines catégories très volumineuses ont été tronquées (voir manifest.json).');
  }
  return lines.join('\n') + '\n';
}
