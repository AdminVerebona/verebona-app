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
import { downloadFilename, makeUniqueNamer } from '@/lib/download-filename';

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
  // Lot 92 : registre des sessions (empreintes) et preuves de réauthentification.
  'user_sessions', 'reauth_proofs',
  // Lot 96A : demandes de changement d'adresse (empreintes de liens).
  'email_change_requests',
  // Lot 100D (A3) : étiquettes de transition des appareils reconnus (empreintes).
  'device_trust_legacy_accounts',
  'idempotency_keys', 'ai_operation_idempotency', 'ai_security_lock',
  // Journaux internes du support et de l'administration
  'admin_audit_log', 'ai_admin_audit_log', 'legal_audit_log', 'account_audit_log',
  // Mécanique technique
  '_migrations', 'job_locks', 'pending_blob_deletions', 'notification_outbox', 'notification_deliveries',
  'stripe_webhook_logs', 'ai_job_queue', 'ai_treatment_state', 'impact_queue',
  'ai_usage_event', 'ai_usage_events', 'ai_usage_account_counter',
  'verebona_ai_runs', 'verebona_request_runs', 'ai_pipeline_step', 'ai_pipeline_version',
  'field_origin_migration_audit', 'home_mascot_cache', 'home_mascot_generations',
  // Miniatures des documents : dérivés techniques régénérables (0241).
  'asset_file_thumbnails',
  // L'export lui-même (clés de stockage) ; lot 102C : ses parties.
  'gdpr_exports', 'gdpr_export_parts',
  // Lot 102C : registre d'exploitation des copies de données réelles (sans utilisateur).
  'production_data_copies',
  // Lot 104A : sujets des copies (empreintes) et état de la propagation — exploitation, sans contenu utile.
  'production_copy_subjects', 'production_deletion_signal_state',
]);

/**
 * Lot 103C (§3 E, isolation des espaces partagés — Premium Duo) — tables
 * PERSONNELLES : leurs lignes appartiennent à UN utilisateur même quand
 * elles portent l'identifiant du compte partagé (conversations de
 * l'assistant, préférences, appareils, e-mails reçus, factures du payeur…).
 * Seules y sont retenues les lignes de l'utilisateur exporté, ou les lignes
 * « de compte » sans utilisateur (traitement système). Un membre Duo ne
 * reçoit donc jamais les conversations ou les appareils de l'autre membre,
 * alors que les biens, documents, échéances du compte partagé — auxquels il
 * a accès dans l'application — restent exportés.
 */
export const PERSONAL_TABLES: ReadonlySet<string> = new Set([
  'verebona_conversations', 'verebona_feedback', 'verebona_command_plans', 'verebona_command_events',
  'verebona_command_undo_steps', 'verebona_clarification_events', 'verebona_fact_revalidations',
  'ai_search_log', 'ai_call_captures', 'mobile_push_installations', 'calendar_additions',
  't6_reminder_preferences', 'to_process_digest_state', 'gdpr_requests', 'trial_lifecycle_messages',
  'trial_lifecycle_events', 'signup_contexts', 'funnel_events', 'home_mascot_events', 'withdrawal_requests',
  'scheduled_account_deletions', 'invoices', 'subscription_communication_operations', 'marketing_oppositions',
  'marketing_collection_proofs', 'notification_preferences', 'notifications', 'home_suggestion_skips', 'shared_suggestion_consultations',
]);

/**
 * Lot 103C — tables filles d'une table personnelle SANS clé étrangère
 * déclarée : jamais collectées par le compte (elles mêleraient les deux
 * membres d'un Duo), seulement à partir des lignes parentes retenues.
 */
export const CHILD_SCOPED_TABLES: Readonly<Record<string, { column: string; parent: string; parentColumn: string }>> = {
  verebona_messages: { column: 'conversation_id', parent: 'verebona_conversations', parentColumn: 'id' },
  verebona_presented_entities: { column: 'conversation_id', parent: 'verebona_conversations', parentColumn: 'id' },
};

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
  accounts: new Set(['feature_flags', 'checkout_session_id', 'checkout_session_created_at', 'checkout_check_attempts', 'checkout_next_check_at']),
  asset_files: new Set(['category_confidence', 'type_confidence']),
  // Lot 97 : appareils mobiles — plateforme, version, statut exportés ; jeton (déjà omis par motif) et session jamais.
  mobile_push_installations: new Set(['push_token_enc', 'push_token_hash', 'session_id']),
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
  /** Nom affiché dans Verebona (lot 75L) : nom du fichier dans l'archive. */
  retainedTitle?: string | null;
  publicId?: string | null;
  mimeType: string | null;
  size: number | null;
  s3Key: string | null;
  s3Bucket: string | null;
}

