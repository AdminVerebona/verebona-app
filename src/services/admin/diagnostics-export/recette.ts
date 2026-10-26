/**
 * Lot 82E — EXPORT COMPLET DE RECETTE (décisions PO du 23/10 : C-Q5, C-Q8,
 * §4.1–4.2). Serveur uniquement.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * MÊME MOTEUR QUE LES EXPORTS DU BO (81C) ET LE DIAGNOSTIC (77C)
 *
 *   · UNE session REPEATABLE READ READ ONLY (`openReadSession`, 81C) : toutes
 *     les tables ET le TCO calculé sont lus dans le même instantané ; deux
 *     exports successifs sont donc chacun cohérents, et comparables ;
 *   · lecture par curseur, lot par lot ; attendu = `count(*)` dans
 *     l'instantané ; exporté = lignes effectivement écrites ; statut
 *     COMPLETE / PARTIAL / FAILED par fichier, par table et global
 *     (`sectionStatus` / `globalStatus`, 81C) ; points de reprise par table ;
 *   · masquage du diagnostic (`maskForExport`, 77C) : secrets jamais
 *     exportés, e-mails pseudonymisés (pseudonyme stable), clé de stockage et
 *     nom d'origine des fichiers masqués ; contenu brut (texte des extracts,
 *     sorties IA) remplacé par sa longueur et son SHA-256 — intégral
 *     seulement pour un administrateur habilité aux contenus IA sensibles
 *     (`AI_MODEL_OUTPUT_ADMIN_IDS`, décision D15), demande journalisée ;
 *   · suivi `admin_export_generations` (81C) : RUNNING → COMPLETE / PARTIAL /
 *     FAILED, signe de vie, bilan par table.
 *
 * GÉNÉRATION EN TÂCHE DE FOND, RÉSULTAT STOCKÉ
 *
 * Tous les comptes, toutes les tables du périmètre (`recette-catalog.ts`) :
 * le volume dépasse une requête HTTP. La génération tourne en tâche de fond
 * (comme les rattrapages BO) ; chaque fichier est compressé et envoyé en
 * flux vers le stockage OVH (même envoi que la sauvegarde nocturne), sous
 * `admin-exports/recette/<génération>/` ; la mémoire reste bornée à un lot
 * (conteneur ~1 Go), quel que soit le volume. Téléchargement ultérieur
 * depuis le BO (URL signée de courte durée, droits revérifiés).
 *
 * FORMAT STABLE ET DOCUMENTÉ
 *
 *   donnees/<domaine>/<table>.part-NNNN.ndjson.gz  une ligne JSON = une ligne
 *        de la table, TOUTES ses colonnes (texte de PostgreSQL), triées par
 *        clé primaire ; découpage en parties de `RECETTE_PART_ROWS` lignes ;
 *   calculs/tco-lignes.part-NNNN.ndjson.gz, calculs/tco-syntheses.ndjson.gz
 *        lignes TCO calculées par le moteur existant (`readAssetTco`) ;
 *   calculs/timeline.part-NNNN.ndjson.gz  Timeline de chaque bien (lot 84C,
 *        `readAssetTimelineAll`, même fonction que la fiche du bien) ;
 *   dictionnaire.json / dictionnaire.csv  tables, colonnes, types, clés,
 *        relations, masquage ; LISEZMOI.txt ; manifeste.json EN DERNIER
 *        (sa présence atteste la fin : attendu, exporté, octets, SHA-256 de
 *        chaque fichier, totaux par table et globaux).
 *
 * Aucun tableau de bord ni comparaison dans Verebona (C-Q5) : l'analyse des
 * écarts entre deux exports est faite à l'extérieur.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash, randomUUID } from 'node:crypto';
import type { S3Client } from '@aws-sdk/client-s3';
import { getBuildIdentity } from '@/lib/runtime-identity';
import { globalStatus, sectionStatus, type ExtractionStatus } from '@/services/admin/account-data/model';
import { decodeJsonRow, openReadSession, type ReadSession } from '@/services/admin/account-data/session';
import { exportMaskingRule, leaksSecretOrEmail, maskForExport, maskText } from './model';
import {
  RECETTE_DOMAINS, RECETTE_PART_ROWS, RECETTE_PREFIX, RECETTE_RETENTION_DAYS, RECETTE_SCHEMA, classifyTables, recetteDataPath,
  type RecetteDomain,
} from './recette-catalog';

type Row = Record<string, unknown>;

export interface RecetteStorage { client: Pick<S3Client, 'send'>; bucket: string }

interface RecetteFile {
  path: string;
  nature: 'donnees' | 'calcul' | 'documentation';
  table: string | null;
  domain: RecetteDomain | null;
  part: { index: number; of: number } | null;
  /** Lignes attendues (instantané) ; null : fichier calculé ou documentaire. */
  expected: number | null;
  exported: number;
  /** Octets non compressés et SHA-256 du contenu non compressé. */
  bytes: number;
  compressedBytes: number | null;
  sha256: string | null;
  contentType: string;
  status: ExtractionStatus;
  error: string | null;
}

interface RecetteTableStat {
  table: string;
  domain: RecetteDomain;
  expected: number | null;
  exported: number;
  parts: number;
  status: ExtractionStatus;
  error: string | null;
}

export interface RecetteManifest {
  schema: typeof RECETTE_SCHEMA;
  generationId: string;
  generatedAt: string;
  finishedAt: string;
  environment: string;
  build: { version: string | null; commit: string | null };
  perimeter: {
    description: string;
    accounts: number | null;
    tablesExported: number;
    tablesExcluded: Array<{ table: string; motif: string }>;
    tablesUnclassified: string[];
  };
  snapshot: { isolation: string; at: string; snapshot: string | null; verification: string; exceptions: string[] };
  options: { partRows: number; batchRows: number; sensitiveContent: boolean; today: string };
  tables: RecetteTableStat[];
  files: RecetteFile[];
  totals: { files: number; tables: number; rowsExpected: number; rowsExported: number; bytes: number; compressedBytes: number };
  status: ExtractionStatus;
  warnings: string[];
  masking: string[];
}

