/**
 * Lot 91A — MOTEUR UNIQUE DU DIAGNOSTIC (correction du P1 « Rendre le
 * diagnostic global exhaustif et auto-suffisant », lot 88A). Serveur
 * uniquement.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN DIAGNOSTIC, UN MOTEUR, DES FILTRES
 *
 * L'exhaustivité du lot 88A (`planAccountDiagnostic`, réservée au périmètre
 * « Un compte ») devient LE moteur, paramétré par un filtre (`DiagFilter`) :
 *
 *   · « Ensemble de l'application » (aucun filtre) : TOUTES les lignes de
 *     TOUTES les tables couvertes — tables de compte de TOUS les comptes,
 *     tables transversales (journaux multi-comptes, configuration IA par
 *     empreinte, référentiels, catalogue), tables non classées — sans
 *     filtre ; niveau maximal, jamais une section NOT_APPLICABLE ;
 *   · « Compte » / « Utilisateur » : les mêmes tables filtrées sur le(s)
 *     compte(s) (registre `coverage.ts`) ; tables transversales hors filtre
 *     (isolation), déclarées ;
 *   · « Bien » / « Document » / « Opération » : filtre plus fin, GÉNÉRIQUE —
 *     une ligne est retenue si elle désigne un objet du filtre par une clé
 *     (clé étrangère du catalogue ou référence logique déclarée), ou si elle
 *     est l'enfant direct d'une telle ligne ; puis FERMETURE TRANSITIVE
 *     (points fixes) : toute ligne du même compte citée par une ligne
 *     exportée est ajoutée (`donnees/fermeture/`).
 *
 * Un diagnostic filtré ne peut donc contenir AUCUNE ligne, aucun fichier,
 * aucune entrée de traçabilité absents du global : mêmes requêtes, mêmes
 * fonctions de calcul, moins de lignes. Règle vérifiée automatiquement
 * (`inclusion.ts`, e2e L91A).
 *
 * VOLUME : lecture par curseur (lots), fichiers `…part-NNNN.json` au-delà de
 * `DIAG_LIMITS.partRows` lignes, lignes triées par compte puis clé primaire
 * (partitionnement par compte : les lignes d'un compte sont contiguës),
 * attendu = décompte par compte dans le même instantané — jamais de LIMIT
 * silencieux.
 *
 * AUTO-CONTRÔLE (COMPLETE seulement si) : toutes les tables couvertes ou
 * exclues avec motif ; tous les comptes couverts (`controle/comptes.json`) ;
 * attendus = exportés ; références résolues (`controle/references.json`) ;
 * compteurs annoncés détaillés (`controle/compteurs-annonces.json`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { named, type ReadSession } from '@/services/admin/account-data/session';
import { getBuildIdentity } from '@/lib/runtime-identity';
import { RESTORE_AUDIT_ACTION, RESTORE_AUDIT_TARGET } from '@/services/business-operations/identity-restore.model';
import { RECETTE_TABLES } from './recette-catalog';
import type { DiagFileInfo, DiagScope, DiagUnavailable } from './model';
import {
  DIAG_ANNOUNCED_COUNTS, DIAG_ENTITY_TABLES, DIAG_LOGICAL_REFERENCES, DIAG_SECTIONS, DIAG_SECTION_ORDER, DIAG_TABLE_COVERAGE, DIAG_TABLE_EXCLUSIONS,
  accountPredicate, classifyDiagTables, coverageFilter, isExternalReferenceColumn, type DiagSectionCode, type DiagTableCoverage,
} from './coverage';
import { DIAG_SECURITY_NOTES, excludedColumnMotif } from './security';
import { maskDiagRow } from './account-model';

type Row = Record<string, unknown>;
type EntryBody = (w: (c: string) => Promise<void>) => Promise<{ expected: number | null; count?: number; batches: number; error: string | null; status?: DiagFileInfo['status'] }>;
type ListOpts = { onlyIfRows?: boolean; serialize?: (r: Row) => string; section?: DiagSectionCode; values?: Record<string, unknown>; expected?: number };
type ObjectPart = { value: () => Promise<unknown> } | { list: string; transform?: (r: Row) => Row };

/** Filtre du moteur unique (résolu par `collect.ts`). */
export interface DiagFilter {
  scope: DiagScope;
  /** Comptes retenus ; null : TOUS (Ensemble de l'application). */
  accounts: number[] | null;
  /**
   * Filtre fin (Bien / Document / Opération) : objets FOCUS (les lignes qui
   * les désignent sont retenues) et biens de CONTEXTE (TCO et traçabilité
   * des propriétés des biens concernés).
   */
  entity: { assets: number[]; files: number[]; operations: number[]; equipments: number[]; contextAssets: number[] } | null;
  userId: number | null;
  label: string;
}

/** Outils du plan (collect.ts) prêtés au moteur. */
export interface DiagPlanKit {
  s: ReadSession;
  /** Paramètres nommés communs (`accounts`, `userId`, `eAssetsT`…). */
  V: Record<string, unknown>;
  isSensitiveKey: (k: string) => boolean;
  M: (v: unknown) => unknown;
  safeJson: (v: unknown) => string;
  entry: (path: string, description: string, body: EntryBody, part?: DiagFileInfo['part'], section?: DiagSectionCode) => void;
  list: (path: string, description: string, text: string, transform?: (r: Row) => Row, opt?: ListOpts) => Promise<number>;
  object: (path: string, description: string, parts: Record<string, ObjectPart>, countKey?: string, section?: DiagSectionCode) => Promise<void>;
  issues: Map<DiagSectionCode, string[]>;
  filters: Map<DiagSectionCode, string[]>;
  limitations: Map<DiagSectionCode, string[]>;
  warnings: string[];
  unavailable: DiagUnavailable[];
  today?: string;
}

/** Ce que le moteur ajoute au manifeste. */
export interface EngineManifestPart {
  couverture: {
    tablesEnBase: number; couvertes: number; exclues: number; exportees: number; nonClassees: string[]; declareesAbsentes: string[];
    /** Tables couvertes non exportées par CE filtre (motif) — toujours vide au global. */
    horsFiltre: Array<{ table: string; motif: string }>;
    comptes: { attendus: number; couverts: number; supprimesCites: number; lignesSansCompte: number };
  };
  exclusionsVolontaires: {
    notes: readonly string[];
    tables: Array<{ table: string; categorie: string; motif: string }>;
    colonnes: Array<{ table: string; colonne: string; motif: string }>;
  };
  autoControle: {
    references: { verifiees: number; valeurs: number; resolues: number; fermeture: number; externes: number; versTableExclue: number; horsPerimetre: number; absentes: number; clesMultiColonnes: number; declareesInvalides: string[]; tours: number };
    compteursAnnonces: { controles: number; ecartsStricts: number; ecartsInformatifs: number };
    comptes: { attendus: number; couverts: number; erreurs: number };
    conclusion: string;
  };
  /** Requête (paramètres nommés) des biens du filtre : TCO et traçabilité des propriétés. */
  assetsSql: string | null;
  /** Filtre SQL (alias `t`, paramètres nommés) de chaque table exportée par ce diagnostic. */
  tableFilters: Readonly<Record<string, string>>;
}