interface DocumentPlan {
  include: Array<DocumentCandidate & { path: string }>;
  skipped: Array<{ id: number; name: string; reason: 'TOTAL_SIZE_LIMIT' | 'NO_STORED_FILE' | 'PART_LIMIT' }>;
  includedBytes: number;
}

/** Lot 102C : une partie de l'archive (numérotée à partir de 1). */
export interface ExportPartPlan {
  number: number;
  documents: Array<DocumentCandidate & { path: string }>;
  bytes: number;
}

/** Lot 102C : documents répartis en parties de taille bornée. */
export interface PartedDocumentPlan extends DocumentPlan {
  parts: ExportPartPlan[];
}

/**
 * Lot 102C (ticket conformité, P2 export RGPD) — répartition de TOUS les
 * documents en parties numérotées de taille bornée, au lieu d'un plafond
 * global au-delà duquel les documents n'étaient pas joints.
 *
 *   · ordre stable (identifiant), noms uniques sur toute l'archive (une
 *     partie extraite dans le même dossier qu'une autre n'écrase rien) ;
 *   · une partie se ferme quand le document suivant la ferait dépasser
 *     `maxPartBytes` ; un document plus gros que la borne occupe seul sa
 *     partie (jamais coupé, jamais omis) ;
 *   · la partie 1 existe toujours (données JSON, manifeste global) ;
 *   · garde-fou `maxParts` : au-delà, documents listés `PART_LIMIT` (cas
 *     théorique — les quotas d'offre le rendent inatteignable avec les
 *     réglages par défaut) et signalés dans le manifeste.
 * Pur, testé sans base.
 */
export function planExportParts(docs: DocumentCandidate[], opts: { maxPartBytes: number; maxParts: number }): PartedDocumentPlan {
  const maxPartBytes = Math.max(1, Math.floor(opts.maxPartBytes));
  const maxParts = Math.max(1, Math.floor(opts.maxParts));
  const plan: PartedDocumentPlan = { include: [], skipped: [], includedBytes: 0, parts: [{ number: 1, documents: [], bytes: 0 }] };
  const uniqueName = makeUniqueNamer();
  for (const d of [...docs].sort((a, b) => a.id - b.id)) {
    const name = downloadFilename(d);
    if (!d.s3Key) {
      plan.skipped.push({ id: d.id, name, reason: 'NO_STORED_FILE' });
      continue;
    }
    const size = Math.max(0, Number(d.size ?? 0));
    let current = plan.parts[plan.parts.length - 1];
    if (current.documents.length > 0 && current.bytes + size > maxPartBytes) {
      if (plan.parts.length >= maxParts) {
        plan.skipped.push({ id: d.id, name, reason: 'PART_LIMIT' });
        continue;
      }
      current = { number: plan.parts.length + 1, documents: [], bytes: 0 };
      plan.parts.push(current);
    }
    const entry = { ...d, path: uniqueName(name, 'documents') };
    current.documents.push(entry);
    current.bytes += size;
    plan.include.push(entry);
    plan.includedBytes += size;
  }
  return plan;
}

/** Manifeste propre à une partie (`manifest-partie-N.json`). */
export function partManifest(input: { generatedAt: Date; part: ExportPartPlan; totalParts: number }): string {
  return JSON.stringify({
    format: 'verebona-gdpr-export-part',
    version: 1,
    generatedAt: input.generatedAt.toISOString(),
    part: input.part.number,
    totalParts: input.totalParts,
    contenu: input.part.number === 1
      ? 'Données de votre compte (dossier « donnees »), manifeste global (manifest.json) et premiers documents.'
      : 'Documents seulement (dossier « documents »). Le manifeste global se trouve dans la partie 1.',
    documents: input.part.documents.map((d) => ({ id: d.id, path: d.path, size: d.size ?? null })),
    documentsBytes: input.part.bytes,
  }, null, 2);
}


/**
 * Sélection des fichiers joints à l'archive : dans l'ordre, jusqu'au plafond
 * de taille totale ; au-delà, listés comme non inclus (ils restent
 * téléchargeables dans l'application). Noms uniques (nom affiché, « (2) »).
 */
export function planDocumentFiles(docs: DocumentCandidate[], maxTotalBytes: number): DocumentPlan {
  const plan: DocumentPlan = { include: [], skipped: [], includedBytes: 0 };
  // Lot 75L : nom affiché dans Verebona + extension réelle (règle commune du
  // téléchargement), doublons « (2) ». La correspondance identifiant → fichier
  // figure dans `manifest.json` (documents.files).
  const uniqueName = makeUniqueNamer();
  for (const d of [...docs].sort((a, b) => a.id - b.id)) {
    const name = downloadFilename(d);
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
    plan.include.push({ ...d, path: uniqueName(name, 'documents') });
  }
  return plan;
}