interface RecetteOptions {
  generationId: string;
  adminUserId: number | null;
  includeSensitiveContent?: boolean;
  partRows?: number;
  batchRows?: number;
  /** Date de référence du TCO (AAAA-MM-JJ) ; défaut : date du jour (Europe/Paris). */
  today?: string;
  now?: () => Date;
  storage?: RecetteStorage;
  /** Session fournie (tests) ; sinon une session est ouverte et fermée. */
  session?: ReadSession;
  onProgress?: (p: { rowsExported: number; files: number; bytes: number; table: string | null }) => void;
}

const RECETTE_BATCH_ROWS = 500;
const RECETTE_STATEMENT_TIMEOUT_MS = 10 * 60_000;
const NDJSON = 'application/x-ndjson';
const ident = (t: string) => `"${t.replace(/"/g, '""')}"`;
const describe = (e: unknown): string => `${(e as { code?: string })?.code ? `${(e as { code?: string }).code} — ` : ''}${(e as Error)?.message ?? String(e)}`.slice(0, 500);
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const RECETTE_MASKING_NOTES: readonly string[] = [
  'Identifiants et colonnes de liaison : jamais masqués (comparaison externe par table + clé primaire).',
  'Secrets, jetons, mots de passe, coordonnées bancaires : remplacés par un marqueur {"$etat":"masque","motif":…}.',
  'E-mails : {"$etat":"masque","motif":"e-mail","pseudonyme":…} — pseudonyme STABLE (même adresse → même pseudonyme d’un export à l’autre).',
  'Identité, téléphone, adresse, n° de contrat ou de client : marqueur (avec longueur pour les textes longs).',
  'Fichiers : clé et emplacement de stockage, nom et URL du fichier d’origine masqués ; aucun fichier binaire exporté.',
  'Contenu brut (texte des extracts, sorties et prompts IA) : {"$etat":"masque","longueur":N,"sha256":…} — un changement de contenu change l’empreinte ; '
    + 'intégral seulement si l’export a été demandé « avec contenus sensibles » par un administrateur habilité (AI_MODEL_OUTPUT_ADMIN_IDS).',
  'Clés canoniques sensibles du registre (adresse, n° de contrat…) dans les fiches JSON (key_characteristics…) : marqueur.',
  'Un marqueur n’est jamais confondu avec NULL : NULL en base = null JSON.',
];

/** Ligne masquée de l'export de recette (pure, déterministe). */
export function maskRecetteRow(row: Row, opts: { isSensitiveKey?: (k: string) => boolean; includeSensitiveContent?: boolean } = {}): Row {
  const content: Row = {};
  const rest: Row = {};
  for (const [k, v] of Object.entries(row)) {
    const rule = exportMaskingRule(k);
    if (rule?.content && v !== null && v !== undefined) {
      const text = typeof v === 'string' ? v : JSON.stringify(v);
      content[k] = opts.includeSensitiveContent
        ? (typeof v === 'string' ? maskText(v) : maskForExport(v, { isSensitiveKey: opts.isSensitiveKey }))
        : { $etat: 'masque', motif: rule.motif, longueur: text.length, sha256: sha256(text) };
    } else rest[k] = v;
  }
  const masked = maskForExport(rest, { isSensitiveKey: opts.isSensitiveKey }) as Row;
  const out: Row = {};
  for (const k of Object.keys(row)) out[k] = k in content ? content[k] : masked[k];
  return out;
}

/** Sérialisation d'une ligne : contrôle de sortie (aucun secret ni e-mail en clair), JSON toujours valide. */
export function recetteLine(v: Row): string {
  const s = JSON.stringify(v);
  if (!leaksSecretOrEmail(s)) return s;
  const m = maskText(s);
  try { JSON.parse(m); return m; } catch { return JSON.stringify({ $etat: 'masque', motif: 'ligne masquée (motif de secret résiduel)' }); }
}

/** Clause de tri stable : clé primaire, sinon le texte JSON complet de la ligne. */
export function orderClause(pk: readonly string[]): string {
  return pk.length ? pk.map((c) => `t.${ident(c)}`).join(', ') : 'row_to_json(t)::text';
}

interface ColumnMeta { name: string; type: string; nullable: boolean; generated: boolean; comment: string | null }
interface TableMeta { columns: ColumnMeta[]; pk: string[]; fks: Array<{ name: string; columns: string[]; references: string; referencedColumns: string[] }> }

async function readMeta(q: ReadSession['q'], tables: string[]): Promise<Map<string, TableMeta>> {
  const meta = new Map<string, TableMeta>(tables.map((t) => [t, { columns: [], pk: [], fks: [] }]));
  for (const r of await q(`
      SELECT c.table_name, c.column_name, c.data_type, c.udt_name, c.is_nullable, c.is_generated,
             col_description(format('%I', c.table_name)::regclass, c.ordinal_position::int) AS comment
        FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = ANY($1::text[])
       ORDER BY c.table_name, c.ordinal_position`, [tables])) {
    meta.get(String(r.table_name))?.columns.push({
      name: String(r.column_name), type: r.data_type === 'USER-DEFINED' || r.data_type === 'ARRAY' ? String(r.udt_name) : String(r.data_type),
      nullable: r.is_nullable === 'YES', generated: r.is_generated === 'ALWAYS', comment: r.comment == null ? null : String(r.comment),
    });
  }
  for (const r of await q(`
      SELECT c.relname AS tbl, array_agg(a.attname ORDER BY k.ord) AS cols
        FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
        CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
       WHERE i.indisprimary AND c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1::text[])
       GROUP BY c.relname`, [tables])) {
    const m = meta.get(String(r.tbl));
    if (m) m.pk = (r.cols as string[]).map(String);
  }
  for (const r of await q(`
      SELECT c.conname, src.relname AS tbl, dst.relname AS ref,
             (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(n, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n) AS cols,
             (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(n, ord) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n) AS refcols
        FROM pg_constraint c JOIN pg_class src ON src.oid = c.conrelid JOIN pg_class dst ON dst.oid = c.confrelid
       WHERE c.contype = 'f' AND src.relnamespace = 'public'::regnamespace AND src.relname = ANY($1::text[])
       ORDER BY src.relname, c.conname`, [tables])) {
    meta.get(String(r.tbl))?.fks.push({ name: String(r.conname), columns: (r.cols as string[]).map(String), references: String(r.ref), referencedColumns: (r.refcols as string[]).map(String) });
  }
  return meta;
}

