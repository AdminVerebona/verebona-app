/**
 * Lot 91A — RÈGLE AUTOMATIQUE « filtré ⊆ global » (ticket P1, § Auto-contrôle) :
 * toute information disponible dans un diagnostic FILTRÉ (Compte,
 * Utilisateur, Bien, Document, Opération) doit aussi être présente dans
 * « Ensemble de l'application ». PUR : comparaison de deux archives déjà
 * lues (chemin → contenu), utilisée par l'e2e L91A et les tests unitaires.
 *
 * Chaque fichier de l'archive filtrée est rangé dans une famille connue :
 *   · lignes de table (`donnees/<section>/<table>[.part-NNNN].json`,
 *     `donnees/fermeture/<table>.json`) : chaque ligne existe dans le global
 *     (même clé primaire) avec des valeurs identiques pour chacune de ses
 *     colonnes (une colonne d'isolation omise au filtré n'est pas une
 *     différence) ;
 *   · traçabilité (propriétés, fiches API, montants, TCO, identité
 *     économique, chronologie) : chaque entrée existe à l'identique ;
 *   · versions et contrôles : éléments inclus ;
 *   · fichiers de l'archive elle-même (manifeste, rapport, guide,
 *     couverture, références) : présents dans le global ;
 *   · annexe à accès restreint du diagnostic renforcé (`ia/sorties-modele.json`) :
 *     hors règle (restriction d'accès aux sorties IA, déclarée).
 * Un fichier d'une famille INCONNUE est une violation : tout nouveau fichier
 * du diagnostic doit être rangé ici (non-régression).
 */

type Json = unknown;
type Row = Record<string, Json>;

/** JSON canonique (clés triées) : comparaison profonde stable. */
export function canonical(v: Json): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as Row).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Row)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

const TABLE_FILE = /^donnees\/([a-z-]+)\/([a-z0-9_]+)(?:\.part-\d{4})?\.json$/;
const PART = /\.part-\d{4}(?=\.json$)/;
const META_FILES = new Set(['manifeste.json', 'rapport.txt', 'LISEZMOI-ANALYSE.md', 'controle/references.json', 'couverture/tables.json']);
const RESTRICTED_ANNEX = new Set(['ia/sorties-modele.json']);

const parse = (s: string | undefined): Json => (s === undefined ? undefined : JSON.parse(s));
/** Contenu d'un fichier logique (toutes ses parties concaténées pour une liste). */
function logical(files: Record<string, string>, path: string): Json[] | Json | undefined {
  const base = path.replace(PART, '');
  const parts = Object.keys(files).filter((p) => p.replace(PART, '') === base).sort();
  if (!parts.length) return undefined;
  const values = parts.map((p) => parse(files[p]));
  return values.every(Array.isArray) ? (values as Json[][]).flat() : values[0];
}

/** Lignes de chaque table (toutes sections, parties et fermeture). */
function tableRows(files: Record<string, string>): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  for (const [p, c] of Object.entries(files)) {
    const m = TABLE_FILE.exec(p);
    if (!m) continue;
    const t = m[2];
    if (!out.has(t)) out.set(t, []);
    for (const r of (JSON.parse(c) as Row[])) out.get(t)!.push(r);
  }
  return out;
}

function primaryKeys(files: Record<string, string>): Map<string, string[]> {
  const c = parse(files['couverture/tables.json']) as { couvertes?: Array<{ table: string; clePrimaire: string[] }> } | undefined;
  return new Map((c?.couvertes ?? []).map((x) => [x.table, x.clePrimaire ?? []]));
}

const keyed = (items: Json[], key: (x: Row) => string): Map<string, Row> => new Map((items as Row[]).map((x) => [key(x), x]));