export interface ExportManifest {
  format: 'verebona-gdpr-export';
  /** 1 : archive unique (historique) ; 2 : archive en parties (lot 102C). */
  version: 1 | 2;
  generatedAt: string;
  subject: { userId: number; accountIds: number[] };
  tables: Array<{ table: string; rows: number; truncated: boolean; omittedColumns: string[] }>;
  excludedTables: string[];
  documents: { included: number; includedBytes: number; skipped: DocumentPlan['skipped']; files: Array<{ id: number; path: string }> };
  /** Lot 102C : contenu de chaque partie (absent : archive unique). */
  parts?: Array<{ part: number; fileName: string; documents: number; documentsBytes: number; files: Array<{ id: number; path: string }> }>;
}

interface ExportContent {
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
  /** Lot 102C : parties et nom de fichier de chacune (archive en parties). */
  parts?: Array<{ plan: ExportPartPlan; fileName: string }>;
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
    version: input.parts ? 2 : 1,
    generatedAt: input.generatedAt.toISOString(),
    subject: { userId: input.userId, accountIds: [...input.accountIds].sort((a, b) => a - b) },
    tables: manifestTables,
    excludedTables: [...excluded].sort(),
    documents: {
      included: input.documents.include.length,
      includedBytes: input.documents.includedBytes,
      skipped: input.documents.skipped,
      files: input.documents.include.map((d) => ({ id: d.id, path: d.path })),
    },
    ...(input.parts ? {
      parts: input.parts.map(({ plan, fileName }) => ({
        part: plan.number, fileName, documents: plan.documents.length, documentsBytes: plan.bytes,
        files: plan.documents.map((d) => ({ id: d.id, path: d.path })),
      })),
    } : {}),
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
    'Les documents portent le nom affiché dans Verebona ; manifest.json',
    '(rubrique documents.files) indique l’identifiant de chacun.',
    '',
    'Chaque fichier JSON correspond à une catégorie de données (biens, documents,',
    'échéances, notifications…). Le fichier manifest.json en dresse l’inventaire.',
    '',
    'Ne figurent pas dans l’archive : les éléments de sécurité (mots de passe,',
    'jetons de session), les journaux techniques internes et les notes internes',
    'du support.',
  ];
  if (m.parts && m.parts.length > 1) {
    lines.push(
      '',
      `Votre archive est découpée en ${m.parts.length} parties numérotées. Celle-ci est la partie 1 :`,
      'elle contient vos données et le présent inventaire. Les autres parties contiennent',
      'la suite de vos documents ; chacune porte son propre inventaire',
      '(manifest-partie-N.json). La rubrique « parts » de manifest.json indique le',
      'contenu de chaque partie. Téléchargez toutes les parties depuis Mon compte.',
    );
  }
  if (m.documents.skipped.some((s) => s.reason === 'PART_LIMIT')) {
    lines.push(
      '',
      `${m.documents.skipped.filter((s) => s.reason === 'PART_LIMIT').length} document(s) n’ont pas pu être répartis dans les parties`,
      '(nombre maximal de parties atteint) ; ils sont listés dans manifest.json et',
      'restent téléchargeables depuis l’application. Contactez le support si besoin.',
    );
  }
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

/* ══════════════════════════════════════════════════════════════════════════
 * Lot 103C — archive construite en flux, manifeste tiré des fichiers RÉELS
 *
 * Le manifeste (v3) n'est plus écrit d'après le plan : il est construit à la
 * fin, à partir des fichiers effectivement écrits dans l'archive (taille et
 * empreinte SHA-256 de chacun) et de l'inventaire précis de ce qui manque.
 * Une archive à laquelle il manque quoi que ce soit est PARTIELLE — jamais
 * présentée comme l'export exhaustif.
 * ══════════════════════════════════════════════════════════════════════════ */

/** Ligne filtrée (colonnes exportables, valeurs JSON sûres) et colonnes retirées. */
export function filterRow(table: string, row: Record<string, unknown>): { out: Record<string, unknown>; omitted: string[] } {
  const out: Record<string, unknown> = {};
  const omitted: string[] = [];
  for (const [col, v] of Object.entries(row)) {
    if (isColumnExported(table, col)) out[col] = toJsonValue(v);
    else omitted.push(col);
  }
  return { out, omitted };
}

