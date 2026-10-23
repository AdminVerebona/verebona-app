/**
 * Lot 82E — restauration d'un point de sauvegarde (décisions PO C-Q8 du
 * 23/10 et D13 du Pilotage IA : « point de restauration avant campagne →
 * campagne → export après → restauration si besoin », SANS système de
 * sauvegarde parallèle).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * MÊME MÉCANISME QUE LA SAUVEGARDE QUOTIDIENNE
 *
 * Le point est une sauvegarde de format 2 (`database-backup.service.ts`) :
 * nocturne, `/api/cron/backup` ou « Créer un point de restauration » du BO.
 * La restauration est lancée depuis le BO (Exploitation › Sauvegardes et
 * recette), EN TÂCHE DE FOND par le moteur des rattrapages BO (un seul à la
 * fois sur la plateforme, journalisé, rapport) — aucune commande.
 *
 * DÉROULEMENT (tout ou rien)
 *
 *   1. contrôle : point de format 2, schéma identique au schéma courant pour
 *      chaque table restaurée (`checkRestoreCompatibility`) — sinon refus,
 *      AUCUNE écriture ;
 *   2. point de sauvegarde de l'état COURANT (même mécanisme) : la
 *      restauration elle-même est réversible ;
 *   3. UNE transaction : verrou exclusif des tables restaurées, contraintes
 *      de clé étrangère retirées puis RÉTABLIES ET REVALIDÉES à la fin
 *      (toute incohérence annule tout), déclencheurs applicatifs suspendus
 *      (la réinjection n'est pas une modification métier : ni horodatage
 *      réécrit, ni historique créé), tables vidées puis rechargées ligne à
 *      ligne depuis le texte exact de PostgreSQL ; nombre de lignes de
 *      CHAQUE table comparé au manifeste et SHA-256 du contenu vérifié ;
 *   4. séquences : jamais reculées (un identifiant attribué après le point
 *      n'est jamais réattribué à un autre objet — exports avant / après
 *      comparables sans collision) ;
 *   5. effets externes neutralisés : envois en attente restaurés
 *      (notifications, e-mails transactionnels, livraisons) annulés avec un
 *      motif — un message déjà envoyé après le point n'est jamais renvoyé
 *      (D13 : « interdire les effets externes réels involontaires »).
 *
 * TABLES CONSERVÉES dans leur état courant (`RESTORE_KEEP_CURRENT_TABLES`) :
 * journaux d'administration et d'exports, rattrapages, tâches planifiées,
 * révocations de sécurité, supervision, traces et rapports IA, rapports de
 * tests, journaux d'envois (D13 : ce qui s'est passé reste analysable).
 * Leurs clés étrangères vers les tables restaurées sont retirées avant et
 * rétablies après la transaction ; les clés des tables restaurées vers ces
 * journaux sont rétablies dans la transaction. Dans les deux cas : revalidées
 * si possible, sinon laissées « NOT VALID » et signalées (jamais bloquant).
 *
 * LIMITES (documentées) : les FICHIERS du stockage objet ne font pas partie
 * de la sauvegarde (un document supprimé définitivement après le point
 * n'est pas récupéré ; un document déposé après le point reste orphelin dans
 * le stockage) ; Stripe et les e-mails déjà envoyés ne sont pas « annulés ».
 * L'application est bloquée pendant la transaction (verrous exclusifs).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createGunzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Transform } from 'node:stream';
import type postgres from 'postgres';
import { checkRestoreCompatibility, readSchemaSignature, RESTORE_KEEP_CURRENT_TABLES, type CompatibilityResult, type Query } from './schema-signature';
import type { BackupManifestV2, BackupOptions } from './database-backup.service';

type Row = Record<string, unknown>;
type Storage = NonNullable<BackupOptions['storage']>;

export class RestoreRefusedError extends Error {
  readonly code = 'RESTORE_REFUSED';
  constructor(message: string, readonly compatibility?: CompatibilityResult) { super(message); this.name = 'RestoreRefusedError'; }
}

/** Lignes réinjectées par instruction (et au plus `BATCH_CHARS` caractères de JSON). */
const BATCH_ROWS = 1_000;
const BATCH_CHARS = 4 * 1024 * 1024;
/** Attente maximale d'un verrou (application en cours d'écriture) : au-delà, échec sans écriture, à relancer. */
export const RESTORE_LOCK_TIMEOUT = '60s';

const ident = (t: string) => `"${t.replace(/"/g, '""')}"`;

