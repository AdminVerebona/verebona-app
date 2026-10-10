/**
 * Normalisation DÉTERMINISTE d'une sortie modèle, pilotée par le schéma —
 * lot 33D (ticket « réussite malgré les désalignements », §2 à §5, étape 4 de
 * la résolution progressive).
 *
 * Même règle pour tous les traitements et tous les modèles (§22) : le schéma
 * attendu dit, à chaque chemin, ce qui est accepté ; la normalisation ne
 * transforme une valeur que si la transformation est EXPLICITE, SANS
 * AMBIGUÏTÉ et NE CRÉE AUCUNE DONNÉE :
 *
 *   règle                     exemple
 *   ────────────────────────  ─────────────────────────────────────────────
 *   envelope_unwrapped        `{"result": {…}}` → `{…}` (aucune clé connue)
 *   single_element_unwrapped  `[{…}]` → `{…}` (objet attendu)
 *   null_as_absent            `"supplier": null` → absent (champ facultatif)
 *   null_to_empty_array       `"facts": null` → `[]` (liste non nullable)
 *   empty_array_to_null       `[]` → `null` (scalaire nullable)
 *   date_object_to_iso        `{day:24,month:4,year:2026}` → `"2026-04-24"`
 *   date_to_iso               `"24/04/2026"` → `"2026-04-24"` (date ISO attendue)
 *   numeric_string            `"1250"` → `1250`
 *   number_to_string          `1250` → `"1250"` (chaîne attendue)
 *   boolean_string            `"true"` / `"oui"` → `true`
 *   enum_case                 `invoice` → `INVOICE` (casse seule, même valeur)
 *   single_value_to_array     `"x"` → `["x"]` (liste attendue)
 *   discriminant_imposed      `task` absent → TASK imposée par le serveur
 *
 * Lot 34D (contrat runtime source unique) : plus AUCUN rapprochement de noms
 * de champs (`purchase_date` n'est plus `purchaseDate`) ni de valeurs
 * d'énumération par ressemblance. Les équivalences EXPLICITES de la table de
 * compatibilité (`enum_synonym` : `PURCHASE_RECEIPT` → `RECEIPT`) ne sont
 * appliquées qu'en mode `compat` — étape « mappings de compatibilité », après
 * un premier échec de validation — et consignées `compat_mapping`.
 *
 * Toute transformation est consignée (`OutputRepairStep`) : rien n'est
 * appliqué silencieusement. Travaille sur une COPIE.
 */
import type { ZodType } from 'zod';
import type { OutputRepairStep } from '../diagnostics/taxonomy';
import { describe, resolveUnion, type FieldDesc, type ShapeNode } from './schema-introspect';
import { matchEnum } from './normalization-tables';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function pathOf(path: ReadonlyArray<string | number>): string {
  return '$' + path.map((s) => (typeof s === 'number' ? '[*]' : `.${s}`)).join('');
}

const pad = (n: number) => String(n).padStart(2, '0');

function jourValide(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 1800 || y > 2200 || m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d{1,4}$/.test(v.trim())) return Number(v.trim());
  return null;
};