/** Motif d'un manque, stable (manifeste, Supervision, interface). */
export type MissingReason =
  /** Objet absent du stockage (supprimé, jamais déposé). */
  | 'OBJECT_MISSING'
  /** Lecture du stockage en échec après les nouvelles tentatives. */
  | 'READ_FAILED'
  /** Nombre maximal de parties atteint (GDPR_EXPORT_MAX_PARTS). */
  | 'PART_LIMIT'
  /** Garde-fou de lignes par table atteint (GDPR_EXPORT_MAX_ROWS_PER_TABLE). */
  | 'ROW_LIMIT'
  /** Garde-fou de profondeur des liens entre tables atteint. */
  | 'DEPTH_LIMIT';

export type MissingItem =
  | { kind: 'document'; id: number; name: string; reason: MissingReason }
  | { kind: 'table'; table: string; reason: MissingReason };

export const MISSING_REASON_LABELS: Record<MissingReason, string> = {
  OBJECT_MISSING: 'fichier introuvable dans le stockage',
  READ_FAILED: 'lecture du stockage impossible pour le moment',
  PART_LIMIT: 'nombre maximal de parties atteint',
  ROW_LIMIT: 'catégorie très volumineuse, lue en partie seulement',
  DEPTH_LIMIT: 'liens entre données trop profonds, lus en partie seulement',
};

export interface WrittenFile { path: string; bytes: number; sha256: string }
export interface WrittenDocument extends WrittenFile { id: number; part: number }
export interface TableStat { table: string; rows: number; omittedColumns: string[]; file: WrittenFile | null; complete: boolean }

export interface ManifestV3 {
  format: 'verebona-gdpr-export';
  version: 3;
  generatedAt: string;
  /** COMPLET : tout ce qui est exportable est présent ; PARTIEL : voir `missing`. */
  status: 'COMPLET' | 'PARTIEL';
  subject: { userId: number; accountIds: number[] };
  tables: Array<{ table: string; rows: number; truncated: boolean; file: string; bytes: number; sha256: string; omittedColumns: string[] }>;
  excludedTables: string[];
  documents: {
    expected: number;
    included: number;
    includedBytes: number;
    /** Documents non joints, avec motif (dont les fiches sans fichier déposé). */
    skipped: Array<{ id: number; name: string; reason: string }>;
    files: Array<{ id: number; path: string; part: number; bytes: number; sha256: string }>;
  };
  missing: MissingItem[];
  parts: Array<{ part: number; fileName: string; documents: number; documentsBytes: number; files: Array<{ id: number; path: string }> }>;
  integrity: { algorithm: 'sha256'; note: string };
}

/** COMPLET / PARTIEL d'après l'inventaire des manques (pur). */
export function completenessOf(missing: readonly MissingItem[]): 'complete' | 'partial' {
  return missing.length === 0 ? 'complete' : 'partial';
}

export function buildFinalManifest(input: {
  generatedAt: Date;
  userId: number;
  accountIds: number[];
  tables: TableStat[];
  excludedTables: string[];
  expectedDocuments: number;
  documents: WrittenDocument[];
  /** Fiches documentaires sans fichier déposé (NO_STORED_FILE) : rien à récupérer. */
  withoutStoredFile: Array<{ id: number; name: string }>;
  missing: MissingItem[];
  parts: Array<{ part: number; fileName: string; files: WrittenDocument[] }>;
}): ManifestV3 {
  const docs = [...input.documents].sort((a, b) => a.id - b.id);
  return {
    format: 'verebona-gdpr-export',
    version: 3,
    generatedAt: input.generatedAt.toISOString(),
    status: completenessOf(input.missing) === 'complete' ? 'COMPLET' : 'PARTIEL',
    subject: { userId: input.userId, accountIds: [...input.accountIds].sort((a, b) => a - b) },
    tables: input.tables
      .filter((t) => t.file)
      .sort((a, b) => a.table.localeCompare(b.table))
      .map((t) => ({ table: t.table, rows: t.rows, truncated: !t.complete, file: t.file!.path, bytes: t.file!.bytes, sha256: t.file!.sha256, omittedColumns: [...t.omittedColumns].sort() })),
    excludedTables: [...input.excludedTables].sort(),
    documents: {
      expected: input.expectedDocuments,
      included: docs.length,
      includedBytes: docs.reduce((n, d) => n + d.bytes, 0),
      skipped: [
        ...input.withoutStoredFile.map((d) => ({ id: d.id, name: d.name, reason: 'NO_STORED_FILE' })),
        ...input.missing.filter((m): m is Extract<MissingItem, { kind: 'document' }> => m.kind === 'document').map((m) => ({ id: m.id, name: m.name, reason: m.reason })),
      ].sort((a, b) => a.id - b.id),
      files: docs.map((d) => ({ id: d.id, path: d.path, part: d.part, bytes: d.bytes, sha256: d.sha256 })),
    },
    missing: input.missing,
    parts: [...input.parts].sort((a, b) => a.part - b.part).map((p) => ({
      part: p.part, fileName: p.fileName, documents: p.files.length, documentsBytes: p.files.reduce((n, f) => n + f.bytes, 0),
      files: p.files.map((f) => ({ id: f.id, path: f.path })),
    })),
    integrity: {
      algorithm: 'sha256',
      note: 'Chaque fichier listé (données et documents) porte sa taille et son empreinte SHA-256, calculées sur le fichier réellement placé dans l’archive.',
    },
  };
}

