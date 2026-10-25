/**
 * Lot 88A — DIAGNOSTIC GLOBAL D'UN COMPTE (ticket P1 « Rendre le diagnostic
 * global exhaustif et auto-suffisant »). Serveur uniquement.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * EXTENSION DU DIAGNOSTIC TECHNIQUE (77C / 81C), PAS UN SECOND EXPORT
 *
 * Appelé par `planDiagnostic` (collect.ts) pour le périmètre « Un compte » :
 * mêmes session REPEATABLE READ READ ONLY, plan puis production en flux,
 * fichiers comptés (attendu = compte SQL indépendant, exporté = lignes
 * écrites), SHA-256, manifeste et rapport en dernier. Ajoute :
 *
 *   · TOUTES les lignes de TOUTES les tables du compte (registre de
 *     couverture `coverage.ts`), toutes colonnes sauf exclusions de sécurité
 *     (`security.ts`), triées par clé primaire, lues par curseur et
 *     découpées en parties — aucune limite, aucun filtre de période ;
 *   · FERMETURE TRANSITIVE : chaque référence (clés étrangères du catalogue
 *     + références logiques déclarées) partant d'une ligne du compte est
 *     vérifiée dans l'instantané ; une cible globale hors filtre est ajoutée
 *     (`compte/fermeture/`), une cible absente est déclarée
 *     (`controle/references.json`) et rend sa section PARTIAL ;
 *   · AUTO-CONTRÔLE : compteurs annoncés vs lignes détaillées ; couverture
 *     des tables (une table non déclarée est exportée par prudence et
 *     signalée) ;
 *   · traçabilité par propriété et projection API → écran (`properties.ts`) ;
 *   · versions applicatives, migrations, configuration IA par empreinte.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { ReadSession } from '@/services/admin/account-data/session';
import { getBuildIdentity } from '@/lib/runtime-identity';
import { RECETTE_TABLES } from './recette-catalog';
import type { DiagFileInfo, DiagUnavailable } from './model';
import {
  DIAG_ANNOUNCED_COUNTS, DIAG_LOGICAL_REFERENCES, DIAG_SECTIONS, DIAG_SECTION_ORDER, DIAG_TABLE_COVERAGE, DIAG_TABLE_EXCLUSIONS,
  classifyDiagTables, coverageFilter, isExternalReferenceColumn, type DiagSectionCode, type DiagTableCoverage,
} from './coverage';
import { DIAG_SECURITY_NOTES, excludedColumnMotif } from './security';
import { maskDiagRow } from './account-model';

type Row = Record<string, unknown>;
type EntryBody = (w: (c: string) => Promise<void>) => Promise<{ expected: number | null; count?: number; batches: number; error: string | null; status?: DiagFileInfo['status'] }>;

/** Outils du plan (collect.ts) prêtés au diagnostic de compte. */
export interface DiagPlanKit {
  s: ReadSession;
  A: number;
  V: Record<string, unknown>;
  isSensitiveKey: (k: string) => boolean;
  M: (v: unknown) => unknown;
  safeJson: (v: unknown) => string;
  entry: (path: string, description: string, body: EntryBody, part?: DiagFileInfo['part'], section?: DiagSectionCode) => void;
  list: (path: string, description: string, text: string, transform?: (r: Row) => Row, opt?: { onlyIfRows?: boolean; serialize?: (r: Row) => string; section?: DiagSectionCode; values?: Record<string, unknown> }) => Promise<number>;
  issues: Map<DiagSectionCode, string[]>;
  filters: Map<DiagSectionCode, string[]>;
  limitations: Map<DiagSectionCode, string[]>;
  warnings: string[];
  unavailable: DiagUnavailable[];
  today?: string;
}

/** Ce que le diagnostic de compte ajoute au manifeste. */
export interface AccountManifestPart {
  couverture: {
    tablesEnBase: number; couvertes: number; exclues: number; nonClassees: string[]; declareesAbsentes: string[];
  };
  exclusionsVolontaires: {
    notes: readonly string[];
    tables: Array<{ table: string; categorie: string; motif: string }>;
    colonnes: Array<{ table: string; colonne: string; motif: string }>;
  };
  autoControle: {
    references: { verifiees: number; valeurs: number; resolues: number; fermeture: number; externes: number; versTableExclue: number; absentes: number; clesMultiColonnes: number; declareesInvalides: string[] };
    compteursAnnonces: { controles: number; ecartsStricts: number; ecartsInformatifs: number };
    conclusion: string;
  };
}