const ident = (t: string) => `"${t.replace(/"/g, '""')}"`;
const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => { if (!m.has(k)) m.set(k, []); m.get(k)!.push(v); };
const describe = (e: unknown): string => `${(e as { code?: string })?.code ? `${(e as { code?: string }).code} — ` : ''}${(e as Error)?.message ?? String(e)}`.slice(0, 500);
const isReadOnlyViolation = (e: unknown) => (e as { code?: string })?.code === '25006';

interface TableMeta { columns: string[]; pk: string[]; excluded: Array<{ colonne: string; motif: string }> }

async function readTables(s: ReadSession): Promise<string[]> {
  return (await s.q(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)).map((r) => String(r.t));
}

async function readMeta(s: ReadSession, tables: string[], global: boolean): Promise<Map<string, TableMeta>> {
  const meta = new Map<string, TableMeta>(tables.map((t) => [t, { columns: [], pk: [], excluded: [] }]));
  for (const r of await s.q(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1::text[]) ORDER BY table_name, ordinal_position`, [tables])) {
    const m = meta.get(String(r.table_name));
    if (!m) continue;
    const col = String(r.column_name);
    const x = excludedColumnMotif(String(r.table_name), col, { global });
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

/** Requête d'export d'une table (colonnes autorisées, filtre, tri stable : `order` puis clé primaire). */
export function tableSql(table: string, m: TableMeta, filter: string, order: string[] = []): string {
  const cols = m.columns.length ? m.columns.map((c) => `t.${ident(c)}`).join(', ') : 'NULL AS aucune_colonne_exportable';
  const keys = [...order, ...m.pk.map((c) => `t.${ident(c)}`)];
  const by = keys.length ? keys.join(', ') : 'row_to_json(t)::text';
  return `SELECT ${cols} FROM ${ident(table)} t WHERE (${filter}) ORDER BY ${by}`;
}

export interface RefSpec {
  from: string; column: string; to: string; toColumn: string; kind: 'value' | 'json-array' | 'pg-array'; when?: string; role: string; origin: 'FK' | 'LOGIQUE';
}

interface RefResult extends RefSpec {
  valeurs: number; resolues: number; fermeture: string[]; externes: number; versTableExclue: number; horsPerimetre: number; absentes: string[];
  motif?: string; erreur?: string;
}

/** Valeurs référencées par la colonne (texte), selon le type de référence. */
function refValueExpr(r: RefSpec): string {
  const c = `t.${ident(r.column)}`;
  if (r.kind === 'json-array') return `jsonb_array_elements_text(CASE WHEN jsonb_typeof(to_jsonb(${c})) = 'array' THEN to_jsonb(${c}) ELSE '[]'::jsonb END)`;
  if (r.kind === 'pg-array') return `unnest(${c})::text`;
  return `${c}::text`;
}

/**
 * Prédicat PUR « la ligne (alias `t`) désigne une valeur du jeu » pour une
 * référence : `mem(v)` rend l'appartenance d'une valeur texte (`= ANY(…)` ou
 * `IN (sous-requête)`). Tableaux JSON / PostgreSQL : au moins un élément.
 */
export function refMatch(r: Pick<RefSpec, 'column' | 'kind' | 'when'>, mem: (v: string) => string): string {
  const c = `t.${ident(r.column)}`;
  const when = r.when ? `(${r.when}) AND ` : '';
  if (r.kind === 'json-array') return `(${when}EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(to_jsonb(${c})) = 'array' THEN to_jsonb(${c}) ELSE '[]'::jsonb END) x(v) WHERE ${mem('x.v')}))`;
  if (r.kind === 'pg-array') return `(${when}EXISTS (SELECT 1 FROM unnest(${c}) x(v) WHERE ${mem('x.v::text')}))`;
  return `(${when}${mem(`${c}::text`)})`;
}

/** Paramètre nommé du jeu d'identifiants (texte) d'une table d'objets ciblables. */
const ENTITY_PARAM: Readonly<Record<'assets' | 'files' | 'operations' | 'equipments', string>> = {
  assets: 'eAssetsT', files: 'eFilesT', operations: 'eOpsT', equipments: 'eEquipT',
};

/**
 * Clés étrangères du catalogue. Une clé COMPOSITE d'isolation (colonne +
 * `account_id` → id + `account_id`, motif courant de Verebona) est ramenée à
 * sa colonne métier ; les autres clés multi-colonnes sont comptées (non
 * vérifiées, déclarées).
 */
async function readForeignKeys(s: ReadSession): Promise<{ refs: RefSpec[]; multi: number }> {
  const rows = await s.q(`
    SELECT c.oid AS k, fc.relname AS from_table, a.attname AS from_col, tc.relname AS to_table, af.attname AS to_col
      FROM pg_constraint c
      JOIN pg_class fc ON fc.oid = c.conrelid JOIN pg_namespace fn ON fn.oid = fc.relnamespace AND fn.nspname = 'public'
      JOIN pg_class tc ON tc.oid = c.confrelid
      CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS x(fa, ta, ord)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = x.fa
      JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = x.ta
     WHERE c.contype = 'f' ORDER BY 2, 1, x.ord`);
  const byKey = new Map<string, Row[]>();
  for (const r of rows) push(byKey, String(r.k), r);
  const refs: RefSpec[] = [];
  let multi = 0;
  for (const cols of byKey.values()) {
    const business = cols.filter((r) => !(String(r.from_col) === 'account_id' && String(r.to_col) === 'account_id'));
    if (business.length !== 1) { if (business.length > 1) multi++; continue; }
    const r = business[0];
    refs.push({ from: String(r.from_table), column: String(r.from_col), to: String(r.to_table), toColumn: String(r.to_col), kind: 'value', role: cols.length > 1 ? 'clé étrangère (composite d’isolation par compte)' : 'clé étrangère', origin: 'FK' });
  }
  return { refs, multi };
}

/** Tours maximaux de la fermeture transitive (au-delà : manque DÉCLARÉ, jamais silencieux). */
const CLOSURE_MAX_ROUNDS = 8;

/**
 * Plan du moteur unique : fichiers des tables, fermeture, contrôles,
 * traçabilité. Rend la part du manifeste (couverture, exclusions,
 * auto-contrôle) — complétée au fil de la production.
 */
export async function planDiagnosticEngine(kit: DiagPlanKit, f: DiagFilter): Promise<EngineManifestPart> {
  const { s } = kit;
  const global = f.accounts === null;
  const entity = f.entity;
  const filterLabel = global ? 'Ensemble de l’application' : f.label;
  /** Requête à paramètres nommés (`{{accounts}}`, `{{eAssetsT}}`…, extras). */
  const qn = (text: string, extra: Record<string, unknown> = {}) => { const c = named(text, { ...kit.V, ...extra }); return s.q(c.sql, c.params); };
  const accSql = (sql: string) => accountPredicate(sql, global ? 'all' : 'param');

  const tables = await readTables(s);
  const present = new Set(tables);
  const cls = classifyDiagTables(tables);
  const accountCols = new Set((await s.q(`SELECT table_name AS t FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'account_id'`)).map((r) => String(r.t)));
  const meta = await readMeta(s, tables, global);
  const covOf = (t: string): DiagTableCoverage | null => DIAG_TABLE_COVERAGE[t] ?? (cls.unclassified.includes(t) ? { section: 'non-classees' } : null);

  for (const t of cls.unclassified) {
    if (global || accountCols.has(t)) push(kit.issues, 'non-classees', `table ${t} absente du registre de couverture : exportée par prudence${global ? '' : ' (filtre account_id)'}, à classer (coverage.ts)`);
    else push(kit.issues, 'non-classees', `table ${t} absente du registre de couverture et sans account_id : NON exportée par ce filtre (exportée par « Ensemble de l’application »), à classer (coverage.ts)`);
  }
  for (const t of cls.missing) kit.warnings.push(`couverture : table déclarée ${t} absente de la base (migration non appliquée ou table retirée).`);

  // ── Références (clés étrangères + références logiques), validées ────────
  const fk = await readForeignKeys(s);
  const declaredInvalid: string[] = [];
  const colsOf = (t: string) => new Set([...(meta.get(t)?.columns ?? []), ...(meta.get(t)?.excluded.map((x) => x.colonne) ?? [])]);
  const specs: RefSpec[] = [];
  const seen = new Set<string>();
  for (const r of [...DIAG_LOGICAL_REFERENCES.map((l): RefSpec => ({ from: l.from, column: l.column, to: l.to, toColumn: l.toColumn ?? 'id', kind: l.kind ?? 'value', when: l.when, role: l.role, origin: 'LOGIQUE' })), ...fk.refs]) {
    const key = `${r.from}.${r.column}->${r.to}.${r.toColumn}|${r.when ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!present.has(r.from) || !covOf(r.from)) continue;
    if (r.origin === 'LOGIQUE') {
      if (!colsOf(r.from).has(r.column)) { declaredInvalid.push(`${r.from}.${r.column} (table ou colonne absente)`); continue; }
      if (present.has(r.to) && !colsOf(r.to).has(r.toColumn)) { declaredInvalid.push(`${r.to}.${r.toColumn} (colonne cible absente)`); continue; }
    }
    if (meta.get(r.from)?.excluded.some((e) => e.colonne === r.column)) continue; // colonne de sécurité : non exportée
    specs.push(r);
  }
  const specsFrom = new Map<string, RefSpec[]>();
  for (const r of specs) push(specsFrom, r.from, r);

  // ── Filtre de chaque table ──────────────────────────────────────────────
  /** Filtre de compte (sans le filtre fin) ; null : table hors de ce filtre. */
  const baseFilter = (t: string): string | null => {
    const c = covOf(t);
    if (!c) return null;
    if (global) return 'TRUE';
    if (c.section === 'non-classees') return accountCols.has(t) ? 't.account_id = ANY({{accounts}}::int[])' : null;
    if (c.transversal) return null;
    let x = accSql(coverageFilter(c));
    if (t === 'users' && f.userId) x = `(${x}) OR t.id = {{userId}}::int`;
    return x;
  };
  /** Filtre fin direct : la ligne EST un objet du filtre ou le désigne par une clé. */
  const directPreds = (t: string): string[] => {
    if (!entity) return [];
    const out: string[] = [];
    const self = DIAG_ENTITY_TABLES[t];
    if (self) out.push(`t.id::text = ANY({{${ENTITY_PARAM[self]}}}::text[])`);
    for (const r of specsFrom.get(t) ?? []) {
      const e = DIAG_ENTITY_TABLES[r.to];
      if (e && r.toColumn === 'id' && !(self && r.to === t)) out.push(refMatch(r, (v) => `${v} = ANY({{${ENTITY_PARAM[e]}}}::text[])`));
    }
    return out;
  };
  const horsFiltre: Array<{ table: string; motif: string }> = [];
  const filterOf = new Map<string, string>();
  const candidates = [...cls.covered.map((x) => x.table), ...cls.unclassified];
  for (const t of candidates) {
    const base = baseFilter(t);
    const c = covOf(t)!;
    if (base === null) {
      horsFiltre.push({ table: t, motif: c.transversal ? `table transversale (${c.transversal}) : exportée intégralement par « Ensemble de l’application » ; hors des diagnostics filtrés (isolation des comptes)` : 'table non classée sans account_id : exportée par « Ensemble de l’application »' });
      continue;
    }
    // Filtre fin : référentiels entiers ; le compte de l'objet (contexte) toujours exporté.
    if (!entity || c.global || t === 'accounts') { filterOf.set(t, base); continue; }
    const preds = directPreds(t);
    // Enfants directs d'une ligne retenue par le filtre fin (un niveau : pas de fermeture vers le compte entier).
    for (const r of specsFrom.get(t) ?? []) {
      if (r.to === t || DIAG_ENTITY_TABLES[r.to]) continue;
      const pBase = baseFilter(r.to);
      const pDirect = directPreds(r.to);
      if (pBase === null || !pDirect.length || covOf(r.to)?.global) continue;
      preds.push(refMatch(r, (v) => `${v} IN (SELECT t.${ident(r.toColumn)}::text FROM ${ident(r.to)} t WHERE (${pBase}) AND (${pDirect.join(' OR ')}))`));
    }
    if (!preds.length) { horsFiltre.push({ table: t, motif: `aucun lien direct avec l’objet du filtre « ${filterLabel} » : lignes citées ajoutées par la fermeture transitive (donnees/fermeture/)` }); continue; }
    filterOf.set(t, `(${base}) AND (${preds.join(' OR ')})`);
  }
  const sectionOfTable = (t: string): DiagSectionCode => covOf(t)?.section ?? 'controle';
  const ser = (t: string) => (r: Row) => kit.safeJson(maskDiagRow(r, { isSensitiveKey: kit.isSensitiveKey, table: t }));

  kit.filters.set('etat-metier', [global
    ? 'Ensemble de l’application : toutes les lignes de chaque table, tous les comptes, sans filtre de période ni plafond.'
    : `${filterLabel} : lignes des tables du filtre, sans filtre de période ni plafond ; lignes citées hors filtre ajoutées par fermeture transitive.`]);
  for (const code of DIAG_SECTION_ORDER) if (!kit.filters.has(code)) kit.filters.set(code, [global ? 'Ensemble de l’application : toutes les lignes, tous les comptes, sans filtre de période ni plafond.' : `${filterLabel} : même moteur, lignes du filtre.`]);
  kit.filters.set('referentiels', ['Tables globales (référentiels, configuration IA par empreinte, catalogue) : toutes les lignes ; colonnes de texte de prompt remplacées par leur empreinte.']);

  // ── 1. Tables (ordre : sections, puis nom) ; attendu = décompte par compte ─
  const accountTotals = new Map<number | null, { lignes: number; tables: number }>();
  const comptesErreurs: string[] = [];
  const order = (t: string) => DIAG_SECTION_ORDER.indexOf(sectionOfTable(t));
  for (const t of [...filterOf.keys()].sort((a, b) => order(a) - order(b) || a.localeCompare(b))) {
    const m = meta.get(t)!;
    const filter = filterOf.get(t)!;
    const c = covOf(t)!;
    const byAccount = accountCols.has(t) && !c.global && m.columns.includes('account_id');
    let expected: number | undefined;
    if (byAccount) {
      try {
        const rows = await s.savepoint(() => qn(`SELECT t.account_id AS a, count(*)::bigint AS n FROM ${ident(t)} t WHERE (${filter}) GROUP BY 1`));
        expected = 0;
        for (const r of rows) {
          const a = r.a === null || r.a === undefined ? null : Number(r.a);
          const n = Number(r.n ?? 0);
          expected += n;
          const cur = accountTotals.get(a) ?? { lignes: 0, tables: 0 };
          cur.lignes += n; cur.tables += 1;
          accountTotals.set(a, cur);
        }
      } catch (e) {
        if (isReadOnlyViolation(e)) throw e;
        comptesErreurs.push(`${t} : ${describe(e)}`);
        expected = undefined;
      }
    }
    const desc = `${t} — ${RECETTE_TABLES[t]?.description ?? DIAG_SECTIONS[c.section].label}${c.global ? ' (table globale)' : c.transversal ? ' (table transversale)' : ''}${global ? '' : ` — filtre : ${filter.replace(/\s+/g, ' ').slice(0, 300)}`}`;
    await kit.list(`donnees/${c.section}/${t}.json`, desc, tableSql(t, m, filter, byAccount ? ['t."account_id"'] : []), undefined, { serialize: ser(t), section: c.section, ...(expected !== undefined ? { expected } : {}) });
  }

  // ── 2. Références et fermeture transitive (points fixes, même instantané) ─
  /** Lignes hors filtre direct qu'une ligne exportée peut faire entrer (null : aucune). */
  const allowedFilter = (t: string): string | null => {
    const c = covOf(t);
    if (!c || global) return null;
    if (c.global) return 'TRUE';
    if (entity) return baseFilter(t);
    return null;
  };
  const results = new Map<string, RefResult>();
  const closure = new Map<string, Map<string, Set<string>>>();
  let paramN = 0;
  /** Filtre « ligne dont `col` vaut l'une des valeurs » (OR sur les colonnes), paramètres nommés frais. */
  const valuesFilter = (cols: Map<string, Set<string>>): { sql: string; values: Record<string, unknown> } => {
    const values: Record<string, unknown> = {};
    const parts = [...cols.entries()].filter(([, v]) => v.size).map(([col, v]) => {
      const p = `fv${++paramN}`;
      values[p] = [...v].sort();
      return `t.${ident(col)}::text = ANY({{${p}}}::text[])`;
    });
    return { sql: parts.length ? parts.join(' OR ') : 'FALSE', values };
  };
  let frontier: Map<string, Map<string, Set<string>>> | null = null;
  let rounds = 0;
  for (; rounds < CLOSURE_MAX_ROUNDS; rounds++) {
    const sources: Array<{ table: string; filter: string; values: Record<string, unknown> }> = frontier === null
      ? [...filterOf.entries()].map(([table, filter]) => ({ table, filter, values: {} }))
      : [...frontier.entries()].map(([table, cols]) => { const v = valuesFilter(cols); return { table, filter: v.sql, values: v.values }; });
    const next = new Map<string, Map<string, Set<string>>>();
    for (const src of sources) {
      for (const r of specsFrom.get(src.table) ?? []) {
        const key = `${r.from}.${r.column}->${r.to}.${r.toColumn}|${r.when ?? ''}`;
        if (!results.has(key)) results.set(key, { ...r, valeurs: 0, resolues: 0, fermeture: [], externes: 0, versTableExclue: 0, horsPerimetre: 0, absentes: [] });
        const out = results.get(key)!;
        const srcSql = `SELECT DISTINCT ${refValueExpr(r)} AS v FROM ${ident(r.from)} t WHERE (${src.filter})${r.when ? ` AND (${r.when})` : ''}`;
        try {
          const main = filterOf.get(r.to) ?? null;
          const allowed = allowedFilter(r.to);
          if (!present.has(r.to)) {
            const n = await s.savepoint(() => qn(`SELECT count(*)::int AS n FROM (${srcSql}) x WHERE v IS NOT NULL`, src.values));
            const k = Number(n[0]?.n ?? 0);
            out.valeurs += k;
            if (k && !out.absentes.includes('(table cible absente de la base)')) out.absentes.push('(table cible absente de la base)');
            out.motif = 'table cible absente';
            continue;
          }
          if (main === null && allowed === null) {
            const n = await s.savepoint(() => qn(`SELECT count(*)::int AS n FROM (${srcSql}) x WHERE v IS NOT NULL`, src.values));
            const k = Number(n[0]?.n ?? 0);
            out.valeurs += k;
            const tc = covOf(r.to);
            if (tc?.transversal) { out.horsPerimetre += k; out.motif = `table cible transversale : exportée par « Ensemble de l’application » (${tc.transversal})`; }
            else { out.versTableExclue += k; out.motif = `table cible exclue : ${DIAG_TABLE_EXCLUSIONS[r.to]?.motif ?? 'non classée sans account_id'}`; }
            continue;
          }
          const col = `t.${ident(r.toColumn)}::text`;
          // Semi-jointures par hachage (texte) : seules les valeurs NON résolues remontent (mémoire bornée par les manques).
          const sql = `WITH s AS (SELECT v FROM (${srcSql}) x WHERE v IS NOT NULL),
                 e AS (SELECT DISTINCT ${col} AS k FROM ${ident(r.to)} t WHERE (${main ?? 'FALSE'}) AND ${col} IN (SELECT v FROM s))
                 ${allowed ? `, g AS (SELECT DISTINCT ${col} AS k FROM ${ident(r.to)} t WHERE (${allowed}) AND ${col} IN (SELECT v FROM s))` : ''}
            SELECT count(*)::int AS valeurs, count(e.k)::int AS resolues,
                   coalesce(array_agg(s.v ORDER BY s.v) FILTER (WHERE e.k IS NULL ${allowed ? 'AND g.k IS NOT NULL' : 'AND false'}), '{}') AS existantes,
                   coalesce(array_agg(s.v ORDER BY s.v) FILTER (WHERE e.k IS NULL ${allowed ? 'AND g.k IS NULL' : ''}), '{}') AS manquantes
              FROM s LEFT JOIN e ON e.k = s.v ${allowed ? 'LEFT JOIN g ON g.k = s.v' : ''}`;
          const [agg] = await s.savepoint(() => qn(sql, src.values));
          const toCov = covOf(r.to);
          const external = isExternalReferenceColumn(r.from, r.column) ?? toCov?.externalRefs ?? null;
          out.valeurs += Number(agg?.valeurs ?? 0);
          out.resolues += Number(agg?.resolues ?? 0);
          const existantes = ((agg?.existantes ?? []) as unknown[]).map(String);
          const manquantes = ((agg?.manquantes ?? []) as unknown[]).map(String);
          for (const v of existantes) {
            if (!out.fermeture.includes(v)) out.fermeture.push(v);
            const have = closure.get(r.to)?.get(r.toColumn);
            if (have?.has(v)) continue;
            if (!closure.has(r.to)) closure.set(r.to, new Map());
            if (!closure.get(r.to)!.has(r.toColumn)) closure.get(r.to)!.set(r.toColumn, new Set());
            closure.get(r.to)!.get(r.toColumn)!.add(v);
            if (!next.has(r.to)) next.set(r.to, new Map());
            if (!next.get(r.to)!.has(r.toColumn)) next.get(r.to)!.set(r.toColumn, new Set());
            next.get(r.to)!.get(r.toColumn)!.add(v);
          }
          if (external) { out.externes += manquantes.length; if (manquantes.length) out.motif = `hors filtre attendu : ${external}`; }
          else for (const v of manquantes) if (!out.absentes.includes(v)) out.absentes.push(v);
        } catch (e) {
          if (isReadOnlyViolation(e)) throw e;
          out.erreur = describe(e);
          push(kit.issues, sectionOfTable(r.from), `référence ${r.from}.${r.column} → ${r.to} non vérifiée : ${out.erreur}`);
        }
      }
    }
    frontier = next;
    if (!next.size) { rounds++; break; }
  }
  if (frontier && frontier.size) {
    push(kit.issues, 'controle', `fermeture transitive non terminée après ${CLOSURE_MAX_ROUNDS} tours : ${[...frontier.keys()].join(', ')} — lignes citées au-delà non vérifiées`);
  }
  for (const r of results.values()) {
    if (r.absentes.length) push(kit.issues, sectionOfTable(r.from), `${r.absentes.length} référence(s) ${r.from}.${r.column} → ${r.to}.${r.toColumn} absente(s) de l’archive (ligne supprimée ou hors filtre) — détail : controle/references.json`);
  }

  // Fichiers de fermeture : lignes hors filtre direct citées par une ligne exportée (section de la table).
  for (const [to, cols] of [...closure.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const m = meta.get(to)!;
    const v = valuesFilter(cols);
    const n = [...cols.values()].reduce((k, x) => k + x.size, 0);
    await kit.list(`donnees/fermeture/${to}.json`, `${to} — lignes hors filtre direct citées par une ligne exportée (fermeture transitive : ${n} identifiant(s))`,
      tableSql(to, m, v.sql), undefined, { serialize: ser(to), section: sectionOfTable(to), values: v.values });
  }

  const resultList = [...results.values()];
  const refTotals = {
    verifiees: resultList.length,
    valeurs: resultList.reduce((n, r) => n + r.valeurs, 0),
    resolues: resultList.reduce((n, r) => n + r.resolues, 0),
    fermeture: resultList.reduce((n, r) => n + r.fermeture.length, 0),
    externes: resultList.reduce((n, r) => n + r.externes, 0),
    versTableExclue: resultList.reduce((n, r) => n + r.versTableExclue, 0),
    horsPerimetre: resultList.reduce((n, r) => n + r.horsPerimetre, 0),
    absentes: resultList.reduce((n, r) => n + r.absentes.length, 0),
    clesMultiColonnes: fk.multi,
    declareesInvalides: declaredInvalid,
    tours: rounds,
  };
  for (const d of declaredInvalid) kit.warnings.push(`référence logique déclarée invalide : ${d} (coverage.ts).`);
  kit.entry('controle/references.json', 'Fermeture transitive : chaque référence (clés étrangères + références logiques déclarées) partant d’une ligne exportée — résolues, ajoutées hors filtre direct, hors filtre attendues, vers table exclue ou transversale, ABSENTES (valeurs listées intégralement)', async (w) => {
    await w(`${JSON.stringify({ totaux: refTotals, references: resultList.map((r) => ({ ...r, fermeture: r.fermeture.length, valeursFermeture: r.fermeture })) }, null, 2)}\n`);
    return { expected: resultList.length, count: resultList.length, batches: 1, error: null };
  }, undefined, 'controle');

  // ── 3. Compteurs annoncés vs lignes détaillées ──────────────────────────
  const announced: Array<{ code: string; label: string; strict: boolean; section: DiagSectionCode; controles: number; ecarts: Row[]; erreur?: string }> = [];
  for (const c of DIAG_ANNOUNCED_COUNTS) {
    const item: (typeof announced)[number] = { code: c.code, label: c.label, strict: c.strict, section: c.section, controles: 0, ecarts: [] };
    announced.push(item);
    const tf = filterOf.get(c.table);
    if (!tf) continue;
    try {
      const rows = await s.savepoint(() => qn(`SELECT * FROM (${accSql(c.sql)}) x WHERE x.id::text IN (SELECT t.id::text FROM ${ident(c.table)} t WHERE (${tf})) ORDER BY x.id`));
      item.controles = rows.length;
      item.ecarts = rows.filter((r) => Number(r.annonce) !== Number(r.present)).map((r) => ({ id: /^\d+$/.test(String(r.id)) ? Number(r.id) : r.id, annonce: Number(r.annonce), present: Number(r.present) }));
    } catch (e) {
      if (isReadOnlyViolation(e)) throw e;
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

  // ── 4. Comptes couverts ─────────────────────────────────────────────────
  let accountsInScope: number[] = [];
  const accountsFilter = filterOf.get('accounts');
  if (accountsFilter) {
    try { accountsInScope = (await s.savepoint(() => qn(`SELECT t.id FROM accounts t WHERE (${accountsFilter}) ORDER BY t.id`))).map((r) => Number(r.id)); } catch (e) {
      if (isReadOnlyViolation(e)) throw e;
      comptesErreurs.push(`accounts : ${describe(e)}`);
    }
  }
  const inScope = new Set(accountsInScope);
  const supprimes = [...accountTotals.entries()].filter(([a]) => a !== null && !inScope.has(a)).sort(([a], [b]) => Number(a) - Number(b));
  const sansCompte = accountTotals.get(null)?.lignes ?? 0;
  for (const e of comptesErreurs) push(kit.issues, 'controle', `décompte par compte impossible — ${e}`);
  kit.entry('controle/comptes.json', 'Comptes couverts : chaque compte du filtre et ses lignes exportées (tables portant account_id, décompte dans l’instantané) ; lignes rattachées à un compte supprimé (identifiant conservé) ou sans compte', async (w) => {
    await w(`${JSON.stringify({
      regle: 'Chaque compte du filtre est exporté (donnees/etat-metier/accounts.json) avec toutes ses lignes ; attendu de chaque table = somme des décomptes par compte (même instantané). Les lignes d’un compte supprimé restent exportées (identifiant seul conservé).',
      filtre: filterLabel,
      comptes: accountsInScope.map((id) => ({ compte: id, lignes: accountTotals.get(id)?.lignes ?? 0, tables: accountTotals.get(id)?.tables ?? 0 })),
      comptesSupprimesCites: supprimes.map(([id, x]) => ({ compte: id, lignes: x.lignes, tables: x.tables })),
      lignesSansCompte: sansCompte,
      erreurs: comptesErreurs,
    }, null, 2)}\n`);
    return { expected: accountsInScope.length, count: accountsInScope.length, batches: 1, error: comptesErreurs.length ? comptesErreurs.join(' ; ') : null };
  }, undefined, 'controle');

  // ── 5. Couverture et exclusions ─────────────────────────────────────────
  const dumped = [...filterOf.keys()];
  const colonnesExclues = dumped.flatMap((t) => (meta.get(t)?.excluded ?? []).map((e) => ({ table: t, colonne: e.colonne, motif: e.motif })));
  kit.entry('couverture/tables.json', 'Couverture : chaque table de la base — section et filtre, ou exclusion motivée ; colonnes exclues par table ; tables hors de ce filtre (motif) ; tables non classées', async (w) => {
    await w(`${JSON.stringify({
      regle: 'Toute table est couverte (section) ou exclue avec motif (sécurité, contenu personnel) — registre src/services/admin/diagnostics-export/coverage.ts, vérifié par les tests de non-régression (Drizzle et base réelle). « Ensemble de l’application » exporte toutes les tables couvertes ; un filtre n’exporte qu’une partie de leurs lignes.',
      filtre: filterLabel,
      couvertes: dumped.map((t) => ({ table: t, section: sectionOfTable(t), filtre: filterOf.get(t), globale: !!covOf(t)?.global, transversale: !!covOf(t)?.transversal, nonClassee: cls.unclassified.includes(t), colonnesExclues: meta.get(t)?.excluded ?? [], clePrimaire: meta.get(t)?.pk ?? [] })),
      horsFiltre,
      exclues: cls.excluded,
      nonClassees: cls.unclassified,
      declareesAbsentes: cls.missing,
    }, null, 2)}\n`);
    return { expected: tables.length, count: dumped.length + horsFiltre.length + cls.excluded.length, batches: 1, error: null };
  }, undefined, 'controle');

  // ── 6. Versions, base, migrations, configuration IA, indicateurs ────────
  kit.entry('technique/versions.json', 'Versions applicatives, base de données, migrations appliquées, configuration IA et prompts maîtres par empreinte (sans texte de prompt ni clé), variables de fonctionnement', async (w) => {
    const errors: string[] = [];
    const safe = async (what: string, fn: () => Promise<unknown>) => { try { return await s.savepoint(fn as () => Promise<unknown>); } catch (e) { if (isReadOnlyViolation(e)) throw e; errors.push(`${what} : ${describe(e)}`); return null; } };
    const build = getBuildIdentity();
    const v = {
      application: { version: build.version, commit: build.commit, commitSource: build.commitSource, conteneur: build.container, environnement: (process.env.NEXT_PUBLIC_APP_ENV || process.env.NODE_ENV || 'inconnu').trim(), node: process.version },
      baseDeDonnees: await safe('base', async () => { const [db] = await s.q(`SELECT current_setting('server_version') AS version`); return { version: db?.version ?? null, instantane: s.info.at }; }),
      migrations: await safe('migrations', async () => (await s.q(`SELECT count(*)::int AS appliquees, max(filename) AS derniere, max(applied_at) AS derniere_application FROM _migrations`))[0] ?? null),
      configurationIA: await safe('configuration IA', async () => qn(`SELECT v.id, v.uid, v.environment, v.status, v.visible_number, v.current_revision_number, r.snapshot_sha256 AS empreinte_revision, v.activated_at
          FROM ai_config_versions v LEFT JOIN ai_config_revisions r ON r.id = v.current_revision_id
         WHERE ${global ? 'TRUE' : `v.status = 'ACTIVE' OR v.id IN (SELECT DISTINCT j.config_version_id FROM ai_job_queue j WHERE j.account_id = ANY({{accounts}}::int[]))
            OR v.id IN (SELECT DISTINCT u.config_version_id FROM ai_usage_event u WHERE u.account_id = ANY({{accounts}}::int[]))`}
         ORDER BY v.id`)),
      promptsMaitres: await safe('prompts maîtres', async () => qn(`SELECT environment, treatment, master_prompt_code, version_number, status, content_sha256, input_contract_version, output_contract_version, activated_at
          FROM ai_master_prompt_versions WHERE ${global ? 'TRUE' : `status = 'ACTIVE' OR (master_prompt_code, version_number::text) IN (SELECT DISTINCT master_prompt_code, master_prompt_version FROM ai_usage_event WHERE account_id = ANY({{accounts}}::int[]) AND master_prompt_code IS NOT NULL)`}
         ORDER BY treatment, master_prompt_code, version_number`)),
      variablesDeFonctionnement: runtimeFlags(),
      erreurs: errors,
    };
    await w(`${JSON.stringify(kit.M(v), null, 2)}\n`);
    return { expected: null, batches: 1, error: errors.length ? errors.join(' ; ') : null };
  }, undefined, 'technique');

  // ── 7. Chronologie corrélée (mêmes lignes que les tables, ordonnées) ────
  const tl: string[] = [];
  const F = (t: string) => filterOf.get(t);
  if (F('admin_anomalies')) tl.push(`SELECT t.last_seen_at AS h, 1 AS k, t.id::bigint AS i, json_build_object('horodatage', t.last_seen_at, 'type', 'ANOMALIE', 'table', 'admin_anomalies', 'id', t.id, 'statut', t.status, 'compte', t.account_id, 'libelle', t.title) AS ev FROM admin_anomalies t WHERE (${F('admin_anomalies')})`);
  if (F('ai_job_queue')) {
    tl.push(`SELECT t.created_at, 2, t.id::bigint, json_build_object('horodatage', t.created_at, 'type', 'JOB_' || t.treatment || '_CREE', 'table', 'ai_job_queue', 'id', t.id, 'statut', t.status, 'compte', t.account_id,
            'correlation', json_build_object('job', t.id, 'execution', t.execution_id, 'correlationId', t.payload -> 'events' -> -1 ->> 'correlationId', 'cible', t.target_type || ':' || t.target_id)) FROM ai_job_queue t WHERE (${F('ai_job_queue')})`);
    tl.push(`SELECT t.finished_at, 3, t.id::bigint, json_build_object('horodatage', t.finished_at, 'type', 'JOB_' || t.treatment || '_TERMINE', 'table', 'ai_job_queue', 'id', t.id, 'statut', t.status, 'resultat', t.business_result,
            'erreur', t.last_error, 'correlation', json_build_object('job', t.id)) FROM ai_job_queue t WHERE (${F('ai_job_queue')}) AND t.finished_at IS NOT NULL`);
  }
  if (F('ai_execution_reports')) tl.push(`SELECT t.created_at, 4, t.id::bigint, json_build_object('horodatage', t.created_at, 'type', 'RAPPORT_' || t.treatment, 'table', 'ai_execution_reports', 'id', t.id, 'statut', t.status,
            'correlation', json_build_object('job', t.job_id, 'traces', t.trace_ids, 'document', t.file_id, 'bien', t.asset_id, 'rapportT1Origine', t.origin_t1_report_id)) FROM ai_execution_reports t WHERE (${F('ai_execution_reports')})`);
  if (F('ai_usage_event')) tl.push(`SELECT t.created_at, 5, t.id::bigint, json_build_object('horodatage', t.created_at, 'type', 'APPEL_IA', 'table', 'ai_usage_event', 'id', t.id, 'statut', t.status, 'modele', t.model,
            'correlation', json_build_object('job', t.job_id, 'trace', t.metadata->>'traceId', 'document', t.asset_file_id)) FROM ai_usage_event t WHERE (${F('ai_usage_event')})`);
  if (F('ai_operation')) tl.push(`SELECT t.started_at, 6, t.id::bigint, json_build_object('horodatage', t.started_at, 'type', 'OPERATION_IA', 'table', 'ai_operation', 'id', t.id, 'statut', t.business_result,
            'correlation', json_build_object('document', t.asset_file_id)) FROM ai_operation t WHERE (${F('ai_operation')})`);
  if (F('business_operation_history')) tl.push(`SELECT t.created_at, 7, t.id::bigint, json_build_object('horodatage', t.created_at, 'type', 'OPERATION_' || t.event_type, 'table', 'business_operation_history', 'id', t.id, 'motif', t.reason_code,
            'correlation', json_build_object('operation', t.operation_id, 'source', t.source_id, 'correlationId', t.correlation_id)) FROM business_operation_history t WHERE (${F('business_operation_history')})`);
  if (tl.length) {
    await kit.list('technique/chronologie.json', 'Chronologie corrélée (anomalies, traitements, rapports, appels IA, opérations IA, historique des rapprochements) : horodatage, table, identifiant, corrélations job / trace / document / Opération',
      `SELECT x.ev FROM (${tl.join('\n UNION ALL ')}) x(h, k, i, ev) WHERE x.h IS NOT NULL ORDER BY x.h, x.k, x.i`, (r) => (r.ev ?? r) as Row, { section: 'technique' });
  }

  // ── 8. Identité économique (vue d'analyse dérivée des mêmes lignes) ─────
  if (F('business_operations') || F('document_operation_candidates')) {
    const parts: Record<string, ObjectPart> = {};
    const journal = F('business_operation_identity_reviews') ? `SELECT t.id, t.operation_id, t.target_operation_id, t.kind, t.status, t.file_id, t.candidate_key, t.source_id, t.basis, t.signals, t.against_source_ids,
             t.review_version, t.correlation_id, t.resolved_by_admin_id, t.created_at, t.updated_at, t.resolved_at
        FROM business_operation_identity_reviews t WHERE (${F('business_operation_identity_reviews')}) ORDER BY t.id DESC` : null;
    parts.journal = journal ? { list: journal } : { value: async () => [] };
    parts.provenance = F('business_operations') ? { list: `SELECT t.id AS operation_id, t.type_code, t.provider, t.technical_label, t.planned_date, t.start_date, t.realized_date, t.end_date,
             to_jsonb(t) -> 'attribute_provenance' AS provenance
        FROM business_operations t WHERE (${F('business_operations')}) ORDER BY t.id` } : { value: async () => [] };
    parts.sources = F('business_operation_sources') ? { list: `SELECT t.id, t.operation_id, t.source_kind, t.source_entity_key, t.locator->>'candidateKey' AS candidate_key, t.source_role, t.authority, t.confidence,
             t.match_method, t.match_reason, t.active, t.superseded_at, t.created_at,
             CASE WHEN t.match_method = 'M3' THEN 'IA' WHEN t.match_method = 'M0' THEN 'UTILISATEUR' WHEN t.match_method IN ('M1', 'M2') THEN 'DETERMINISTE'
                  WHEN t.match_method IS NULL AND t.source_kind = 'DOCUMENT' THEN 'CREATION' ELSE 'AUTRE' END AS nature_decision,
             (SELECT h.reason_code FROM business_operation_history h WHERE h.source_id = t.id AND h.event_type = 'SOURCE_REMOVED' ORDER BY h.id DESC LIMIT 1) AS motif_retrait
        FROM business_operation_sources t WHERE (${F('business_operation_sources')}) ORDER BY t.operation_id, t.id` } : { value: async () => [] };
    parts.candidats = F('document_operation_candidates') ? { list: `SELECT t.id, t.file_id, t.candidate_key, t.extraction_id, t.analysis_run_id, t.status, t.established, t.confidence, t.type_hint, t.status_hint,
             t.payload->'origin' AS origine_t1, t.payload->'evidenceFactIds' AS faits_preuve, t.payload->'adjustments' AS corrections_barriere,
             t.t3_outcome, t.t3_reason, t.t3_operation_id, t.t3_detail->'matchMethod' AS methode, t.t3_detail->'certain' AS certains,
             t.t3_detail->'identity' AS controles_identite, t.t3_detail->'excluded' AS exclus, t.t3_detail->'plausible' AS plausibles,
             t.t3_detail->'m3' AS verdict_ia, t.t3_detail->>'identityReview' AS version_controle, t.t3_processed_at, t.created_at, t.superseded_at
        FROM document_operation_candidates t WHERE (${F('document_operation_candidates')}) ORDER BY t.file_id, t.id DESC` } : { value: async () => [] };
    // Lot 79A : rétablissements BO des séparations (journal d'audit admin) — administrateur (identifiant), motif, avant / après.
    parts.retablissements = journal && present.has('admin_audit_log') ? {
      list: `SELECT id, "timestamp" AS horodatage, admin_user_id, target_id AS separation_id, result AS resultat, details, old_value AS avant, new_value AS apres
        FROM admin_audit_log
       WHERE action_type = '${RESTORE_AUDIT_ACTION}' AND target_type = '${RESTORE_AUDIT_TARGET}' AND target_id IN (SELECT jr.id FROM (${journal}) jr)
       ORDER BY id DESC`,
      transform: ({ details, ...x }) => {
        let d: Record<string, unknown> = {};
        try { d = typeof details === 'string' ? JSON.parse(details) as Record<string, unknown> : (details && typeof details === 'object' ? details as Record<string, unknown> : {}); } catch { d = {}; }
        return { ...x, motif: d.reason ?? null, code: d.code ?? null, operation_affichee: d.viewedOperationId ?? d.operationId ?? null };
      },
    } : { value: async () => [] };
    await kit.object('tracabilite/identite-economique.json',
      'Identité économique (lot 78A) : candidats T1 (origine, faits, décision T3, contrôles d’identité, nature déterministe / IA), sources rattachées et dernier motif de retrait, provenance des valeurs, journal des séparations / doutes / doublons, rétablissements BO (administrateur, motif, avant / après)',
      parts, undefined, 'conflits-arbitrages');
  }

  // ── 9. Traçabilité des propriétés et projection API → écran ─────────────
  // Biens dont on trace TCO et propriétés : ceux du filtre (global, compte) ou les biens de CONTEXTE de l'objet.
  const assetsFilter = entity ? `(${baseFilter('assets') ?? 'FALSE'}) AND t.id = ANY({{ctxAssets}}::int[])` : F('assets');
  const assetsSql = assetsFilter ? `SELECT t.id, t.account_id FROM assets t WHERE (${assetsFilter}) ORDER BY t.id` : null;
  const { planPropertyFiles } = await import('./properties');
  await planPropertyFiles(kit, assetsSql);

  kit.limitations.set('api-ui', ['Projection API → écran : fiche du bien (onglet « Informations », GET /api/assets/[id]/details, même fonction buildSections) ; équipements et autres écrans : valeurs persistées et chaîne de traçabilité, sans projection d’écran.']);
  kit.limitations.set('extractions-ia', ['Sorties brutes du modèle et prompts : longueur et SHA-256 (contenu restreint) ; lisibles par le diagnostic renforcé (accès réservé et journalisé). Les sorties STRUCTURÉES persistées (faits, extractions, candidats, décisions) sont exportées intégralement.']);
  kit.limitations.set('documents', ['Fichiers originaux, nom d’origine et emplacement de stockage : jamais exportés (sécurité) ; texte intégral : longueur et SHA-256.']);

  const comptesCouverts = accountsInScope.length;
  const part: EngineManifestPart = {
    couverture: {
      tablesEnBase: tables.length, couvertes: cls.covered.length, exclues: cls.excluded.length, exportees: dumped.length, nonClassees: cls.unclassified, declareesAbsentes: cls.missing, horsFiltre,
      comptes: { attendus: accountsInScope.length, couverts: comptesErreurs.length ? 0 : comptesCouverts, supprimesCites: supprimes.length, lignesSansCompte: sansCompte },
    },
    exclusionsVolontaires: {
      notes: DIAG_SECURITY_NOTES,
      tables: cls.excluded.map((x) => ({ table: x.table, categorie: x.category, motif: x.motif })),
      colonnes: colonnesExclues,
    },
    autoControle: {
      references: refTotals,
      compteursAnnonces: { controles: announced.reduce((n, a) => n + a.controles, 0), ecartsStricts, ecartsInformatifs },
      comptes: { attendus: accountsInScope.length, couverts: comptesErreurs.length ? 0 : comptesCouverts, erreurs: comptesErreurs.length },
      conclusion: refTotals.absentes || ecartsStricts || cls.unclassified.length || declaredInvalid.length || comptesErreurs.length
        ? `Manques constatés : ${refTotals.absentes} référence(s) absente(s), ${ecartsStricts} compteur(s) annoncé(s) non détaillé(s), ${cls.unclassified.length} table(s) non classée(s), ${declaredInvalid.length} référence(s) déclarée(s) invalide(s), ${comptesErreurs.length} décompte(s) par compte en erreur — sections concernées PARTIAL.`
        : `Aucun manque constaté : ${comptesCouverts} compte(s) couvert(s), toutes les références résolues (ou ajoutées par fermeture, ou hors filtre attendues), chaque compteur strict détaillé, chaque table classée.`,
    },
    assetsSql,
    tableFilters: Object.fromEntries(filterOf),
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