/** Date du jour à Paris (AAAA-MM-JJ). */
function parisToday(d: Date): string {
  return new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d).slice(0, 10);
}

async function defaultStorage(): Promise<RecetteStorage> {
  const { getS3Client, getS3Bucket } = await import('@/lib/s3-config');
  return { client: getS3Client('worker'), bucket: getS3Bucket() };
}

/** Préfixe de stockage d'une génération. */
export const recettePrefix = (generationId: string) => `${RECETTE_PREFIX}${generationId}/`;

/**
 * Produit l'export complet dans le stockage et rend son manifeste (écrit en
 * dernier). Ne lève que si rien n'a pu être produit (session, stockage).
 */
export async function runRecetteExport(opts: RecetteOptions): Promise<RecetteManifest> {
  const now = opts.now ?? (() => new Date());
  const generatedAt = now();
  const partRows = Math.max(1, opts.partRows ?? RECETTE_PART_ROWS);
  const batchRows = Math.max(1, opts.batchRows ?? RECETTE_BATCH_ROWS);
  const today = opts.today ?? parisToday(generatedAt);
  const storage = opts.storage ?? await defaultStorage();
  const prefix = recettePrefix(opts.generationId);
  const { openGzipUpload } = await import('@/services/backup/s3-gzip-upload');
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const { isSensitiveCanonicalKey } = await import('@/services/admin/account-data/dossier');
  const mask = (r: Row) => maskRecetteRow(r, { isSensitiveKey: isSensitiveCanonicalKey, includeSensitiveContent: !!opts.includeSensitiveContent });

  const own = !opts.session;
  const s = opts.session ?? await openReadSession();
  const files: RecetteFile[] = [];
  const tableStats: RecetteTableStat[] = [];
  const warnings: string[] = [];
  const exceptions: string[] = [];
  const progress = { rowsExported: 0, files: 0, bytes: 0, table: null as string | null };
  const tick = () => opts.onProgress?.({ ...progress });

  /** Fichier compressé en flux ; une erreur l'annule et le laisse absent (statut FAILED). */
  const putSmall = async (path: string, body: string, contentType: string, nature: RecetteFile['nature']) => {
    await storage.client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: `${prefix}${path}`, Body: body, ContentType: `${contentType}; charset=utf-8` }));
    const bytes = Buffer.byteLength(body);
    files.push({ path, nature, table: null, domain: null, part: null, expected: null, exported: 0, bytes, compressedBytes: null, sha256: sha256(body), contentType, status: 'COMPLETE', error: null });
    progress.files++; progress.bytes += bytes; tick();
  };

  try {
    if (own) await s.q(`SET LOCAL statement_timeout = ${RECETTE_STATEMENT_TIMEOUT_MS}`);
    const all = (await s.q(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)).map((r) => String(r.table_name));
    const cls = classifyTables(all);
    if (cls.unclassified.length) warnings.push(`Tables non classées au catalogue de l’export, exportées par prudence (domaine « non-classees ») : ${cls.unclassified.join(', ')}.`);
    const meta = await readMeta(s.q, cls.included.map((x) => x.table));
    const [acc] = await s.savepoint(() => s.q(`SELECT count(*)::int AS n FROM accounts`)).catch(() => [{ n: null }]);

    // ── Données : chaque table, intégralement, par parties ─────────────────
    for (const t of cls.included) {
      progress.table = t.table;
      const m = meta.get(t.table)!;
      let expected: number | null = null;
      let error: string | null = null;
      try {
        const [c] = await s.savepoint(() => s.q(`SELECT count(*)::bigint AS n FROM ${ident(t.table)}`));
        expected = Number(c?.n ?? 0);
      } catch (e) { error = describe(e); }
      const parts = expected === null ? 1 : Math.max(1, Math.ceil(expected / partRows));
      const partFiles: RecetteFile[] = Array.from({ length: parts }, (_, k) => ({
        path: recetteDataPath(t.domain, t.table, k + 1), nature: 'donnees' as const, table: t.table, domain: t.domain, part: { index: k + 1, of: parts },
        expected: expected === null ? null : (parts > 1 ? Math.min(partRows, expected - k * partRows) : expected),
        exported: 0, bytes: 0, compressedBytes: null, sha256: null, contentType: NDJSON, status: 'FAILED' as ExtractionStatus, error,
      }));
      let exported = 0;
      if (!error) {
        let k = 0;
        let up: Awaited<ReturnType<typeof openGzipUpload>> | null = null;
        let inPart = 0;
        const closePart = async () => {
          const f = partFiles[k];
          const r = await up!.finish();
          up = null;
          Object.assign(f, { exported: inPart, bytes: r.bytes, compressedBytes: r.compressedBytes, sha256: r.sha256, status: sectionStatus(f.expected, inPart, null), error: null });
          progress.files++; progress.bytes += r.bytes; tick();
        };
        try {
          up = await openGzipUpload(storage.client, storage.bucket, `${prefix}${partFiles[0].path}`, { contentType: 'application/gzip' });
          await s.savepoint(async () => {
            for await (const lot of s.cursor(`SELECT row_to_json(t) AS r FROM ${ident(t.table)} t ORDER BY ${orderClause(m.pk)}`, [], batchRows)) {
              let chunk = '';
              for (const x of lot) {
                if (inPart === partRows) {
                  // La partie est pleine : envoyée, puis la suivante est ouverte (même curseur, même instantané).
                  if (chunk) { await up!.write(chunk); chunk = ''; }
                  await closePart();
                  k++;
                  inPart = 0;
                  if (!partFiles[k]) partFiles.push({ ...partFiles[k - 1], path: recetteDataPath(t.domain, t.table, k + 1), part: { index: k + 1, of: k + 1 }, expected: null, exported: 0, status: 'FAILED' });
                  up = await openGzipUpload(storage.client, storage.bucket, `${prefix}${partFiles[k].path}`, { contentType: 'application/gzip' });
                }
                chunk += `${recetteLine(mask(decodeJsonRow(x.r)))}\n`;
                inPart++;
                exported++;
              }
              if (chunk) await up!.write(chunk);
              progress.rowsExported += lot.length;
            }
          });
          await closePart();
        } catch (e) {
          if ((e as { code?: string })?.code === '25006') throw e;
          error = describe(e);
          console.error(`[admin/recette] ${t.table} :`, error);
          await (up as { abort(): Promise<void> } | null)?.abort();
          for (const f of partFiles.slice(k)) Object.assign(f, { status: f.exported > 0 ? 'PARTIAL' : 'FAILED', error });
        }
      }
      files.push(...partFiles);
      const status: ExtractionStatus = sectionStatus(expected, exported, error);
      tableStats.push({ table: t.table, domain: t.domain, expected, exported, parts: partFiles.length, status, error });
      if (status !== 'COMPLETE') warnings.push(`${t.table} : ${status}${error ? ` — ${error}` : ` — ${exported} ligne(s) exportée(s) sur ${expected ?? '?'} attendue(s)`}.`);
    }

    // ── Calculs : lignes TCO du moteur existant, dans le même instantané ──
    progress.table = 'calculs/tco';
    const { loadTcoContext, tcoSummary } = await import('./trace');
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const dialect = new PgDialect();
    const runner = { execute: async (q: import('drizzle-orm').SQL) => { const x = dialect.sqlToQuery(q); return s.q(x.sql, x.params); } };
    const assets = await s.savepoint(() => s.q(`SELECT id, account_id FROM assets WHERE deleted_at IS NULL ORDER BY account_id, id`)).catch((e) => { warnings.push(`TCO : liste des biens illisible — ${describe(e)}.`); return [] as Row[]; });
    const lignesUp: { k: number; inPart: number; up: Awaited<ReturnType<typeof openGzipUpload>> | null; files: RecetteFile[] } = { k: 0, inPart: 0, up: null, files: [] };
    const openLines = async () => {
      const f: RecetteFile = { path: `calculs/tco-lignes.part-${String(lignesUp.files.length + 1).padStart(4, '0')}.ndjson.gz`, nature: 'calcul', table: null, domain: 'tco', part: null, expected: null, exported: 0, bytes: 0, compressedBytes: null, sha256: null, contentType: NDJSON, status: 'FAILED', error: null };
      lignesUp.files.push(f);
      lignesUp.up = await openGzipUpload(storage.client, storage.bucket, `${prefix}${f.path}`, { contentType: 'application/gzip' });
      lignesUp.inPart = 0;
    };
    const closeLines = async () => {
      const f = lignesUp.files[lignesUp.files.length - 1];
      const r = await lignesUp.up!.finish();
      lignesUp.up = null;
      Object.assign(f, { exported: lignesUp.inPart, bytes: r.bytes, compressedBytes: r.compressedBytes, sha256: r.sha256, status: 'COMPLETE' });
      progress.files++; progress.bytes += r.bytes; tick();
    };
    const synth: RecetteFile = { path: 'calculs/tco-syntheses.ndjson.gz', nature: 'calcul', table: null, domain: 'tco', part: null, expected: assets.length, exported: 0, bytes: 0, compressedBytes: null, sha256: null, contentType: NDJSON, status: 'FAILED', error: null };
    const tcoErrors: string[] = [];
    try {
      const synthUp = await openGzipUpload(storage.client, storage.bucket, `${prefix}${synth.path}`, { contentType: 'application/gzip' });
      await openLines();
      for (const a of assets) {
        const accountId = Number(a.account_id);
        const assetId = Number(a.id);
        let ctx;
        try {
          ctx = await s.savepoint(() => loadTcoContext(accountId, assetId, today, runner));
        } catch (e) {
          if ((e as { code?: string })?.code === '25006') throw e;
          tcoErrors.push(`bien #${assetId} : ${describe(e)}`);
          continue;
        }
        if (ctx.unavailable) tcoErrors.push(`bien #${assetId} : ${ctx.unavailable}`);
        await synthUp.write(`${recetteLine(mask({ accountId, ...tcoSummary(ctx) }))}\n`);
        synth.exported++;
        let chunk = '';
        for (const l of ctx.result?.lines ?? []) {
          if (lignesUp.inPart === partRows) { if (chunk) { await lignesUp.up!.write(chunk); chunk = ''; } await closeLines(); await openLines(); }
          chunk += `${recetteLine(mask({ accountId, assetId, visible: ctx.visible.has(l.id), motifMasquage: ctx.hidden[l.id] ?? null, ...(l as unknown as Row) }))}\n`;
          lignesUp.inPart++;
        }
        if (chunk) await lignesUp.up!.write(chunk);
      }
      await closeLines();
      const r = await synthUp.finish();
      Object.assign(synth, { bytes: r.bytes, compressedBytes: r.compressedBytes, sha256: r.sha256, status: sectionStatus(synth.expected, synth.exported, null) });
      progress.files++; progress.bytes += r.bytes; tick();
    } catch (e) {
      if ((e as { code?: string })?.code === '25006') throw e;
      await lignesUp.up?.abort();
      synth.error = describe(e);
      tcoErrors.push(`calcul interrompu : ${synth.error}`);
    }
    const tcoNatural = tcoErrors.filter((x) => !/supprimé ou introuvable/.test(x));
    for (const f of [...lignesUp.files, synth]) {
      if (f.status === 'COMPLETE' && tcoNatural.length) { f.status = 'PARTIAL'; f.error = `${tcoNatural.length} bien(s) sans TCO calculé (voir les avertissements)`; }
      files.push(f);
    }
    if (tcoNatural.length) warnings.push(`TCO calculé indisponible pour ${tcoNatural.length} bien(s) : ${tcoNatural.slice(0, 20).join(' ; ')}${tcoNatural.length > 20 ? ' …' : ''}.`);

    // ── Calculs : Timeline de chaque bien (lot 84C), dans le même instantané ──
    // MÊME fonction de lecture que la fiche du bien (`readAssetTimelineAll` →
    // `readAssetTimelinePage`) : une ligne par bien, vues « regroupée » et
    // « détaillée » complètes (toutes les pages), date de référence `today`.
    progress.table = 'calculs/timeline';
    const { readAssetTimelineAll } = await import('@/services/agenda/timeline/read');
    const tq = (text: string, params: unknown[] = []) => s.q(text, params);
    const tl: { inPart: number; up: Awaited<ReturnType<typeof openGzipUpload>> | null; files: RecetteFile[] } = { inPart: 0, up: null, files: [] };
    const openTl = async () => {
      const f: RecetteFile = { path: `calculs/timeline.part-${String(tl.files.length + 1).padStart(4, '0')}.ndjson.gz`, nature: 'calcul', table: null, domain: 'agenda-timeline', part: null, expected: null, exported: 0, bytes: 0, compressedBytes: null, sha256: null, contentType: NDJSON, status: 'FAILED', error: null };
      tl.files.push(f);
      tl.up = await openGzipUpload(storage.client, storage.bucket, `${prefix}${f.path}`, { contentType: 'application/gzip' });
      tl.inPart = 0;
    };
    const closeTl = async () => {
      const f = tl.files[tl.files.length - 1];
      const r = await tl.up!.finish();
      tl.up = null;
      Object.assign(f, { exported: tl.inPart, bytes: r.bytes, compressedBytes: r.compressedBytes, sha256: r.sha256, status: 'COMPLETE' });
      progress.files++; progress.bytes += r.bytes; tick();
    };
    const tlErrors: string[] = [];
    let tlExported = 0;
    try {
      await openTl();
      for (const a of assets) {
        const accountId = Number(a.account_id);
        const assetId = Number(a.id);
        let line: Row;
        try {
          line = await s.savepoint(async () => {
            const regroupee = await readAssetTimelineAll({ accountId, assetId, mode: 'grouped', today, q: tq });
            const detaillee = await readAssetTimelineAll({ accountId, assetId, mode: 'detailed', today, q: tq });
            return { accountId, assetId, today, entrees: { regroupee: regroupee.length, detaillee: detaillee.length }, regroupee, detaillee };
          });
        } catch (e) {
          if ((e as { code?: string })?.code === '25006') throw e;
          tlErrors.push(`bien #${assetId} : ${describe(e)}`);
          continue;
        }
        if (tl.inPart === partRows) { await closeTl(); await openTl(); }
        await tl.up!.write(`${recetteLine(mask(line))}\n`);
        tl.inPart++;
        tlExported++;
      }
      await closeTl();
    } catch (e) {
      if ((e as { code?: string })?.code === '25006') throw e;
      await tl.up?.abort();
      tlErrors.push(`calcul interrompu : ${describe(e)}`);
    }
    for (const f of tl.files) {
      if (f.status === 'COMPLETE' && tlErrors.length) { f.status = 'PARTIAL'; f.error = `${tlErrors.length} bien(s) sans Timeline calculée (voir les avertissements)`; }
      if (f.status === 'FAILED' && !f.error) f.error = tlErrors[tlErrors.length - 1] ?? null;
      files.push(f);
    }
    if (tlErrors.length) warnings.push(`Timeline calculée indisponible pour ${tlErrors.length} bien(s) (${tlExported} calculée(s)) : ${tlErrors.slice(0, 20).join(' ; ')}${tlErrors.length > 20 ? ' …' : ''}.`);

    // ── Documentation, puis manifeste EN DERNIER ──────────────────────────
    progress.table = null;
    const dict = buildDictionary(cls, meta, tableStats, files, partRows);
    await putSmall('dictionnaire.json', `${JSON.stringify(dict, null, 2)}\n`, 'application/json', 'documentation');
    await putSmall('dictionnaire.csv', dictionaryCsv(dict), 'text/csv', 'documentation');

    const finishedAt = now().toISOString();
    const build = getBuildIdentity();
    const docFiles = (): RecetteManifest => {
      const counted = tableStats.filter((x) => x.expected !== null);
      const status = globalStatus([...files.map((f) => ({ status: f.status })), ...tableStats.map((x) => ({ status: x.status }))]);
      return {
        schema: RECETTE_SCHEMA, generationId: opts.generationId, generatedAt: generatedAt.toISOString(), finishedAt,
        environment: (process.env.NEXT_PUBLIC_APP_ENV || process.env.NODE_ENV || 'inconnu').trim(),
        build: { version: build.version ?? null, commit: build.commit ?? null },
        perimeter: {
          description: 'Tous les comptes de la base (actifs ou non), toutes les lignes des tables du périmètre de recette (décisions PO C-Q5 / §4.2).',
          accounts: acc?.n == null ? null : Number(acc.n), tablesExported: cls.included.length, tablesExcluded: cls.excluded, tablesUnclassified: cls.unclassified,
        },
        snapshot: {
          isolation: s.info.isolation, at: s.info.at, snapshot: s.info.snapshot,
          verification: 'Toutes les lectures (tables et calcul du TCO) dans UNE transaction REPEATABLE READ READ ONLY : instant de cohérence ci-dessus. '
            + 'Attendu = count(*) dans le même instantané ; exporté = lignes écrites ; COMPLETE seulement si exporté = attendu pour chaque partie et chaque table, '
            + 'sans erreur. SHA-256 et octets de chaque fichier calculés sur le contenu NON compressé.',
          exceptions,
        },
        options: { partRows, batchRows, sensitiveContent: !!opts.includeSensitiveContent, today },
        tables: tableStats,
        files: [...files],
        totals: {
          // + LISEZMOI (s'il n'est pas encore écrit) + manifeste (jamais dans sa propre liste).
          files: files.length + (files.some((f) => f.path === 'LISEZMOI.txt') ? 1 : 2), tables: tableStats.length,
          rowsExpected: counted.reduce((n, x) => n + (x.expected ?? 0), 0), rowsExported: tableStats.reduce((n, x) => n + x.exported, 0),
          bytes: files.reduce((n, f) => n + f.bytes, 0), compressedBytes: files.reduce((n, f) => n + (f.compressedBytes ?? f.bytes), 0),
        },
        status, warnings, masking: [...RECETTE_MASKING_NOTES],
      };
    };
    await putSmall('LISEZMOI.txt', recetteReadme(docFiles()), 'text/plain', 'documentation');
    const manifest = docFiles();
    await storage.client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: `${prefix}manifeste.json`, Body: `${JSON.stringify(manifest, null, 2)}\n`, ContentType: 'application/json; charset=utf-8' }));
    return manifest;
  } finally {
    if (own) await (s as ReadSession & { close(): Promise<void> }).close().catch(() => undefined);
  }
}

