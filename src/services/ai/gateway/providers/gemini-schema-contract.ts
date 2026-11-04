/**
 * Lot 109J — CONTRAT du schéma de sortie transmis à Gemini (`responseJsonSchema`).
 *
 * Incident T3:6033 (appel 7345, `t3_document_naming@v1`) : HTTP 400
 * INVALID_ARGUMENT générique sur la requête structurée, puis réponse reçue
 * sans schéma — le schéma est la cause opérationnelle, sans que Google dise
 * pourquoi. Ce module vérifie, AVANT l'appel et sans réseau, le schéma
 * RÉELLEMENT envoyé contre les contraintes publiées de l'API :
 *
 *   · sous-ensemble de mots-clés JSON Schema accepté (les autres sont
 *     ignorés au mieux — signalés, jamais transmis par Verebona) ;
 *   · `type` parmi les types JSON Schema ; `enum` non vide, de chaînes ou de
 *     nombres (jamais `null`, booléen ou objet) ;
 *   · COMPLEXITÉ : Google refuse (400 « too many states » / INVALID_ARGUMENT)
 *     les schémas dont la contrainte de décodage a trop d'états — causes
 *     citées par la documentation : bornes de longueur de liste élevées,
 *     surtout IMBRIQUÉES, propriétés nombreuses, profondeur. Mesures :
 *     produit des `maxItems` le long d'un chemin, profondeur, taille.
 *
 * Gravité `error` : le schéma ne doit pas partir tel quel (la passerelle ne
 * l'envoie pas et le signale, au lieu de payer un 400 puis un repli JSON
 * libre) ; `warning` : transmis, signalé dans la trace. Pur, sans dépendance.
 */

type Json = Record<string, unknown>;

/** Mots-clés JSON Schema acceptés par `responseJsonSchema` (documentation Gemini API, structured output). */
export const GEMINI_JSON_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  '$id', '$defs', '$ref', '$anchor', 'type', 'format', 'title', 'description', 'enum', 'items', 'prefixItems',
  'minItems', 'maxItems', 'minimum', 'maximum', 'anyOf', 'oneOf', 'properties', 'additionalProperties', 'required',
  'propertyOrdering',
]);

const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);

/** Seuils (paramètres centralisés). */
export const GEMINI_SCHEMA_LIMITS = {
  /** Produit maximal des bornes `maxItems` imbriquées le long d'un chemin (états de la contrainte). */
  maxNestedArrayBound: 1_000,
  /** Profondeur maximale (objets / listes imbriqués). */
  maxDepth: 16,
  /** Taille maximale du schéma sérialisé (caractères). */
  maxSerializedChars: 32_000,
} as const;

export interface GeminiSchemaIssue {
  code: 'UNSUPPORTED_KEYWORD' | 'INVALID_TYPE' | 'INVALID_ENUM' | 'NESTED_ARRAY_BOUNDS' | 'TOO_DEEP' | 'TOO_LARGE' | 'UNTYPED_NODE';
  severity: 'error' | 'warning';
  /** Chemin JSON du nœud (`$.properties.families.items…`). */
  path: string;
  detail: string;
}

/** Problèmes du schéma au regard du contrat Gemini (pure). Vide : schéma conforme. */
export function geminiSchemaIssues(schema: Json | null | undefined): GeminiSchemaIssue[] {
  if (!schema) return [];
  const issues: GeminiSchemaIssue[] = [];
  const seen = new Set<string>();
  const add = (i: GeminiSchemaIssue) => {
    const k = `${i.code}:${i.path}`;
    if (!seen.has(k)) { seen.add(k); issues.push(i); }
  };
  const walk = (n: unknown, path: string, depth: number, bound: number) => {
    if (!n || typeof n !== 'object' || Array.isArray(n)) return;
    const node = n as Json;
    if (depth > GEMINI_SCHEMA_LIMITS.maxDepth) {
      add({ code: 'TOO_DEEP', severity: 'error', path, detail: `profondeur > ${GEMINI_SCHEMA_LIMITS.maxDepth}` });
      return;
    }
    for (const k of Object.keys(node)) {
      if (!GEMINI_JSON_SCHEMA_KEYWORDS.has(k)) add({ code: 'UNSUPPORTED_KEYWORD', severity: 'warning', path, detail: k });
    }
    const types = Array.isArray(node.type) ? node.type : node.type === undefined ? [] : [node.type];
    for (const t of types) if (typeof t !== 'string' || !TYPES.has(t)) add({ code: 'INVALID_TYPE', severity: 'error', path, detail: String(t) });
    if (node.enum !== undefined) {
      const e = node.enum;
      const ok = Array.isArray(e) && e.length > 0 && e.every((v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)));
      if (!ok) add({ code: 'INVALID_ENUM', severity: 'error', path, detail: 'enum vide ou valeur non chaîne / non nombre' });
    }
    if (!types.length && node.enum === undefined && node.anyOf === undefined && node.oneOf === undefined && node.$ref === undefined) {
      add({ code: 'UNTYPED_NODE', severity: 'warning', path, detail: 'nœud sans type (valeur libre)' });
    }
    if (node.properties && typeof node.properties === 'object') {
      for (const [k, v] of Object.entries(node.properties as Json)) walk(v, `${path}.properties.${k}`, depth + 1, bound);
    }
    if (node.items) {
      const max = typeof node.maxItems === 'number' && node.maxItems > 0 ? node.maxItems : 1;
      const b = bound * max;
      if (b > GEMINI_SCHEMA_LIMITS.maxNestedArrayBound) {
        add({ code: 'NESTED_ARRAY_BOUNDS', severity: 'error', path, detail: `bornes de liste imbriquées : ${b} > ${GEMINI_SCHEMA_LIMITS.maxNestedArrayBound}` });
      }
      walk(node.items, `${path}.items`, depth + 1, b);
    }
    for (const key of ['anyOf', 'oneOf', 'prefixItems'] as const) {
      const l = node[key];
      if (Array.isArray(l)) l.forEach((x, i) => walk(x, `${path}.${key}[${i}]`, depth + 1, bound));
    }
    if (node.additionalProperties && typeof node.additionalProperties === 'object') walk(node.additionalProperties, `${path}.additionalProperties`, depth + 1, bound);
    if (node.$defs && typeof node.$defs === 'object') {
      for (const [k, v] of Object.entries(node.$defs as Json)) walk(v, `${path}.$defs.${k}`, depth + 1, bound);
    }
  };
  walk(schema, '$', 0, 1);
  const size = JSON.stringify(schema).length;
  if (size > GEMINI_SCHEMA_LIMITS.maxSerializedChars) {
    add({ code: 'TOO_LARGE', severity: 'error', path: '$', detail: `${size} caractères > ${GEMINI_SCHEMA_LIMITS.maxSerializedChars}` });
  }
  return issues;
}

/** Le schéma peut-il partir tel quel ? (aucun problème de gravité `error`). */
export function geminiSchemaAcceptable(issues: readonly GeminiSchemaIssue[]): boolean {
  return !issues.some((i) => i.severity === 'error');
}

/** Codes compacts pour la trace (`NESTED_ARRAY_BOUNDS@$.properties.families.items`). */
export function schemaIssueCodes(issues: readonly GeminiSchemaIssue[], max = 20): string[] {
  return issues.slice(0, max).map((i) => `${i.code}@${i.path}${i.code === 'UNSUPPORTED_KEYWORD' ? `:${i.detail}` : ''}`);
}