const ident = (t: string) => `"${t.replace(/"/g, '""')}"`;
const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => { if (!m.has(k)) m.set(k, []); m.get(k)!.push(v); };
const describe = (e: unknown): string => `${(e as { code?: string })?.code ? `${(e as { code?: string }).code} — ` : ''}${(e as Error)?.message ?? String(e)}`.slice(0, 500);

interface TableMeta { columns: string[]; pk: string[]; excluded: Array<{ colonne: string; motif: string }> }

async function readTables(s: ReadSession): Promise<string[]> {
  return (await s.q(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)).map((r) => String(r.t));
}

async function readMeta(s: ReadSession, tables: string[]): Promise<Map<string, TableMeta>> {
  const meta = new Map<string, TableMeta>(tables.map((t) => [t, { columns: [], pk: [], excluded: [] }]));
  for (const r of await s.q(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1::text[]) ORDER BY table_name, ordinal_position`, [tables])) {
    const m = meta.get(String(r.table_name));
    if (!m) continue;
    const col = String(r.column_name);
    const x = excludedColumnMotif(String(r.table_name), col);
    if (x) m.excluded.push({ colonne: col, motif: x.motif });
    else m.columns.push(col);
  }
  for (const r of await s.q(`
      SELECT c.relname AS t, a.attname AS col, k.ord
        FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
        CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
       WHERE i.indisprimary AND c.relname = ANY($1::text[]) ORDER BY c.relname, k.ord`, [tables])) {
    meta.get(String(r.t))?.pk.push(String(r.col));
  }
  return meta;
}

/** Requête d'export d'une table du compte (colonnes autorisées, filtre de compte, tri stable). */
export function tableSql(table: string, m: TableMeta, filter: string): string {
  const cols = m.columns.length ? m.columns.map((c) => `t.${ident(c)}`).join(', ') : 'NULL AS aucune_colonne_exportable';
  const order = m.pk.length ? m.pk.map((c) => `t.${ident(c)}`).join(', ') : 'row_to_json(t)::text';
  return `SELECT ${cols} FROM ${ident(table)} t WHERE (${filter}) ORDER BY ${order}`;
}

interface RefSpec {
  from: string; column: string; to: string; toColumn: string; kind: 'value' | 'json-array' | 'pg-array'; when?: string; role: string; origin: 'FK' | 'LOGIQUE';
}

interface RefResult extends RefSpec {
  valeurs: number; resolues: number; fermeture: string[]; externes: number; versTableExclue: number; absentes: string[];
  motif?: string; erreur?: string;
}

/** Valeurs référencées par la colonne (texte), selon le type de référence. */
function refValueExpr(r: RefSpec): string {
  const c = `t.${ident(r.column)}`;
  if (r.kind === 'json-array') return `jsonb_array_elements_text(CASE WHEN jsonb_typeof(to_jsonb(${c})) = 'array' THEN to_jsonb(${c}) ELSE '[]'::jsonb END)`;
  if (r.kind === 'pg-array') return `unnest(${c})::text`;
  return `${c}::text`;
}

async function readForeignKeys(s: ReadSession): Promise<{ refs: RefSpec[]; multi: number }> {
  const rows = await s.q(`
    SELECT fc.relname AS from_table, a.attname AS from_col, tc.relname AS to_table, af.attname AS to_col, array_length(c.conkey, 1) AS n
      FROM pg_constraint c
      JOIN pg_class fc ON fc.oid = c.conrelid JOIN pg_namespace fn ON fn.oid = fc.relnamespace AND fn.nspname = 'public'
      JOIN pg_class tc ON tc.oid = c.confrelid
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = c.confkey[1]
     WHERE c.contype = 'f' ORDER BY 1, 2, 3`);
  const refs: RefSpec[] = [];
  let multi = 0;
  for (const r of rows) {
    if (Number(r.n) !== 1) { multi++; continue; }
    refs.push({ from: String(r.from_table), column: String(r.from_col), to: String(r.to_table), toColumn: String(r.to_col), kind: 'value', role: 'clé étrangère', origin: 'FK' });
  }
  return { refs, multi };
}

/**
 * Plan du diagnostic de compte : fichiers des tables, fermeture, contrôles,
 * traçabilité. Rend la part du manifeste (couverture, exclusions,
 * auto-contrôle) — complétée au fil de la production.
 */
export async function planAccountDiagnostic(kit: DiagPlanKit): Promise<AccountManifestPart> {
  const { s, A } = kit;
  /** Requête sur le compte : `{{A}}` → $1 (paramètre transmis seulement s'il est utilisé). */
  const qa = (text: string) => { const t = text.replace(/\{\{A\}\}/g, () => '$1'); return s.q(t, t.includes('$1') ? [A] : []); };
  const tables = await readTables(s);
  const cls = classifyDiagTables(tables);
  const accountCols = new Set((await s.q(`SELECT table_name AS t FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'account_id'`)).map((r) => String(r.t)));
  const toDump: Array<{ table: string; c: DiagTableCoverage; unclassified?: boolean }> = cls.covered.map((x) => ({ table: x.table, c: x }));
  for (const t of cls.unclassified) {
    if (accountCols.has(t)) {
      toDump.push({ table: t, c: { section: 'non-classees' }, unclassified: true });
      push(kit.issues, 'non-classees', `table ${t} absente du registre de couverture : exportée par prudence (filtre account_id), à classer (coverage.ts)`);
    } else {
      push(kit.issues, 'non-classees', `table ${t} absente du registre de couverture et sans account_id : NON exportée (aucun rattachement au compte connu), à classer (coverage.ts)`);
    }
  }
  for (const t of cls.missing) kit.warnings.push(`couverture : table déclarée ${t} absente de la base (migration non appliquée ou table retirée).`);
  const meta = await readMeta(s, toDump.map((x) => x.table));
  const filterOf = new Map(toDump.map((x) => [x.table, coverageFilter(x.c)]));
  const sectionOfTable = new Map(toDump.map((x) => [x.table, x.c.section]));
  const ser = (r: Row) => kit.safeJson(maskDiagRow(r, { isSensitiveKey: kit.isSensitiveKey }));

  kit.filters.set('etat-metier', [`Compte #${A} : toutes les lignes de chaque table, sans filtre de période (historique complet) ni plafond.`]);
  for (const code of DIAG_SECTION_ORDER) if (code !== 'etat-metier' && !kit.filters.has(code)) kit.filters.set(code, [`Compte #${A} : toutes les lignes, sans filtre de période ni plafond.`]);
  kit.filters.set('referentiels', ['Tables globales sans donnée de compte (référentiels, configuration IA par empreinte) : toutes les lignes ; colonnes de texte de prompt remplacées par leur empreinte.']);

  // ── 1. Tables du compte (ordre : sections, puis nom) ────────────────────
  const order = (x: { table: string; c: DiagTableCoverage }) => DIAG_SECTION_ORDER.indexOf(x.c.section);
  for (const x of [...toDump].sort((a, b) => order(a) - order(b) || a.table.localeCompare(b.table))) {
    const m = meta.get(x.table)!;
    const filter = filterOf.get(x.table)!;
    const desc = `${x.table} — ${RECETTE_TABLES[x.table]?.description ?? DIAG_SECTIONS[x.c.section].label}${x.c.global ? ' (table globale)' : ''} — filtre : ${filter.replace(/\s+/g, ' ')}`;
    await kit.list(`compte/${x.c.section}/${x.table}.json`, desc, tableSql(x.table, m, filter), undefined, { serialize: ser, section: x.c.section });
  }

  // ── 2. Fermeture transitive et références (même instantané) ─────────────
  const fk = await readForeignKeys(s);
  const declaredInvalid: string[] = [];
  const colsOf = async (t: string): Promise<Set<string>> => new Set((await s.q(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [t])).map((r) => String(r.c)));
  const present = new Set(tables);
  const specs: RefSpec[] = [];
  const seen = new Set<string>();
  for (const r of [...DIAG_LOGICAL_REFERENCES.map((l): RefSpec => ({ from: l.from, column: l.column, to: l.to, toColumn: l.toColumn ?? 'id', kind: l.kind ?? 'value', when: l.when, role: l.role, origin: 'LOGIQUE' })), ...fk.refs]) {
    const key = `${r.from}.${r.column}->${r.to}.${r.toColumn}|${r.when ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!filterOf.has(r.from)) continue; // source non exportée : hors périmètre du compte
    if (r.origin === 'LOGIQUE') {
      if (!present.has(r.from) || !(await colsOf(r.from)).has(r.column)) { declaredInvalid.push(`${r.from}.${r.column} (table ou colonne absente)`); continue; }
      if (present.has(r.to) && !(await colsOf(r.to)).has(r.toColumn)) { declaredInvalid.push(`${r.to}.${r.toColumn} (colonne cible absente)`); continue; }
    }
    if (meta.get(r.from)?.excluded.some((e) => e.colonne === r.column)) continue; // colonne de sécurité : non exportée
    specs.push(r);
  }
  const results: RefResult[] = [];
  const closure = new Map<string, { toColumn: string; values: Set<string> }>();
  for (const r of specs) {
    const out: RefResult = { ...r, valeurs: 0, resolues: 0, fermeture: [], externes: 0, versTableExclue: 0, absentes: [] };
    results.push(out);
    const fromFilter = filterOf.get(r.from)!;
    const src = `SELECT DISTINCT ${refValueExpr(r)} AS v FROM ${ident(r.from)} t WHERE (${fromFilter})${r.when ? ` AND (${r.when})` : ''}`;
    try {
      if (!present.has(r.to)) {
        const n = await s.savepoint(() => qa(`SELECT count(*)::int AS n FROM (${src}) x WHERE v IS NOT NULL`));
        out.valeurs = Number(n[0]?.n ?? 0);
        out.absentes = out.valeurs ? ['(table cible absente de la base)'] : [];
        out.motif = 'table cible absente';
        continue;
      }
      const toCov = DIAG_TABLE_COVERAGE[r.to];
      if (!filterOf.has(r.to)) {
        const n = await s.savepoint(() => qa(`SELECT count(*)::int AS n FROM (${src}) x WHERE v IS NOT NULL`));
        out.valeurs = Number(n[0]?.n ?? 0);
        out.versTableExclue = out.valeurs;
        out.motif = `table cible exclue : ${DIAG_TABLE_EXCLUSIONS[r.to]?.motif ?? 'non classée sans account_id'}`;
        continue;
      }
      const toFilter = filterOf.get(r.to)!;
      // Jointures par hachage (texte) : linéaire, quel que soit le volume du compte ; seules les
      // valeurs NON résolues remontent (mémoire bornée par les manques, pas par le volume).
      const sql = `WITH s AS (SELECT v FROM (${src}) x WHERE v IS NOT NULL),
             e AS (SELECT DISTINCT t.${ident(r.toColumn)}::text AS k FROM ${ident(r.to)} t WHERE (${toFilter}))
             ${toCov?.global ? `, g AS (SELECT DISTINCT t.${ident(r.toColumn)}::text AS k FROM ${ident(r.to)} t WHERE t.${ident(r.toColumn)}::text IN (SELECT v FROM s))` : ''}
        SELECT count(*)::int AS valeurs, count(e.k)::int AS resolues,
               coalesce(array_agg(s.v ORDER BY s.v) FILTER (WHERE e.k IS NULL ${toCov?.global ? 'AND g.k IS NOT NULL' : 'AND false'}), '{}') AS existantes,
               coalesce(array_agg(s.v ORDER BY s.v) FILTER (WHERE e.k IS NULL ${toCov?.global ? 'AND g.k IS NULL' : ''}), '{}') AS manquantes
          FROM s LEFT JOIN e ON e.k = s.v ${toCov?.global ? 'LEFT JOIN g ON g.k = s.v' : ''}`;
      const [agg] = await s.savepoint(() => qa(sql));
      const external = isExternalReferenceColumn(r.from, r.column) ?? toCov?.externalRefs ?? null;
      out.valeurs = Number(agg?.valeurs ?? 0);
      out.resolues = Number(agg?.resolues ?? 0);
      const existantes = ((agg?.existantes ?? []) as unknown[]).map(String);
      const manquantes = ((agg?.manquantes ?? []) as unknown[]).map(String);
      if (existantes.length) {
        out.fermeture.push(...existantes);
        if (!closure.has(r.to)) closure.set(r.to, { toColumn: r.toColumn, values: new Set() });
        for (const v of existantes) closure.get(r.to)!.values.add(v);
      }
      if (external) out.externes = manquantes.length;
      else out.absentes.push(...manquantes);
      if (external && out.externes) out.motif = `hors compte attendu : ${external}`;
    } catch (e) {
      if ((e as { code?: string })?.code === '25006') throw e;
      out.erreur = describe(e);
      push(kit.issues, sectionOfTable.get(r.from) ?? 'controle', `référence ${r.from}.${r.column} → ${r.to} non vérifiée : ${out.erreur}`);
    }
    if (out.absentes.length) {
      push(kit.issues, sectionOfTable.get(r.from) ?? 'controle', `${out.absentes.length} référence(s) ${r.from}.${r.column} → ${r.to}.${r.toColumn} absente(s) de l’archive (ligne supprimée ou hors compte) — détail : controle/references.json`);
    }
  }

  // Fichiers de fermeture : lignes hors filtre direct citées par le compte (tables globales).
  for (const [to, c] of [...closure.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const m = (await readMeta(s, [to])).get(to)!;
    const values = [...c.values];
    const cols = m.columns.length ? m.columns.map((x) => `t.${ident(x)}`).join(', ') : 'NULL AS aucune_colonne_exportable';
    const orderBy = m.pk.length ? m.pk.map((x) => `t.${ident(x)}`).join(', ') : 'row_to_json(t)::text';
    await kit.list(`compte/fermeture/${to}.json`, `${to} — lignes hors périmètre direct citées par le compte (fermeture transitive : ${values.length} identifiant(s))`,
      `SELECT ${cols} FROM ${ident(to)} t WHERE t.${ident(c.toColumn)}::text = ANY({{fermeture}}::text[]) ORDER BY ${orderBy}`, undefined,
      { serialize: ser, section: 'controle', values: { fermeture: values } });
  }

  const refTotals = {
    verifiees: results.length,
    valeurs: results.reduce((n, r) => n + r.valeurs, 0),
    resolues: results.reduce((n, r) => n + r.resolues, 0),
    fermeture: results.reduce((n, r) => n + r.fermeture.length, 0),
    externes: results.reduce((n, r) => n + r.externes, 0),
    versTableExclue: results.reduce((n, r) => n + r.versTableExclue, 0),
    absentes: results.reduce((n, r) => n + r.absentes.length, 0),
    clesMultiColonnes: fk.multi,
    declareesInvalides: declaredInvalid,
  };
  for (const d of declaredInvalid) kit.warnings.push(`référence logique déclarée invalide : ${d} (coverage.ts).`);
  kit.entry('controle/references.json', 'Fermeture transitive : chaque référence (clés étrangères + références logiques déclarées) partant d’une ligne du compte — résolues, ajoutées hors périmètre direct, hors compte attendues, vers table exclue, ABSENTES (valeurs listées intégralement)', async (w) => {
    await w(`${JSON.stringify({ totaux: refTotals, references: results.map((r) => ({ ...r, fermeture: r.fermeture.length, valeursFermeture: r.fermeture })) }, null, 2)}\n`);
    return { expected: results.length, count: results.length, batches: 1, error: null };
  }, undefined, 'controle');

  // ── 3. Compteurs annoncés vs lignes détaillées ──────────────────────────
  const announced: Array<{ code: string; label: string; strict: boolean; section: DiagSectionCode; controles: number; ecarts: Row[]; erreur?: string }> = [];
  for (const c of DIAG_ANNOUNCED_COUNTS) {
    const item: (typeof announced)[number] = { code: c.code, label: c.label, strict: c.strict, section: c.section, controles: 0, ecarts: [] };
    announced.push(item);
    try {
      const rows = await s.savepoint(() => qa(`SELECT * FROM (${c.sql}) x ORDER BY x.id`));
      item.controles = rows.length;
      item.ecarts = rows.filter((r) => Number(r.annonce) !== Number(r.present)).map((r) => ({ id: /^\d+$/.test(String(r.id)) ? Number(r.id) : r.id, annonce: Number(r.annonce), present: Number(r.present) }));
    } catch (e) {
      if ((e as { code?: string })?.code === '25006') throw e;
      item.erreur = describe(e);
      push(kit.issues, c.section, `contrôle ${c.code} non exécuté : ${item.erreur}`);
    }
    const manques = item.ecarts.filter((r) => Number(r.annonce) > Number(r.present));
    if (c.strict && manques.length) push(kit.issues, c.section, `${c.label} : ${manques.length} écart(s) — lignes détaillées absentes (controle/compteurs-annonces.json)`);
  }
  const ecartsStricts = announced.filter((a) => a.strict).reduce((n, a) => n + a.ecarts.filter((r) => Number(r.annonce) > Number(r.present)).length, 0);
  const ecartsInformatifs = announced.reduce((n, a) => n + a.ecarts.length, 0) - ecartsStricts;
  kit.entry('controle/compteurs-annonces.json', 'Compteurs annoncés (rapports, passages, extractions) vs lignes détaillées présentes : chaque écart listé', async (w) => {
    await w(`${JSON.stringify(announced, null, 2)}\n`);
    return { expected: announced.length, count: announced.length, batches: 1, error: null };
  }, undefined, 'controle');

  // ── 4. Couverture et exclusions ─────────────────────────────────────────
  const colonnesExclues = toDump.flatMap((x) => (meta.get(x.table)?.excluded ?? []).map((e) => ({ table: x.table, colonne: e.colonne, motif: e.motif })));
  kit.entry('couverture/tables.json', 'Couverture : chaque table de la base — section et filtre de compte, ou exclusion motivée ; colonnes exclues par table ; tables non classées', async (w) => {
    await w(`${JSON.stringify({
      regle: 'Toute table est couverte (section) ou exclue avec motif — registre src/services/admin/diagnostics-export/coverage.ts, vérifié par les tests de non-régression (Drizzle et base réelle).',
      couvertes: toDump.map((x) => ({ table: x.table, section: x.c.section, filtre: filterOf.get(x.table), globale: !!x.c.global, nonClassee: !!x.unclassified, colonnesExclues: meta.get(x.table)?.excluded ?? [], clePrimaire: meta.get(x.table)?.pk ?? [] })),
      exclues: cls.excluded,
      nonClassees: cls.unclassified,
      declareesAbsentes: cls.missing,
    }, null, 2)}\n`);
    return { expected: tables.length, count: toDump.filter((x) => !x.unclassified).length + cls.excluded.length + cls.unclassified.length, batches: 1, error: null };
  }, undefined, 'controle');

  // ── 5. Versions, migrations, configuration IA, indicateurs ──────────────
  kit.entry('technique/versions.json', 'Versions applicatives, migrations appliquées, configuration IA par empreinte (sans texte de prompt ni clé), indicateurs de fonctionnement', async (w) => {
    const errors: string[] = [];
    const safe = async (what: string, fn: () => Promise<unknown>) => { try { return await s.savepoint(fn as () => Promise<unknown>); } catch (e) { if ((e as { code?: string })?.code === '25006') throw e; errors.push(`${what} : ${describe(e)}`); return null; } };
    const build = getBuildIdentity();
    const v = {
      application: { version: build.version, commit: build.commit, commitSource: build.commitSource, conteneur: build.container, environnement: (process.env.NEXT_PUBLIC_APP_ENV || process.env.NODE_ENV || 'inconnu').trim(), node: process.version },
      migrations: await safe('migrations', async () => (await s.q(`SELECT count(*)::int AS appliquees, max(filename) AS derniere, max(applied_at) AS derniere_application FROM _migrations`))[0] ?? null),
      configurationIA: await safe('configuration IA', async () => s.q(`SELECT v.id, v.uid, v.environment, v.status, v.visible_number, v.current_revision_number, r.snapshot_sha256 AS empreinte_revision, v.activated_at
          FROM ai_config_versions v LEFT JOIN ai_config_revisions r ON r.id = v.current_revision_id
         WHERE v.status = 'ACTIVE' OR v.id IN (SELECT DISTINCT config_version_id FROM ai_job_queue WHERE account_id = $1) OR v.id IN (SELECT DISTINCT config_version_id FROM ai_usage_event WHERE account_id = $1)
         ORDER BY v.id`, [A])),
      promptsMaitres: await safe('prompts maîtres', async () => s.q(`SELECT environment, treatment, master_prompt_code, version_number, status, content_sha256, input_contract_version, output_contract_version, activated_at
          FROM ai_master_prompt_versions WHERE status = 'ACTIVE' OR (master_prompt_code, version_number::text) IN (SELECT DISTINCT master_prompt_code, master_prompt_version FROM ai_usage_event WHERE account_id = $1 AND master_prompt_code IS NOT NULL)
         ORDER BY treatment, master_prompt_code, version_number`, [A])),
      indicateursCompte: await safe('indicateurs du compte', async () => (await s.q(`SELECT plan_type, subscription_tier, subscription_status, feature_flags, is_active FROM accounts WHERE id = $1`, [A]))[0] ?? null),
      variablesDeFonctionnement: runtimeFlags(),
      erreurs: errors,
    };
    await w(`${JSON.stringify(kit.M(v), null, 2)}\n`);
    return { expected: null, batches: 1, error: errors.length ? errors.join(' ; ') : null };
  }, undefined, 'technique');

  // ── 6. Traçabilité des propriétés et projection API → écran ─────────────
  const { planPropertyFiles } = await import('./properties');
  await planPropertyFiles(kit);

  kit.limitations.set('api-ui', ['Projection API → écran : fiche du bien (onglet « Informations », GET /api/assets/[id]/details, même fonction buildSections) ; équipements et autres écrans : valeurs persistées et chaîne de traçabilité, sans projection d’écran.']);
  kit.limitations.set('extractions-ia', ['Sorties brutes du modèle et prompts : longueur et SHA-256 (contenu restreint) ; lisibles par le diagnostic renforcé (accès réservé et journalisé). Les sorties STRUCTURÉES persistées (faits, extractions, candidats, décisions) sont exportées intégralement.']);
  kit.limitations.set('documents', ['Fichiers originaux, nom d’origine et emplacement de stockage : jamais exportés (sécurité) ; texte intégral : longueur et SHA-256.']);
  kit.limitations.set('technique', ['Journal d’administration BO (admin_audit_log) exclu : pas de rattachement fiable au compte (voir couverture/tables.json).']);

  const part: AccountManifestPart = {
    couverture: { tablesEnBase: tables.length, couvertes: cls.covered.length, exclues: cls.excluded.length, nonClassees: cls.unclassified, declareesAbsentes: cls.missing },
    exclusionsVolontaires: {
      notes: DIAG_SECURITY_NOTES,
      tables: cls.excluded.map((x) => ({ table: x.table, categorie: x.category, motif: x.motif })),
      colonnes: colonnesExclues,
    },
    autoControle: {
      references: refTotals,
      compteursAnnonces: { controles: announced.reduce((n, a) => n + a.controles, 0), ecartsStricts, ecartsInformatifs },
      conclusion: refTotals.absentes || ecartsStricts || cls.unclassified.length || declaredInvalid.length
        ? `Manques constatés : ${refTotals.absentes} référence(s) absente(s), ${ecartsStricts} compteur(s) annoncé(s) non détaillé(s), ${cls.unclassified.length} table(s) non classée(s), ${declaredInvalid.length} référence(s) déclarée(s) invalide(s) — sections concernées PARTIAL.`
        : 'Aucun manque constaté : toutes les références sont résolues (ou ajoutées par fermeture, ou hors compte attendues), chaque compteur strict est détaillé, chaque table est classée.',
    },
  };
  return part;
}

/**
 * Variables de fonctionnement (indicateurs) : noms à motif d'indicateur,
 * jamais un nom évoquant un secret ou un point d'accès ; valeur exportée
 * seulement si elle est courte et sans caractère d'URL.
 */
export function runtimeFlags(env: Record<string, string | undefined> = process.env): Array<{ nom: string; valeur: string }> {
  const SECRET_NAME = /(KEY|SECRET|TOKEN|PASS|CREDENTIAL|DSN|URL|URI|HOST|USER|PRIVATE|SALT|WEBHOOK|COOKIE|AUTH|BUCKET|ENDPOINT|EMAIL|PHONE|ACCOUNT_ID|IDS$)/i;
  const FLAG_NAME = /^(FEATURE_|ENABLE_|DISABLE_|AI_|T[1-6]_|COHERENCE_|CAPTURE_|EXPORT_|DIAG_)|(_ENABLED|_DISABLED|_MODE|_MAX|_MIN|_STRATEGY|_LEVEL|_DAYS|_HOURS)$|^(NODE_ENV|NEXT_PUBLIC_APP_ENV|APP_VERSION)$/;
  const out: Array<{ nom: string; valeur: string }> = [];
  for (const nom of Object.keys(env).sort()) {
    if (!FLAG_NAME.test(nom) || SECRET_NAME.test(nom)) continue;
    const v = String(env[nom] ?? '');
    out.push({ nom, valeur: /^[A-Za-z0-9_.,:-]{0,40}$/.test(v) && !/:\/\//.test(v) ? v : '(présente — valeur non exportée)' });
  }
  return out;
}