/** Envois en attente neutralisés après restauration (effets externes, D13). */
export const OUTBOUND_NEUTRALIZERS: ReadonlyArray<{ table: string; columns: string[]; sql: (motif: string) => string; label: string }> = [
  {
    table: 'notification_outbox', columns: ['status', 'outcome_reason', 'processed_at'], label: 'Notifications en attente annulées',
    sql: () => `UPDATE notification_outbox SET status = 'cancelled', outcome_reason = $1, processed_at = now() WHERE status IN ('pending', 'processing')`,
  },
  {
    table: 'notification_deliveries', columns: ['status', 'last_error_code', 'last_error_message'], label: 'Livraisons (cloche, push, e-mail) en attente expirées',
    sql: () => `UPDATE notification_deliveries SET status = 'expired', last_error_code = 'RESTORE_NEUTRALIZED', last_error_message = $1 WHERE status = 'pending'`,
  },
  {
    table: 'transactional_email_jobs', columns: ['status', 'neutralized_at', 'last_error', 'locked_until'], label: 'E-mails transactionnels en attente annulés',
    sql: () => `UPDATE transactional_email_jobs SET status = 'cancelled', neutralized_at = now(), last_error = $1, locked_until = NULL
                 WHERE status IN ('pending', 'sending', 'uncertain')`,
  },
];

export interface RestoreHooks {
  log?: (m: string) => void;
  progress?: (p: Record<string, unknown>) => void;
}

export interface RestoreReport {
  backupId: string;
  backupLabel: string | null;
  backupSnapshotAt: string;
  /** Point de sauvegarde de l'état courant pris juste avant (réversibilité). */
  safetyBackupId: string | null;
  restoredTables: number;
  keptTables: string[];
  rows: number;
  perTable: Array<{ table: string; rows: number }>;
  foreignKeys: { restored: number; keptRevalidated: number; keptNotValid: string[] };
  triggersSuspended: number;
  sequencesAdvanced: string[];
  neutralized: Array<{ table: string; label: string; rows: number }>;
  durationMs: number;
}

/**
 * Restauration autorisée dans cet environnement ? Préproduction : oui. Une
 * production (inexistante au 23/10/2026, V-Q3) exigerait un choix explicite
 * (`BACKUP_RESTORE_ALLOWED=true`) : variante prudente.
 */
export function restoreAllowedInEnvironment(env: NodeJS.ProcessEnv = process.env): { allowed: boolean; reason: string | null } {
  const app = (env.NEXT_PUBLIC_APP_ENV ?? '').trim().toLowerCase();
  if (app === 'production' && env.BACKUP_RESTORE_ALLOWED !== 'true') {
    return { allowed: false, reason: 'Restauration désactivée en production (BACKUP_RESTORE_ALLOWED absente) : la procédure de recette vise la préproduction.' };
  }
  return { allowed: true, reason: null };
}

/** Point de restauration et sa compatibilité avec le schéma courant (lecture seule). */
export async function inspectRestorePoint(q: Query, manifest: BackupManifestV2): Promise<CompatibilityResult> {
  return checkRestoreCompatibility(manifest, await readSchemaSignature(q));
}