/** Manifeste d'une partie, tiré des documents réellement placés dans CETTE partie. */
export function partManifestFromFiles(input: { generatedAt: Date; part: number; totalParts: number; files: WrittenDocument[]; missing: MissingItem[] }): string {
  return JSON.stringify({
    format: 'verebona-gdpr-export-part',
    version: 2,
    generatedAt: input.generatedAt.toISOString(),
    part: input.part,
    totalParts: input.totalParts,
    contenu: input.part === 1
      ? 'Données de votre compte (dossier « donnees »), manifeste global (manifest.json) et premiers documents.'
      : 'Documents seulement (dossier « documents »). Le manifeste global se trouve dans la partie 1.',
    documents: input.files.map((d) => ({ id: d.id, path: d.path, size: d.bytes, sha256: d.sha256 })),
    documentsBytes: input.files.reduce((n, f) => n + f.bytes, 0),
    manquants: input.missing,
  }, null, 2);
}

/** LISEZ-MOI de l'archive v3 (statut, parties, manques). */
export function finalReadme(m: ManifestV3): string {
  const lines = [
    'EXPORT DE VOS DONNÉES PERSONNELLES — VEREBONA',
    '',
    `Généré le ${new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'long', timeStyle: 'short' }).format(new Date(m.generatedAt))}.`,
    `Statut : ${m.status === 'COMPLET' ? 'COMPLET — toutes vos données exportables sont présentes.' : 'PARTIEL — certains éléments n’ont pas pu être inclus (liste ci-dessous).'}`,
    '',
    'Cette archive contient les données de votre compte utilisateur et du compte',
    'Verebona auquel vous êtes rattaché, au format JSON (dossier « donnees »),',
    'ainsi que les documents que vous avez déposés (dossier « documents »).',
    'Les documents portent le nom affiché dans Verebona ; manifest.json',
    '(rubrique documents.files) indique l’identifiant, la taille et l’empreinte',
    'SHA-256 de chacun, calculées sur le fichier réellement présent.',
    '',
    'Chaque fichier JSON correspond à une catégorie de données (biens, documents,',
    'échéances, notifications…). Le fichier manifest.json en dresse l’inventaire.',
    '',
    'Ne figurent pas dans l’archive : les éléments de sécurité (mots de passe,',
    'jetons de session), les journaux techniques internes, les notes internes',
    'du support et les données personnelles des autres membres d’un espace partagé.',
  ];
  if (m.parts.length > 1) {
    lines.push(
      '',
      `Votre archive est découpée en ${m.parts.length} parties numérotées. Celle-ci est la partie 1 :`,
      'elle contient vos données et le présent inventaire. Les autres parties contiennent',
      'la suite de vos documents ; chacune porte son propre inventaire',
      '(manifest-partie-N.json). La rubrique « parts » de manifest.json indique le',
      'contenu de chaque partie. Téléchargez toutes les parties depuis Mon compte.',
    );
  }
  if (m.missing.length) {
    lines.push('', `ÉLÉMENTS NON INCLUS (${m.missing.length}) :`);
    for (const x of m.missing.slice(0, 200)) {
      lines.push(x.kind === 'document'
        ? ` - document ${x.id} « ${x.name} » : ${MISSING_REASON_LABELS[x.reason]}`
        : ` - catégorie « ${x.table} » : ${MISSING_REASON_LABELS[x.reason]}`);
    }
    if (m.missing.length > 200) lines.push(` - … et ${m.missing.length - 200} autre(s), listés dans manifest.json (rubrique missing).`);
    lines.push('', 'Vous pouvez relancer la préparation depuis Mon compte › Mes données pour tenter',
      'de les récupérer, ou contacter l’assistance.');
  }
  return lines.join('\n') + '\n';
}