/** Violations de la règle « filtré ⊆ global » (vide : règle respectée). */
export function filteredIncludedInGlobal(filtered: Record<string, string>, global: Record<string, string>): string[] {
  const v: string[] = [];
  const seen = new Set<string>();
  const gRows = tableRows(global);
  const pk = primaryKeys(global);
  const gIndex = new Map<string, Map<string, Row> | Set<string>>();
  const indexOf = (t: string) => {
    if (gIndex.has(t)) return gIndex.get(t)!;
    const keys = pk.get(t) ?? [];
    const rows = gRows.get(t) ?? [];
    const idx = keys.length ? new Map(rows.map((r) => [canonical(keys.map((k) => r[k])), r])) : new Set(rows.map((r) => canonical(r)));
    gIndex.set(t, idx);
    return idx;
  };

  // 1. Lignes de table.
  for (const [t, rows] of tableRows(filtered)) {
    if (!gRows.has(t)) { v.push(`table ${t} : présente au filtré, absente du global`); continue; }
    const keys = pk.get(t) ?? [];
    const idx = indexOf(t);
    let reported = 0;
    for (const r of rows) {
      let ok = true;
      let why = '';
      if (keys.length) {
        const g = (idx as Map<string, Row>).get(canonical(keys.map((k) => r[k])));
        if (!g) { ok = false; why = 'ligne absente du global'; } else {
          for (const [c, val] of Object.entries(r)) if (canonical(val) !== canonical(g[c])) { ok = false; why = `colonne ${c} différente`; break; }
        }
      } else if (!(idx as Set<string>).has(canonical(r))) { ok = false; why = 'ligne (sans clé primaire) absente du global'; }
      if (!ok && reported++ < 5) v.push(`table ${t} › ${keys.length ? keys.map((k) => `${k}=${String(r[k])}`).join(',') : 'ligne'} : ${why}`);
    }
  }

  // 2. Autres fichiers, par famille.
  const entries = (path: string, key: (x: Row) => string) => {
    const f = logical(filtered, path);
    const g = logical(global, path);
    if (g === undefined) { v.push(`${path} : absent du global`); return; }
    const gi = keyed(g as Json[], key);
    for (const x of (f as Json[]) ?? []) {
      const k = key(x as Row);
      const y = gi.get(k);
      if (!y) v.push(`${path} › ${k} : entrée absente du global`);
      else if (canonical(x) !== canonical(y)) v.push(`${path} › ${k} : entrée différente du global`);
    }
  };
  for (const path of Object.keys(filtered).sort()) {
    const base = path.replace(PART, '');
    if (seen.has(base)) continue;
    seen.add(base);
    if (TABLE_FILE.test(path) || RESTRICTED_ANNEX.has(base)) continue;
    if (META_FILES.has(base)) { if (!(base in global)) v.push(`${base} : absent du global`); continue; }
    switch (base) {
      case 'tracabilite/proprietes.json': entries(base, (x) => `${x.bien}|${x.cible}|${x.champ}`); break;
      case 'api-ui/fiches.json': entries(base, (x) => String(x.bien)); break;
      case 'tracabilite/montants.json': entries(base, (x) => `${x.assetId}|${(x.ligne as Row)?.id}`); break;
      case 'tracabilite/tco.json': entries(base, (x) => String(x.assetId)); break;
      case 'technique/chronologie.json': entries(base, (x) => `${x.table}|${x.id}|${x.type}`); break;
      case 'api-ui/correspondance-champs.json':
        if (canonical(parse(filtered[base])) !== canonical(parse(global[base]))) v.push(`${base} : différent du global`);
        break;
      case 'tracabilite/identite-economique.json': {
        const f = parse(filtered[base]) as Record<string, Json[]>;
        const g = parse(global[base]) as Record<string, Json[]> | undefined;
        if (!g) { v.push(`${base} : absent du global`); break; }
        for (const [k, items] of Object.entries(f)) {
          const set = new Set((g[k] ?? []).map(canonical));
          for (const x of items ?? []) if (!set.has(canonical(x))) v.push(`${base} › ${k} : élément absent du global (${canonical(x).slice(0, 120)})`);
        }
        break;
      }
      case 'technique/versions.json': {
        const f = parse(filtered[base]) as Row;
        const g = parse(global[base]) as Row | undefined;
        if (!g) { v.push(`${base} : absent du global`); break; }
        for (const k of ['application', 'migrations', 'variablesDeFonctionnement']) if (canonical(f[k]) !== canonical(g[k])) v.push(`${base} › ${k} : différent du global`);
        for (const k of ['configurationIA', 'promptsMaitres']) {
          const set = new Set(((g[k] as Json[]) ?? []).map(canonical));
          for (const x of (f[k] as Json[]) ?? []) if (!set.has(canonical(x))) v.push(`${base} › ${k} : élément absent du global`);
        }
        break;
      }
      case 'controle/compteurs-annonces.json': {
        const f = parse(filtered[base]) as Array<{ code: string; ecarts: Row[] }>;
        const g = parse(global[base]) as Array<{ code: string; ecarts: Row[] }> | undefined;
        if (!g) { v.push(`${base} : absent du global`); break; }
        for (const c of f) {
          const set = new Set((g.find((x) => x.code === c.code)?.ecarts ?? []).map(canonical));
          for (const e of c.ecarts) if (!set.has(canonical(e))) v.push(`${base} › ${c.code} : écart ${canonical(e)} absent du global`);
        }
        break;
      }
      case 'controle/comptes.json': {
        const f = parse(filtered[base]) as { comptes: Array<{ compte: number }> };
        const g = parse(global[base]) as { comptes: Array<{ compte: number }> } | undefined;
        if (!g) { v.push(`${base} : absent du global`); break; }
        const set = new Set(g.comptes.map((x) => x.compte));
        for (const c of f.comptes) if (!set.has(c.compte)) v.push(`${base} › compte ${c.compte} : absent du global`);
        break;
      }
      default:
        v.push(`${base} : fichier d’une famille inconnue de la règle « filtré ⊆ global » (à ranger dans inclusion.ts)`);
    }
  }
  return v;
}