/** Découpe une ligne `{"t":"<table>","r":<json>}` sans la décoder (texte exact conservé). */
export function splitBackupLine(line: string): { table: string; row: string } | null {
  const m = /^\{"t":"([A-Za-z0-9_]+)","r":/.exec(line);
  if (!m || !line.endsWith('}')) return null;
  return { table: m[1], row: line.slice(m[0].length, -1) };
}

interface FkDef { table: string; name: string; def: string; kind: 'f' | 'c'; references: string | null }

/**
 * Contraintes à suspendre pendant le rechargement : clés étrangères touchant
 * les tables (dans les deux sens) et, pour les tables elles-mêmes, les
 * contraintes CHECK « NOT VALID » — PostgreSQL les applique aux nouvelles
 * lignes alors que des lignes anciennes, conservées telles quelles, peuvent
 * ne pas les respecter (contrainte posée sans revalider l'historique).
 */
async function foreignKeys(q: (sql: string, p?: unknown[]) => Promise<Row[]>, tables: string[], withNotValidChecks = false): Promise<FkDef[]> {
  const rows = await q(`
    SELECT c.conrelid::regclass::text AS tbl, c.conname, pg_get_constraintdef(c.oid) AS def, c.contype::text AS kind,
           CASE WHEN c.contype = 'f' THEN c.confrelid::regclass::text END AS ref
      FROM pg_constraint c
     WHERE (c.contype = 'f' AND (c.conrelid::regclass::text = ANY($1::text[]) OR c.confrelid::regclass::text = ANY($1::text[])))
        OR ($2::boolean AND c.contype = 'c' AND NOT c.convalidated AND c.conrelid::regclass::text = ANY($1::text[]))
     ORDER BY 1, 2`, [tables, withNotValidChecks]);
  const bare = (v: unknown) => String(v).replace(/^public\./, '').replace(/^"|"$/g, '');
  return rows.map((r) => ({ table: bare(r.tbl), name: String(r.conname), def: String(r.def), kind: r.kind === 'c' ? 'c' : 'f', references: r.ref == null ? null : bare(r.ref) }));
}

/**
 * Restaure un point de sauvegarde (format 2). `sql` : client PostgreSQL
 * DÉDIÉ (moteur des rattrapages BO). Lève `RestoreRefusedError` sans aucune
 * écriture si le point n'est pas restaurable.
 */
export async function restoreDatabaseBackup(
  sql: postgres.Sql,
  backupId: string,
  opts: RestoreHooks & {
    reason: string;
    adminUserId?: number | null;
    storage?: Storage;
    /** Tests : pas de point de sauvegarde préalable (déjà pris par l'appelant). */
    skipSafetyBackup?: boolean;
    now?: () => Date;
  },
): Promise<RestoreReport> {
  const log = opts.log ?? (() => undefined);
  const t0 = Date.now();
  const env = restoreAllowedInEnvironment();
  if (!env.allowed) throw new RestoreRefusedError(env.reason!);
  if (!opts.reason || opts.reason.trim().length < 5) throw new RestoreRefusedError('Motif obligatoire.');
  const { findBackupManifest, openBackupData, runDatabaseBackup } = await import('./database-backup.service');
  const manifest = await findBackupManifest(backupId, opts.storage);
  if (!manifest) throw new RestoreRefusedError(`Point de restauration ${backupId} introuvable (purgé après ${process.env.BACKUP_RETENTION_DAYS || 30} jours ?).`);
  const q: Query = async (text, params = []) => (await sql.unsafe(text, params as never[])) as unknown as Row[];

  // 1. Compatibilité (aucune écriture).
  log('Contrôle de compatibilité du point avec le schéma courant…');
  const compat = await inspectRestorePoint(q, manifest);
  if (!compat.restorable) throw new RestoreRefusedError(compat.reason ?? 'Point non restaurable.', compat);
  const restored = compat.restoredTables;
  const keep = new Set(RESTORE_KEEP_CURRENT_TABLES);
  const expected = new Map(manifest.tables.filter((t) => !keep.has(t.name)).map((t) => [t.name, t.rows]));

  // 2. Point de sauvegarde de l'état courant (même mécanisme).
  let safetyBackupId: string | null = null;
  if (!opts.skipSafetyBackup) {
    log('Point de sauvegarde de l’état actuel (avant restauration)…');
    const s = await runDatabaseBackup('admin', {
      label: `Avant restauration du point ${backupId}${manifest.label ? ` (« ${manifest.label} »)` : ''} — ${opts.reason}`.slice(0, 500),
      adminUserId: opts.adminUserId ?? null, storage: opts.storage, now: opts.now,
    });
    safetyBackupId = s.backupId;
    log(`Point de sauvegarde de l’état actuel : ${safetyBackupId}`);
  }

  // Clés étrangères des tables CONSERVÉES vers les tables restaurées : retirées hors de la grande transaction.
  const keptFks = (await foreignKeys(q, restored)).filter((f) => f.kind === 'f' && keep.has(f.table));
  for (const f of keptFks) await sql.unsafe(`ALTER TABLE ${ident(f.table)} DROP CONSTRAINT IF EXISTS ${ident(f.name)}`);

  const report: RestoreReport = {
    backupId, backupLabel: manifest.label, backupSnapshotAt: manifest.snapshot.at, safetyBackupId,
    restoredTables: restored.length, keptTables: compat.keptTables, rows: 0, perTable: [],
    foreignKeys: { restored: 0, keptRevalidated: 0, keptNotValid: [] }, triggersSuspended: 0, sequencesAdvanced: [], neutralized: [], durationMs: 0,
  };
  try {
    await sql.begin(async (tx) => {
      const tq = async (text: string, params: unknown[] = []) => (await tx.unsafe(text, params as never[])) as unknown as Row[];
      await tq(`SET LOCAL lock_timeout = '${RESTORE_LOCK_TIMEOUT}'`);
      await tq(`SET LOCAL statement_timeout = 0`);
      log(`Verrouillage de ${restored.length} table(s)…`);
      await tq(`LOCK TABLE ${restored.map(ident).join(', ')} IN ACCESS EXCLUSIVE MODE`);

      // 3a. Contraintes de clé étrangère des tables restaurées : retirées, rétablies et revalidées à la fin.
      const fks = await foreignKeys(tq, restored, true);
      for (const f of fks) await tq(`ALTER TABLE ${ident(f.table)} DROP CONSTRAINT ${ident(f.name)}`);
      // 3b. Déclencheurs applicatifs actifs : suspendus, puis rétablis dans leur mode d'origine.
      const triggers = await tq(`
        SELECT c.relname AS tbl, t.tgname, t.tgenabled
          FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
         WHERE NOT t.tgisinternal AND t.tgenabled <> 'D' AND c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1::text[])`, [restored]);
      for (const t of triggers) await tq(`ALTER TABLE ${ident(String(t.tbl))} DISABLE TRIGGER ${ident(String(t.tgname))}`);
      report.triggersSuspended = triggers.length;

      // 3c. Vidage puis rechargement.
      log('Vidage des tables restaurées…');
      await tq(`TRUNCATE ${restored.map(ident).join(', ')}`);
      const columns = new Map<string, string[]>();
      for (const r of await tq(`
          SELECT table_name, string_agg(quote_ident(column_name), ',' ORDER BY ordinal_position) AS cols
            FROM information_schema.columns
           WHERE table_schema = 'public' AND is_generated = 'NEVER' AND table_name = ANY($1::text[])
           GROUP BY table_name`, [restored])) columns.set(String(r.table_name), String(r.cols).split(','));

      const counts = new Map<string, number>();
      let batch: string[] = [];
      let batchChars = 0;
      let current: string | null = null;
      const flush = async () => {
        if (!current || !batch.length) return;
        const cols = columns.get(current)!.join(',');
        await tq(`INSERT INTO ${ident(current)} (${cols}) OVERRIDING SYSTEM VALUE SELECT ${cols} FROM json_populate_recordset(NULL::${ident(current)}, $1::json)`,
          [`[${batch.join(',')}]`]);
        counts.set(current, (counts.get(current) ?? 0) + batch.length);
        report.rows += batch.length;
        batch = [];
        batchChars = 0;
      };
      const hash = createHash('sha256');
      const tap = new Transform({ transform(chunk: Buffer, _e, cb) { hash.update(chunk); cb(null, chunk); } });
      const data = (await openBackupData(manifest, opts.storage)).pipe(createGunzip()).pipe(tap);
      const lines = createInterface({ input: data, crlfDelay: Infinity });
      let n = 0;
      const restoredSet = new Set(restored);
      for await (const line of lines) {
        if (!line) continue;
        const p = splitBackupLine(line);
        if (!p) throw new Error(`ligne ${n + 1} de la sauvegarde illisible : restauration annulée`);
        n++;
        if (!restoredSet.has(p.table)) continue;
        if (p.table !== current) {
          await flush();
          current = p.table;
          log(`Rechargement de ${current}…`);
        }
        batch.push(p.row);
        batchChars += p.row.length;
        if (batch.length >= BATCH_ROWS || batchChars >= BATCH_CHARS) await flush();
        if (n % 50_000 === 0) opts.progress?.({ lignesLues: n, lignesRestaurees: report.rows });
      }
      await flush();
      const sha = hash.digest('hex');
      if (manifest.sha256 && sha !== manifest.sha256) throw new Error(`intégrité de la sauvegarde : SHA-256 ${sha} ≠ ${manifest.sha256} — restauration annulée`);
      const ecarts: string[] = [];
      for (const t of restored) {
        const got = counts.get(t) ?? 0;
        const exp = expected.get(t) ?? 0;
        report.perTable.push({ table: t, rows: got });
        if (got !== exp) ecarts.push(`${t} : ${got} ligne(s) rechargée(s) sur ${exp}`);
      }
      if (ecarts.length) throw new Error(`lignes rechargées ≠ manifeste (${ecarts.slice(0, 10).join(' ; ')}) — restauration annulée`);

      // 3d. Contraintes rétablies (et revalidées : toute relation incohérente annule la restauration).
      log(`Rétablissement de ${fks.length} contrainte(s) (clés étrangères revalidées, contrôles « NOT VALID » reposés tels quels)…`);
      for (const f of fks) {
        // Ligne restaurée → table CONSERVÉE (journal) : la ligne citée a pu être purgée depuis le point ;
        // contrainte reposée « NOT VALID » puis revalidée si possible (signalé sinon), jamais bloquante.
        if (f.kind === 'f' && f.references && keep.has(f.references) && !/\bNOT VALID\b/.test(f.def)) {
          await tq(`ALTER TABLE ${ident(f.table)} ADD CONSTRAINT ${ident(f.name)} ${f.def} NOT VALID`);
          await tq('SAVEPOINT vb_fk');
          try {
            await tq(`ALTER TABLE ${ident(f.table)} VALIDATE CONSTRAINT ${ident(f.name)}`);
            await tq('RELEASE SAVEPOINT vb_fk');
          } catch {
            await tq('ROLLBACK TO SAVEPOINT vb_fk');
            report.foreignKeys.keptNotValid.push(`${f.table}.${f.name}`);
          }
          continue;
        }
        await tq(`ALTER TABLE ${ident(f.table)} ADD CONSTRAINT ${ident(f.name)} ${f.def}`);
      }
      report.foreignKeys.restored = fks.filter((f) => f.kind === 'f').length;
      for (const t of triggers) {
        const mode = t.tgenabled === 'A' ? 'ENABLE ALWAYS' : t.tgenabled === 'R' ? 'ENABLE REPLICA' : 'ENABLE';
        await tq(`ALTER TABLE ${ident(String(t.tbl))} ${mode} TRIGGER ${ident(String(t.tgname))}`);
      }

      // 4. Séquences : jamais reculées.
      const seqs = await tq(`
        SELECT c.relname AS tbl, a.attname AS col, s.oid::regclass::text AS seq
          FROM pg_class s
          JOIN pg_depend d ON d.objid = s.oid AND d.classid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
          JOIN pg_class c ON c.oid = d.refobjid
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.refobjsubid
         WHERE s.relkind = 'S' AND c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1::text[])`, [restored]);
      for (const s of seqs) {
        const [r] = await tq(`SELECT (SELECT max(${ident(String(s.col))})::text FROM ${ident(String(s.tbl))}) AS mx, last_value::text AS lv FROM ${String(s.seq)}`);
        if (r?.mx != null && BigInt(String(r.mx)) > BigInt(String(r.lv))) {
          await tq(`SELECT setval($1::regclass, $2::bigint, true)`, [String(s.seq), String(r.mx)]);
          report.sequencesAdvanced.push(String(s.seq));
        }
      }

      // 5. Effets externes neutralisés.
      const motif = `restauration de la base au point ${backupId} (${manifest.snapshot.at}) : envoi neutralisé`;
      for (const n2 of OUTBOUND_NEUTRALIZERS) {
        if (!restoredSet.has(n2.table)) continue;
        const [ok] = await tq(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = ANY($2::text[])`, [n2.table, n2.columns]);
        if (Number(ok?.n ?? 0) !== n2.columns.length) continue;
        const r = await tx.unsafe(n2.sql(motif), [motif] as never[]);
        report.neutralized.push({ table: n2.table, label: n2.label, rows: Number((r as unknown as { count?: number }).count ?? 0) });
      }
      log(`Validation de la transaction (${report.rows} ligne(s), ${restored.length} table(s))…`);
    });
  } finally {
    // Clés étrangères des tables conservées : rétablies (revalidées si possible).
    for (const f of keptFks) {
      const def = /\bNOT VALID\b/.test(f.def) ? f.def : `${f.def} NOT VALID`;
      try {
        await sql.unsafe(`ALTER TABLE ${ident(f.table)} ADD CONSTRAINT ${ident(f.name)} ${def}`);
      } catch (e) {
        console.error(`[restore] contrainte ${f.table}.${f.name} non rétablie :`, (e as Error).message);
        report.foreignKeys.keptNotValid.push(`${f.table}.${f.name} (non rétablie : ${(e as Error).message.slice(0, 120)})`);
        continue;
      }
      if (/\bNOT VALID\b/.test(f.def)) continue;
      try {
        await sql.unsafe(`ALTER TABLE ${ident(f.table)} VALIDATE CONSTRAINT ${ident(f.name)}`);
        report.foreignKeys.keptRevalidated++;
      } catch {
        // Une ligne du journal conservé cite un objet absent du point : contrainte gardée « NOT VALID » (signalé).
        report.foreignKeys.keptNotValid.push(`${f.table}.${f.name}`);
      }
    }
  }
  report.durationMs = Date.now() - t0;
  log(`Restauration terminée : ${report.rows} ligne(s) dans ${report.restoredTables} table(s).`);
  return report;
}