// ── Documentation (pure) ────────────────────────────────────────────────────

interface RecetteDictionary {
  schema: typeof RECETTE_SCHEMA;
  format: string[];
  domains: Array<{ domain: RecetteDomain; label: string; description: string; tables: string[] }>;
  tables: Array<{
    table: string; domain: RecetteDomain; description: string; files: string[]; rows: number | null; sortKey: string[];
    primaryKey: string[];
    columns: Array<{ name: string; type: string; nullable: boolean; generated: boolean; comment: string | null; masking: string | null }>;
    relations: Array<{ constraint: string; columns: string[]; references: string; referencedColumns: string[] }>;
  }>;
  computed: Array<{ path: string; description: string; fields: string }>;
  excluded: Array<{ table: string; motif: string }>;
  markers: string[];
}

export function buildDictionary(
  cls: ReturnType<typeof classifyTables>, meta: Map<string, TableMeta>, stats: RecetteTableStat[], files: RecetteFile[], partRows: number,
): RecetteDictionary {
  const domains = Object.keys(RECETTE_DOMAINS) as RecetteDomain[];
  return {
    schema: RECETTE_SCHEMA,
    format: [
      'Chaque fichier `donnees/<domaine>/<table>.part-NNNN.ndjson.gz` est un texte UTF-8 compressé gzip : UNE ligne JSON par ligne de la table, avec TOUTES ses colonnes (noms de la base).',
      'Valeurs telles que PostgreSQL les rend (row_to_json) : horodatages ISO 8601 avec fuseau et microsecondes, dates AAAA-MM-JJ, montants en centimes / unités mineures (`*_cents`, `*_minor`), JSON imbriqué tel quel.',
      `Lignes triées par clé primaire (sinon par le texte JSON complet de la ligne) ; une partie contient au plus ${partRows} lignes ; les parties d’une table se lisent dans l’ordre de leur numéro.`,
      'Comparer deux exports : apparier les lignes par table + clé primaire (identifiants jamais masqués), puis comparer les colonnes.',
      'Vérifier la complétude : manifeste.json → pour chaque partie, `exported` = `expected` = nombre de lignes du fichier décompressé ; SHA-256 du contenu décompressé ; totaux par table (`tables`) et globaux (`totals`).',
    ],
    domains: domains.map((d) => ({ domain: d, ...RECETTE_DOMAINS[d], tables: cls.included.filter((x) => x.domain === d).map((x) => x.table) })).filter((d) => d.tables.length),
    tables: cls.included.map((t) => {
      const m = meta.get(t.table) ?? { columns: [], pk: [], fks: [] };
      const st = stats.find((x) => x.table === t.table);
      return {
        table: t.table, domain: t.domain, description: t.description,
        files: files.filter((f) => f.table === t.table).map((f) => f.path), rows: st?.expected ?? null,
        sortKey: m.pk.length ? m.pk : ['(texte JSON de la ligne)'], primaryKey: m.pk,
        columns: m.columns.map((c) => {
          const r = exportMaskingRule(c.name);
          return { ...c, masking: r ? (r.content ? `${r.motif} : longueur + SHA-256 (intégral sur habilitation)` : r.email ? 'e-mail : pseudonyme stable' : r.motif) : null };
        }),
        relations: m.fks.map((f) => ({ constraint: f.name, columns: f.columns, references: f.references, referencedColumns: f.referencedColumns })),
      };
    }),
    computed: [
      { path: 'calculs/tco-lignes.part-NNNN.ndjson.gz', description: 'Lignes TCO calculées par le moteur existant (readAssetTco) pour chaque bien non supprimé, à la date de référence (manifeste › options.today), dans l’instantané de l’export.', fields: 'accountId, assetId, visible (affichée sur la fiche), motifMasquage, puis les champs de la ligne TCO (id, catégorie, statut, motif, montants en centimes, Opération, composante, document…).' },
      { path: 'calculs/tco-syntheses.ndjson.gz', description: 'Synthèse TCO par bien (totaux, fiabilité, indisponibilité motivée).', fields: 'accountId, assetId, disponible, totaux et postes du moteur TCO, nombre de lignes.' },
      { path: 'calculs/timeline.part-NNNN.ndjson.gz', description: 'Timeline de chaque bien non supprimé, calculée par la même fonction que la fiche du bien (lot 84C), vues « regroupée » et « détaillée » complètes, dans l’instantané de l’export, à la date de référence (manifeste › options.today). Aucune table propre : calcul depuis agenda_items / agenda_asset_links (« annule » exclu).', fields: 'accountId, assetId, today, entrees {regroupee, detaillee}, regroupee[] et detaillee[] : entrées triées comme à l’écran (date décroissante, sans date en dernier) — kind (item | group), id, title, effectiveDate, isDone, isOverdue, toConfirm ; pour un groupe : members[] (éléments liés masqués de la liste) et counters {events, documents, assets, rooms, equipments}.' },
    ],
    excluded: cls.excluded,
    markers: [...RECETTE_MASKING_NOTES],
  };
}

