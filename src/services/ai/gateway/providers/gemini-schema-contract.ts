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
 *
 * Lot 115 (carte #784, §A) — ajout du PROFIL DE COMPLEXITÉ mesuré
 * (`geminiSchemaMetrics`) : propriétés, longueur des noms, valeurs
 * d'énumération, unions, listes, profondeur, bornes imbriquées, taille. La
 * cause des HTTP 400 observés en préproduction N'A PAS pu être établie (aucun
 * accès au fournisseur) : ces mesures ne concluent rien, elles rendent le
 * prochain refus RÉEL corrélable à une dimension documentée. Aucun seuil
 * nouveau ne bloque l'envoi ; un plafond de propriétés peut être posé en
 * exploitation, et seulement là.
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
  // Décision du PO (16/11/2026, carte #784) : aucun plafond de propriétés — l'écart correspondant est retiré.
  code: 'UNSUPPORTED_KEYWORD' | 'INVALID_TYPE' | 'INVALID_ENUM' | 'NESTED_ARRAY_BOUNDS' | 'TOO_DEEP' | 'TOO_LARGE' | 'UNTYPED_NODE';
  severity: 'error' | 'warning';
  /** Chemin JSON du nœud (`$.properties.families.items…`). */
  path: string;
  detail: string;
}

/**
 * Lot 115 (carte #784, §A) — PROFIL DE COMPLEXITÉ du schéma réellement
 * transmis, sur les dimensions que la documentation du fournisseur citée par
 * la carte désigne comme causes possibles d'un refus « too many states » :
 * bornes de liste imbriquées, nombre de propriétés, valeurs d'énumération,
 * unions, profondeur, taille.
 *
 * Ce sont des MESURES, pas des causes : aucune ne déclenche à elle seule un
 * refus ni n'empêche l'envoi (sauf le plafond de propriétés explicitement
 * configuré en exploitation). Elles sont tracées pour que le PROCHAIN refus
 * réel soit corrélable à une dimension au lieu d'être attribué au hasard.
 */
export interface GeminiSchemaMetrics {
  /** Nœuds objets du schéma (toutes branches). */
  nodes: number;
  /** Propriétés déclarées (toutes profondeurs, unions comprises). */
  properties: number;
  /** Caractères cumulés des NOMS de propriétés (la documentation cite la longueur des noms). */
  propertyNameChars: number;
  /** Valeurs d'énumération cumulées. */
  enumValues: number;
  /** Branches d'union (`anyOf` / `oneOf`) cumulées. */
  unionBranches: number;
  /** Listes déclarées. */
  arrays: number;
  /** Propriétés obligatoires cumulées. */
  requiredProperties: number;
  /** Profondeur maximale atteinte. */
  depth: number;
  /** Produit maximal des bornes `maxItems` le long d'un chemin (1 : aucune borne transmise). */
  nestedArrayBound: number;
  /** Taille sérialisée (caractères). */
  serializedChars: number;
}

const ZERO_METRICS: GeminiSchemaMetrics = {
  nodes: 0, properties: 0, propertyNameChars: 0, enumValues: 0, unionBranches: 0, arrays: 0,
  requiredProperties: 0, depth: 0, nestedArrayBound: 1, serializedChars: 0,
};

/** Profil de complexité d'un schéma (pure). Schéma absent : tout à zéro. */
export function geminiSchemaMetrics(schema: Json | null | undefined): GeminiSchemaMetrics {
  if (!schema) return { ...ZERO_METRICS };
  const m: GeminiSchemaMetrics = { ...ZERO_METRICS, serializedChars: JSON.stringify(schema).length };
  const walk = (n: unknown, depth: number, bound: number): void => {
    if (!n || typeof n !== 'object' || Array.isArray(n)) return;
    const node = n as Json;
    m.nodes++;
    if (depth > m.depth) m.depth = depth;
    if (bound > m.nestedArrayBound) m.nestedArrayBound = bound;
    if (Array.isArray(node.enum)) m.enumValues += node.enum.length;
    if (Array.isArray(node.required)) m.requiredProperties += node.required.length;
    if (node.properties && typeof node.properties === 'object') {
      for (const [k, v] of Object.entries(node.properties as Json)) {
        m.properties++;
        m.propertyNameChars += k.length;
        walk(v, depth + 1, bound);
      }
    }
    if (node.items) {
      m.arrays++;
      const max = typeof node.maxItems === 'number' && node.maxItems > 0 ? node.maxItems : 1;
      walk(node.items, depth + 1, bound * max);
    }
    for (const key of ['anyOf', 'oneOf', 'prefixItems'] as const) {
      const l = node[key];
      if (!Array.isArray(l)) continue;
      if (key !== 'prefixItems') m.unionBranches += l.length;
      l.forEach((x) => walk(x, depth + 1, bound));
    }
    if (node.additionalProperties && typeof node.additionalProperties === 'object') walk(node.additionalProperties, depth + 1, bound);
    if (node.$defs && typeof node.$defs === 'object') for (const v of Object.values(node.$defs as Json)) walk(v, depth + 1, bound);
  };
  walk(schema, 0, 1);
  return m;
}

/** Mots-clés du schéma hors du sous-ensemble documenté (pure) — invariant de la projection. */
export function unsupportedKeywordsIn(schema: Json | null | undefined): string[] {
  return [...new Set(geminiSchemaIssues(schema).filter((i) => i.code === 'UNSUPPORTED_KEYWORD').map((i) => i.detail))].sort();
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
  // DÉCISION DU PO (16/11/2026, carte #784) : AUCUN plafond sur le nombre de propriétés — le contrôle ne
  // porte que sur les limites DOCUMENTÉES du contrat du fournisseur. Le nombre de propriétés reste mesuré
  // (`geminiSchemaMetrics`) comme élément de diagnostic, jamais comme seuil.
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