/** `{day, month, year}` (ou jour/mois/annee, d/m/y) → ISO, si la date existe. */
export function dateObjectToIso(v: unknown): string | null {
  if (!isObj(v)) return null;
  const keys = Object.keys(v);
  if (keys.length < 3 || keys.length > 4) return null;
  const pick = (...names: string[]) => {
    for (const n of names) if (n in v) return num(v[n]);
    return null;
  };
  const y = pick('year', 'annee', 'année', 'y', 'yyyy');
  const m = pick('month', 'mois', 'm', 'mm');
  const d = pick('day', 'jour', 'd', 'dd');
  if (y === null || m === null || d === null) return null;
  return jourValide(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null;
}

/** Date textuelle non ambiguë → ISO : `JJ/MM/AAAA`, `JJ.MM.AAAA`, `AAAA/MM/JJ`, ISO avec heure. */
export function textDateToIso(v: string): string | null {
  const s = v.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
  if (m) return jourValide(+m[1], +m[2], +m[3]) ? `${m[1]}-${m[2]}-${m[3]}` : null;
  m = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(s);
  if (m) return jourValide(+m[1], +m[2], +m[3]) ? `${m[1]}-${pad(+m[2])}-${pad(+m[3])}` : null;
  // Ordre français (jour, mois, année) : seul ordre employé par les sources de Verebona.
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return jourValide(+m[3], +m[2], +m[1]) ? `${m[3]}-${pad(+m[2])}-${pad(+m[1])}` : null;
  return null;
}

/** Nombre écrit en chaîne, sans ambiguïté de séparateur. */
export function numericString(v: string): number | null {
  const s = v.trim().replace(/ /g, ' ');
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  // Virgule décimale française, jamais 3 chiffres après (1,250 : millier ou décimale ?).
  const fr = /^(-?\d+),(\d{1,2}|\d{4,})$/.exec(s);
  if (fr) return Number(`${fr[1]}.${fr[2]}`);
  return null;
}

const VRAI = new Set(['true', 'oui', 'yes', 'vrai']);
const FAUX = new Set(['false', 'non', 'no', 'faux']);

export interface NormalizeOptions {
  /** Discriminant imposé par le serveur (`task` / `mode`) et sa valeur. */
  discriminant?: { field: string; value: string };
  /**
   * Lot 34D — étape « mappings de compatibilité » : les équivalences
   * EXPLICITES d'énumération (`ENUM_SYNONYMS`) sont appliquées, consignées
   * `compat_mapping`. Absent : normalisation sûre seulement.
   */
  compat?: boolean;
}

/**
 * Normalise `value` vers le schéma. Rend la valeur normalisée (copie) et
 * ajoute chaque transformation à `report`.
 */
export function normalizeToSchema(value: unknown, schema: ZodType, report: OutputRepairStep[], options: NormalizeOptions = {}): unknown {
  const root = describe(schema);
  let v = structuredCloneSafe(value);
  // Discriminant imposé : absent → valeur de la branche demandée.
  if (options.discriminant && isObj(v)) {
    const { field, value: attendu } = options.discriminant;
    const recu = v[field];
    if (recu === undefined || recu === null) {
      v[field] = attendu;
      report.push({ stage: 'normalization', rule: 'discriminant_imposed', path: `$.${field}` });
    } else if (typeof recu === 'string' && recu !== attendu) {
      // Même branche écrite autrement (`analyze_document`) : jamais une autre branche.
      const m = matchEnum(recu, [attendu]);
      if (m?.rule === 'enum_case') {
        v[field] = attendu;
        report.push({ stage: 'normalization', rule: 'enum_case', path: `$.${field}`, detail: `${recu} → ${attendu}` });
      }
    }
  }
  v = walk(v, root, [], report, true, options.compat === true);
  return v;
}

function structuredCloneSafe<T>(v: T): T {
  try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v)) as T; }
}

const ENVELOPES = new Set(['result', 'results', 'data', 'output', 'response', 'json', 'answer', 'analysis', 'resultat', 'résultat', 'sortie']);