const csv = (v: string) => (/[;"\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function dictionaryCsv(d: RecetteDictionary): string {
  const lines = [['domaine', 'table', 'description_table', 'colonne', 'type', 'nullable', 'generee', 'cle_primaire', 'relation', 'masquage', 'commentaire'].join(';')];
  for (const t of d.tables) {
    for (const c of t.columns) {
      const rel = t.relations.find((r) => r.columns.includes(c.name));
      lines.push([t.domain, t.table, t.description, c.name, c.type, c.nullable ? 'oui' : 'non', c.generated ? 'oui' : 'non', t.primaryKey.includes(c.name) ? 'oui' : 'non',
        rel ? `${rel.references}.${rel.referencedColumns[rel.columns.indexOf(c.name)] ?? ''}` : '', c.masking ?? '', c.comment ?? ''].map((x) => csv(String(x))).join(';'));
    }
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function recetteReadme(m: RecetteManifest): string {
  const L: string[] = [
    'VEREBONA — EXPORT COMPLET DE RECETTE',
    '',
    `Génération            : ${m.generationId}`,
    `Date d’extraction     : ${m.generatedAt} (fin : ${m.finishedAt})`,
    `Instant de cohérence  : ${m.snapshot.at} — ${m.snapshot.isolation}${m.snapshot.snapshot ? ` — instantané PostgreSQL ${m.snapshot.snapshot}` : ''}`,
    `Environnement         : ${m.environment}${m.build.commit ? ` — version ${m.build.version ?? '?'} (${m.build.commit})` : ''}`,
    `Périmètre             : ${m.perimeter.description}`,
    `Comptes               : ${m.perimeter.accounts ?? '?'} ; tables exportées : ${m.perimeter.tablesExported} ; tables exclues : ${m.perimeter.tablesExcluded.length}${m.perimeter.tablesUnclassified.length ? ` ; NON CLASSÉES (exportées) : ${m.perimeter.tablesUnclassified.join(', ')}` : ''}`,
    `Statut                : ${m.status} — ${m.totals.rowsExported} ligne(s) exportée(s) sur ${m.totals.rowsExpected} attendue(s), ${m.totals.files} fichier(s)`,
    `Contenus sensibles    : ${m.options.sensitiveContent ? 'INCLUS (administrateur habilité)' : 'masqués (longueur + SHA-256)'}`,
    `Date de référence TCO : ${m.options.today}`,
    '',
    'FICHIERS',
    '  manifeste.json        écrit EN DERNIER : sa présence atteste la fin de la génération. Pour chaque fichier : lignes attendues / exportées, octets, SHA-256 (contenu décompressé), statut.',
    '  dictionnaire.json/.csv  tables, colonnes, types, clés primaires, relations (clés étrangères), masquage.',
    `  donnees/<domaine>/<table>.part-NNNN.ndjson.gz  une ligne JSON par ligne de table (toutes les colonnes), triées par clé primaire, ${m.options.partRows} lignes au plus par partie.`,
    '  calculs/              lignes TCO calculées (moteur existant) et synthèses par bien ; Timeline de chaque bien (vues regroupée et détaillée).',
    '',
    'CONTRÔLER LA COMPLÉTUDE',
    '  1. manifeste.json › status = COMPLETE ; chaque table : exported = expected ;',
    '  2. pour chaque fichier : nombre de lignes du fichier décompressé = exported ; SHA-256 du contenu décompressé = sha256 ;',
    '  3. totals.rowsExported = somme des lignes de tous les fichiers donnees/.',
    '',
    'COMPARER DEUX EXPORTS (hors Verebona)',
    '  Apparier les lignes par table + clé primaire (identifiants jamais masqués), comparer colonne par colonne. Les marqueurs de masquage sont stables',
    '  d’un export à l’autre (pseudonyme d’e-mail, longueur + SHA-256 d’un contenu) : un changement de contenu change l’empreinte.',
    '',
    'MASQUAGE',
    ...m.masking.map((x) => `  - ${x}`),
    '',
    'DOMAINES ET TABLES (lignes)',
  ];
  for (const d of Object.keys(RECETTE_DOMAINS) as RecetteDomain[]) {
    const ts = m.tables.filter((t) => t.domain === d);
    if (!ts.length) continue;
    L.push(`  ${RECETTE_DOMAINS[d].label} — ${RECETTE_DOMAINS[d].description}`);
    for (const t of ts) L.push(`    ${t.table} : ${t.exported}${t.expected !== null && t.expected !== t.exported ? ` / ${t.expected} attendue(s)` : ''} ligne(s), ${t.parts} partie(s) — ${t.status}${t.error ? ` (${t.error})` : ''}`);
  }
  L.push('', 'TABLES EXCLUES (motif)', ...m.perimeter.tablesExcluded.map((x) => `  ${x.table} : ${x.motif}`));
  if (m.snapshot.exceptions.length) L.push('', 'EXCEPTIONS', ...m.snapshot.exceptions.map((x) => `  - ${x}`));
  if (m.warnings.length) L.push('', 'AVERTISSEMENTS', ...m.warnings.map((x) => `  - ${x}`));
  return `${L.join('\n')}\n`;
}

// ── Lancement en tâche de fond, suivi, rétention ────────────────────────────

export class RecetteBusyError extends Error {
  readonly code = 'RECETTE_BUSY';
  constructor(readonly activeId: string | null) { super('Un export complet de recette est déjà en cours de génération.'); this.name = 'RecetteBusyError'; }
}

const enCours = (): Map<string, Promise<void>> => {
  const g = globalThis as unknown as { __vbRecetteExports?: Map<string, Promise<void>> };
  return (g.__vbRecetteExports ??= new Map());
};

/** Attend la fin d'une génération lancée par ce processus (tests). */
export async function waitForRecetteExport(id: string): Promise<void> {
  await enCours().get(id);
}

const RECETTE_HEARTBEAT_MS = 30_000;

/**
 * Lance un export complet en tâche de fond (un seul à la fois) ; rend
 * l'identifiant dès que la génération est enregistrée (RUNNING).
 */
export async function startRecetteExport(
  admin: { id: number; email?: string },
  opts: Pick<RecetteOptions, 'includeSensitiveContent' | 'partRows' | 'batchRows' | 'today' | 'storage'> = {},
): Promise<{ generationId: string; storagePrefix: string }> {
  const gen = await import('@/services/admin/export-generations');
  const slot = gen.tryAcquireExportSlot('RECETTE_EXPORT');
  if (!slot) throw new RecetteBusyError(null);
  try {
    const actives = (await gen.listGenerations({ kind: 'RECETTE_EXPORT', pageSize: 5 })).items.filter((x) => x.status === 'RUNNING');
    if (actives.length) throw new RecetteBusyError(actives[0].id);
  } catch (e) {
    slot.release();
    throw e;
  }
  const generationId = randomUUID();
  const storagePrefix = recettePrefix(generationId);
  const perimeter = { comptes: 'tous', contenusSensibles: !!opts.includeSensitiveContent, partRows: opts.partRows ?? RECETTE_PART_ROWS };
  await gen.startGeneration({ id: generationId, kind: 'RECETTE_EXPORT', mode: 'stockage', adminUserId: admin.id, targetType: 'GLOBAL', targetId: null, targetAccountId: null, perimeter, storagePrefix });
  const { logAdminAction } = await import('@/lib/admin-audit');
  const audit = (result: 'SUCCESS' | 'FAILURE', details: Record<string, unknown>) => logAdminAction({
    adminId: admin.id, adminEmail: admin.email, action: 'RECETTE_EXPORT', targetType: 'RECETTE_EXPORT', targetId: null, result,
    details: { generationId, ...perimeter, ...details },
  }).catch(() => undefined);
  await audit('SUCCESS', { phase: 'launched' });

  let last = { rowsExported: 0, files: 0, bytes: 0 };
  const beat = setInterval(() => { void gen.heartbeatGeneration(generationId, last); }, RECETTE_HEARTBEAT_MS);
  beat.unref?.();
  const done = (async () => {
    try {
      const m = await runRecetteExport({ ...opts, generationId, adminUserId: admin.id, onProgress: (p) => { last = { rowsExported: p.rowsExported, files: p.files, bytes: p.bytes }; } });
      await gen.finishGeneration(generationId, {
        status: m.status, snapshotAt: m.snapshot.at, pgSnapshot: m.snapshot.snapshot, rowsExpected: m.totals.rowsExpected, rowsExported: m.totals.rowsExported,
        batches: null, bytes: m.totals.bytes, files: m.totals.files, sections: m.tables, error: m.status === 'COMPLETE' ? null : m.warnings.join(' ; ').slice(0, 4000),
        fileName: `${storagePrefix}manifeste.json`,
      });
      await audit(m.status === 'FAILED' ? 'FAILURE' : 'SUCCESS', { phase: 'finished', status: m.status, rows: m.totals.rowsExported, files: m.totals.files });
      await purgeOldRecetteExports(opts.storage).catch((e) => console.error('[admin/recette] purge des anciens exports impossible :', (e as Error).message));
    } catch (e) {
      console.error('[admin/recette] génération en échec :', (e as Error)?.message ?? e);
      await gen.finishGeneration(generationId, { status: 'FAILED', error: describe(e) });
      await audit('FAILURE', { phase: 'finished', error: describe(e) });
    } finally {
      clearInterval(beat);
      slot.release();
    }
  })().finally(() => enCours().delete(generationId));
  enCours().set(generationId, done);
  return { generationId, storagePrefix };
}

/** Exports de recette de plus de `RECETTE_RETENTION_DAYS` jours : supprimés du stockage. */
async function purgeOldRecetteExports(storage?: RecetteStorage, now: Date = new Date()): Promise<number> {
  const st = storage ?? await defaultStorage();
  const { ListObjectsV2Command, DeleteObjectsCommand } = await import('@aws-sdk/client-s3');
  const limite = now.getTime() - RECETTE_RETENTION_DAYS * 24 * 60 * 60_000;
  let token: string | undefined;
  let n = 0;
  do {
    const r = await st.client.send(new ListObjectsV2Command({ Bucket: st.bucket, Prefix: RECETTE_PREFIX, ContinuationToken: token })) as {
      Contents?: Array<{ Key?: string; LastModified?: Date }>; IsTruncated?: boolean; NextContinuationToken?: string;
    };
    const old = (r.Contents ?? []).filter((o) => o.Key && o.LastModified && o.LastModified.getTime() < limite).map((o) => ({ Key: o.Key! }));
    if (old.length) { await st.client.send(new DeleteObjectsCommand({ Bucket: st.bucket, Delete: { Objects: old, Quiet: true } })); n += old.length; }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return n;
}

/** Manifeste stocké d'une génération ; null : absent (génération en cours, interrompue ou purgée). */
export async function readRecetteManifest(generationId: string, storage?: RecetteStorage): Promise<RecetteManifest | null> {
  const st = storage ?? await defaultStorage();
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  try {
    const o = await st.client.send(new GetObjectCommand({ Bucket: st.bucket, Key: `${recettePrefix(generationId)}manifeste.json` })) as { Body?: { transformToString(): Promise<string> } };
    return JSON.parse(await o.Body!.transformToString()) as RecetteManifest;
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === 'NoSuchKey' || (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}