function walk(value: unknown, desc: FieldDesc, path: Array<string | number>, report: OutputRepairStep[], isRoot = false, compat = false): unknown {
  const at = pathOf(path);
  const note = (rule: string, detail?: string) => report.push({ stage: 'normalization', rule, path: at, ...(detail ? { detail } : {}) });
  const d = resolveUnion(desc, value);
  const n: ShapeNode = d.node;

  // Scalaire nullable reçu sous forme de liste vide.
  if (Array.isArray(value) && value.length === 0 && d.nullable && n.kind !== 'array') {
    note('empty_array_to_null');
    return null;
  }

  switch (n.kind) {
    case 'object': {
      let v = value;
      // Objet attendu, tableau d'un seul objet reçu.
      if (Array.isArray(v) && v.length === 1 && isObj(v[0])) { v = v[0]; note('single_element_unwrapped'); }
      if (!isObj(v)) return v;
      const known = Object.keys(n.shape);
      // Enveloppe : aucune clé connue, une seule clé portant un objet.
      if (known.length > 0 && !Object.keys(v).some((k) => known.includes(k))) {
        const keys = Object.keys(v);
        if (keys.length === 1 && (ENVELOPES.has(keys[0].toLowerCase()) || isRoot) && isObj(v[keys[0]])) {
          note('envelope_unwrapped', `${keys[0]}`);
          return walk(v[keys[0]], desc, path, report, isRoot, compat);
        }
      }
      const out: Obj = { ...v };
      // Lot 34D : aucun renommage de champ ici (ni casse, ni alias) — un nom
      // inconnu reste tel quel ; la validation le signale (champ non déclaré).
      for (const k of known) {
        if (!(k in out)) continue;
        const f = n.shape[k];
        const child = out[k];
        if (child === null && !f.nullable) {
          if (f.optional) {
            delete out[k];
            report.push({ stage: 'normalization', rule: 'null_as_absent', path: pathOf([...path, k]) });
            continue;
          }
          const fn = resolveUnion(f, child).node;
          if (fn.kind === 'array') {
            out[k] = [];
            report.push({ stage: 'normalization', rule: 'null_to_empty_array', path: pathOf([...path, k]) });
            continue;
          }
        }
        out[k] = walk(child, f, [...path, k], report, false, compat);
      }
      return out;
    }
    case 'array': {
      let v = value;
      if (v === null || v === undefined) return v;
      if (!Array.isArray(v)) {
        const el = resolveUnion(n.element, v).node;
        // Valeur unique là où une liste est attendue (compatible avec l'élément).
        if (el.kind !== 'array' && compatibleScalar(el, v)) { v = [v]; note('single_value_to_array'); } else return v;
      }
      return (v as unknown[]).map((x, i) => walk(x, n.element, [...path, i], report, false, compat));
    }
    case 'string': {
      if (typeof value === 'string') {
        if (n.isoDate && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
          const iso = textDateToIso(value);
          if (iso) { note('date_to_iso'); return iso; }
        }
        return value;
      }
      const iso = dateObjectToIso(value);
      if (iso) { note('date_object_to_iso', 'objet {jour, mois, année} → AAAA-MM-JJ'); return iso; }
      if (Array.isArray(value) && value.length === 1 && (typeof value[0] === 'string' || typeof value[0] === 'number')) {
        note('single_element_unwrapped');
        return walk(value[0], d, path, report, false, compat);
      }
      if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') {
        if (n.isoDate) return value;
        note('number_to_string');
        return String(value);
      }
      return value;
    }
    case 'number': {
      if (typeof value === 'string') {
        const x = numericString(value);
        if (x !== null && (!n.int || Number.isInteger(x))) { note('numeric_string'); return x; }
      }
      if (Array.isArray(value) && value.length === 1 && (typeof value[0] === 'number' || typeof value[0] === 'string')) {
        note('single_element_unwrapped');
        return walk(value[0], d, path, report, false, compat);
      }
      return value;
    }
    case 'boolean': {
      if (typeof value === 'string') {
        const s = value.trim().toLowerCase();
        if (VRAI.has(s)) { note('boolean_string'); return true; }
        if (FAUX.has(s)) { note('boolean_string'); return false; }
      }
      return value;
    }
    case 'enum':
    case 'literal': {
      const allowed = n.kind === 'enum' ? n.values : n.values.filter((x): x is string => typeof x === 'string');
      if (typeof value === 'string' && !allowed.includes(value)) {
        const m = matchEnum(value, allowed, { synonyms: compat });
        if (m?.rule === 'enum_synonym') {
          report.push({ stage: 'compat_mapping', rule: 'enum_synonym', path: at, detail: `${value} → ${m.value}` });
          return m.value;
        }
        if (m) { note(m.rule, `${value} → ${m.value}`); return m.value; }
      }
      return value;
    }
    case 'union': {
      // Union de scalaires (valeur d'un fait) : objet date et liste à un élément.
      const scalaires = n.options.every((o) => ['string', 'number', 'boolean', 'null', 'enum', 'literal'].includes(o.node.kind));
      if (scalaires) {
        const iso = dateObjectToIso(value);
        if (iso && n.options.some((o) => o.node.kind === 'string')) { note('date_object_to_iso', 'objet {jour, mois, année} → AAAA-MM-JJ'); return iso; }
        if (Array.isArray(value) && value.length === 1 && ['string', 'number', 'boolean'].includes(typeof value[0])) {
          note('single_element_unwrapped');
          return value[0];
        }
        if (Array.isArray(value) && value.length === 0 && n.options.some((o) => o.node.kind === 'null')) {
          note('empty_array_to_null');
          return null;
        }
      }
      return value;
    }
    default:
      return value;
  }
}

function compatibleScalar(el: ShapeNode, v: unknown): boolean {
  switch (el.kind) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number';
    case 'boolean': return typeof v === 'boolean';
    case 'enum': return typeof v === 'string';
    case 'object': return isObj(v);
    case 'union': return typeof v === 'string' || typeof v === 'number' || isObj(v);
    default: return false;
  }
}
