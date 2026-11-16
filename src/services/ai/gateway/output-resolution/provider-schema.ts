/**
 * Schéma FOURNISSEUR dérivé du schéma métier — lot 33D (ticket « réussite
 * malgré les désalignements », §23 à §25).
 *
 *   schéma métier (Zod) → schéma fournisseur compatible → réponse modèle
 *                       → adaptateur / normalisation → schéma métier canonique
 *
 * Le structured output contraint la génération, mais ne garantit pas la
 * conformité métier : la normalisation et la validation restent appliquées
 * à chaque réponse. Le schéma transmis est RÉDUIT au sous-ensemble que les
 * fournisseurs acceptent sans erreur (types, propriétés, obligatoires,
 * énumérations, listes, unions, bornes numériques et de liste, dates) : les
 * contraintes non transmises (motifs, longueurs de chaîne, valeurs par
 * défaut, propriétés additionnelles) restent vérifiées par Verebona.
 *
 * Un schéma trop complexe (au-delà de `MAX_PROVIDER_SCHEMA_NODES`) n'est
 * pas transmis : l'appel garde le seul mode JSON. Un refus du fournisseur
 * (HTTP 400 sur le schéma) est rattrapé par la passerelle, qui rejoue le
 * même modèle sans schéma et le mémorise (`STRUCTURED_OUTPUT_REJECTED`).
 */
import { z, type ZodType } from 'zod';
import { splitPipe } from './field-validation';
import {
  geminiSchemaAcceptable, geminiSchemaIssues, geminiSchemaMetrics, schemaIssueCodes, type GeminiSchemaMetrics,
} from '../providers/gemini-schema-contract';

const MAX_PROVIDER_SCHEMA_NODES = 900;

/**
 * Lot 114 (carte #776, §5) — VERSION DE L'ADAPTATEUR de projection. Elle fait
 * partie de la clé de compatibilité d'un couple (`schema-compat/policy.ts`) :
 * à INCRÉMENTER à chaque changement de `reduce` / `providerJsonSchema` qui
 * modifie le schéma transmis — les qualifications et refus mémorisés pour
 * l'ancienne projection cessent alors de s'appliquer. Un test fige
 * l'empreinte de la projection d'un schéma de référence pour cette version
 * (`l114j-projection-schema.test.ts`) : changer la projection sans changer la
 * version le fait échouer.
 *
 * `ps-2026-11-b` (lot 115, carte #784) : `$defs` et `$ref` transmis, forme
 * factorisée par défaut (`SCHEMA_SHAPES`). Les couples qualifiés ou refusés
 * pour `ps-2026-11-a` deviennent HISTORIQUES — rien n'est purgé, rien n'est
 * hérité.
 */
export const PROVIDER_SCHEMA_ADAPTER_VERSION = 'ps-2026-11-b';
/**
 * Lot 109J — borne de liste conservée dans le schéma fournisseur. Au-delà,
 * `maxItems` n'est PAS transmis (vérifié par Verebona à la validation) :
 * une borne élevée, surtout imbriquée (`families[≤100].document_ids[≤200]`
 * de T3 DOCUMENT_NAMING, 20 000 états), multiplie les états de la contrainte
 * de décodage — cause documentée de refus 400 INVALID_ARGUMENT par Gemini
 * (incident T3:6033, appel 7345). Les petites bornes (≤ 20) restent utiles.
 */
export const PROVIDER_MAX_ITEMS_KEPT = 20;

type Json = Record<string, unknown>;

/**
 * Mots-clés transmis. Lot 115 (carte #784, §A2) : `$defs` et `$ref` s'y
 * ajoutent — ils appartiennent au sous-ensemble documenté par le fournisseur
 * (`GEMINI_JSON_SCHEMA_KEYWORDS`) et permettent de ne transmettre qu'UNE fois
 * un sous-schéma répété (voir `SCHEMA_SHAPES`).
 */
const KEEP = new Set(['type', 'properties', 'required', 'items', 'enum', 'anyOf', 'description', 'minimum', 'maximum', 'minItems', 'maxItems', 'format', 'propertyOrdering', '$defs', '$ref']);
const SAFE_BOUND = 9_007_199_254_740_991;

/**
 * Lot 115 (carte #784, §A2) — PLAFOND DE PROPRIÉTÉS du schéma transmis :
 * aucun par défaut. Il ne se pose qu'en exploitation, par la variable
 * d'environnement `AI_PROVIDER_SCHEMA_MAX_PROPERTIES` (nombre de propriétés),
 * lorsque la préproduction a constaté un refus RÉEL et l'a corrélé au nombre
 * de propriétés. Au-delà du plafond, le schéma n'est pas transmis (motif
 * `provider_contract`, écart `PROPERTY_CAP_EXCEEDED` tracé) : l'appel garde le
 * mode JSON et le contrat complet dans le prompt — repli explicite, borné et
 * observable, jamais une compatibilité déclarée. Aucun seuil n'est inventé
 * dans le code : la cause des HTTP 400 n'a pas pu être établie dans l'atelier.
 */
export function providerSchemaPropertyCap(env: NodeJS.ProcessEnv = process.env): number | null {
  const n = Number((env.AI_PROVIDER_SCHEMA_MAX_PROPERTIES ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

interface ProviderSchema {
  schema: Json | null;
  /** Mots-clés retirés (contraintes vérifiées par Verebona seulement). */
  dropped: string[];
  nodes: number;
  /**
   * Raison d'absence de schéma (`too_complex`, `unrepresentable`, `provider_contract` — lot 109J ;
   * `projection_lossy` — lot 114, #776 : la projection aurait perdu une branche du contrat).
   */
  omitted: string | null;
  /** Lot 114 (#776) : branches du contrat canonique absentes de la projection (vide : aucune perte). */
  lostBranches?: string[];
  /** Lot 109J : écarts au contrat du fournisseur (`gemini-schema-contract`), codes compacts. */
  issues?: string[];
  /**
   * Lot 115 (#784, §A) : profil de complexité MESURÉ de la projection
   * (propriétés, énumérations, unions, profondeur, bornes imbriquées, taille).
   * Mesure, pas cause : tracée pour rendre un refus réel corrélable.
   */
  metrics?: GeminiSchemaMetrics;
  /** Lot 115 (#784, §A2) : forme réellement transmise (`factorise` : sous-schémas répétés en `$defs` / `$ref`). */
  shape?: SchemaShape;
}

function reduce(node: unknown, dropped: Set<string>, count: { n: number }): unknown {
  if (Array.isArray(node)) return node.map((x) => reduce(x, dropped, count));
  if (!node || typeof node !== 'object') return node;
  count.n++;
  const src = node as Json;
  const out: Json = {};
  // `const` → énumération d'une valeur ; `oneOf` → `anyOf`.
  if (src.const !== undefined) { out.enum = [src.const]; if (typeof src.const === 'string') out.type = 'string'; }
  if (Array.isArray(src.oneOf)) out.anyOf = src.oneOf.map((x) => reduce(x, dropped, count));
  for (const [k, v] of Object.entries(src)) {
    if (k === 'const' || k === 'oneOf') continue;
    if (!KEEP.has(k)) { dropped.add(k); continue; }
    if (k === 'format' && !['date', 'date-time'].includes(String(v))) { dropped.add('format'); continue; }
    if ((k === 'minimum' || k === 'maximum') && Math.abs(Number(v)) >= SAFE_BOUND) continue;
    if (k === 'maxItems' && Number(v) > PROVIDER_MAX_ITEMS_KEPT) { dropped.add('maxItems'); continue; }
    // `properties` et `$defs` sont des DICTIONNAIRES de schémas : leurs clés
    // sont des noms (propriété métier, sous-schéma factorisé), jamais des
    // mots-clés — elles ne passent pas par le filtre `KEEP`.
    if ((k === 'properties' || k === '$defs') && v && typeof v === 'object') {
      out[k] = Object.fromEntries(Object.entries(v as Json).map(([pk, pv]) => [pk, reduce(pv, dropped, count)]));
      continue;
    }
    out[k] = reduce(v, dropped, count);
  }
  return out;
}

/**
 * Lot 114 (carte #776, travail 6 — AC07) — BRANCHES d'un schéma JSON : chemin
 * de chaque propriété (`$.facts[].rawValue`), à travers objets, listes et
 * unions. Pure.
 */
export function schemaBranches(schema: unknown): string[] {
  const out = new Set<string>();
  const walk = (n: unknown, path: string): void => {
    if (!n || typeof n !== 'object' || Array.isArray(n)) return;
    const node = n as Json;
    if (node.properties && typeof node.properties === 'object') {
      for (const [k, v] of Object.entries(node.properties as Json)) { out.add(`${path}.${k}`); walk(v, `${path}.${k}`); }
    }
    if (node.items) walk(node.items, `${path}[]`);
    if (node.additionalProperties && typeof node.additionalProperties === 'object') walk(node.additionalProperties, `${path}{}`);
    for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems'] as const) {
      const l = node[key];
      if (Array.isArray(l)) l.forEach((x) => walk(x, path));
    }
  };
  walk(schema, '$');
  return [...out].sort();
}

/**
 * Branches du contrat CANONIQUE absentes du schéma projeté. La projection
 * retire des CONTRAINTES (motifs, longueurs, grandes bornes) que Verebona
 * revalide ; elle ne doit JAMAIS retirer une propriété : un modèle contraint
 * par un schéma amputé ne pourrait plus rendre la branche. Pure.
 */
export function lostBranchesOf(canonicalJsonSchema: unknown, projected: unknown): string[] {
  const kept = new Set(schemaBranches(projected));
  return schemaBranches(canonicalJsonSchema).filter((b) => !kept.has(b));
}

const cache = new WeakMap<object, Map<string, ProviderSchema>>();

/**
 * Lot 115 (carte #784, §A2) — FORME du schéma transmis.
 *
 *   · `factorise` (défaut) : un sous-schéma répété est transmis UNE fois dans
 *     `$defs` et référencé par `$ref`. Les deux mots-clés appartiennent au
 *     sous-ensemble documenté par le fournisseur. Le schéma transmis pour T1
 *     passe ainsi de 15 399 à moins de 3 000 caractères, de 261 à 61
 *     propriétés, de 156 à 3 valeurs d'énumération et de 8 à 5 niveaux :
 *     chacune des dimensions que la documentation citée par la carte désigne
 *     comme cause possible d'un refus « too many states » baisse, SANS perdre
 *     une seule branche du contrat (contrôle `projection_lossy` fait sur la
 *     forme déréférencée) ;
 *   · `inline` : forme antérieure (chaque sous-schéma répété écrit en entier).
 *
 * La cause des HTTP 400 observés en préproduction reste INCONNUE : cette
 * réduction ne la corrige pas « par construction », elle rapproche le schéma
 * des contraintes documentées et reste réversible sans redéploiement
 * (variable d'environnement `AI_PROVIDER_SCHEMA_SHAPE`, valeur `inline`). Un
 * changement de forme change l'empreinte du schéma projeté, donc le COUPLE :
 * aucune qualification ni aucun refus mémorisé n'est hérité de l'autre forme.
 */
export const SCHEMA_SHAPES = ['factorise', 'inline'] as const;
export type SchemaShape = (typeof SCHEMA_SHAPES)[number];

/** Forme demandée par l'exploitation (défaut : `factorise`). */
export function providerSchemaShape(env: NodeJS.ProcessEnv = process.env): SchemaShape {
  return /^inline$/i.test((env.AI_PROVIDER_SCHEMA_SHAPE ?? '').trim()) ? 'inline' : 'factorise';
}

/** Options de projection (lot 115, #784) : forme et plafonds d'exploitation seulement. */
export interface ProviderSchemaOptions {
  /** Plafond de propriétés ; par défaut celui de l'exploitation (`providerSchemaPropertyCap`). */
  maxProperties?: number | null;
  /** Forme transmise ; par défaut celle de l'exploitation (`providerSchemaShape`). */
  shape?: SchemaShape;
}

interface Projection { reduced: Json; dropped: Set<string>; nodes: number }

/** Réduction d'une forme JSON Schema (pure). */
function project(json: Json): Projection {
  const dropped = new Set<string>();
  const count = { n: 0 };
  const reduced = reduce(json, dropped, count) as Json;
  dropped.delete('$schema');
  return { reduced, dropped, nodes: count.n };
}

/** Schéma JSON réduit pour le fournisseur (mémorisé par schéma, forme et plafond d'exploitation). */
export function providerJsonSchema(schema: ZodType, opts: ProviderSchemaOptions = {}): ProviderSchema {
  const cap = opts.maxProperties === undefined ? providerSchemaPropertyCap() : opts.maxProperties;
  const shapeVoulue = opts.shape ?? providerSchemaShape();
  const byCap = cache.get(schema) ?? new Map<string, ProviderSchema>();
  const cacheKey = `${shapeVoulue}/${cap ?? '-'}`;
  const hit = byCap.get(cacheKey);
  if (hit) return hit;
  let res: ProviderSchema;
  try {
    const main = splitPipe(schema).main;
    // Référence des BRANCHES : la forme déployée du contrat canonique.
    const json = z.toJSONSchema(main, { io: 'input', unrepresentable: 'any', reused: 'inline' }) as Json;
    const inline = project(json);
    let shape: SchemaShape = 'inline';
    let p = inline;
    /** Schéma déréférencé : ce que le fournisseur doit décoder (bornes, profondeur, branches). */
    let resolu = inline.reduced;
    if (shapeVoulue === 'factorise') {
      const refs = project(z.toJSONSchema(main, { io: 'input', unrepresentable: 'any', reused: 'ref' }) as Json);
      const deref = inlineRefs(refs.reduced);
      // Factorisation retenue seulement si elle est SANS PERTE (références
      // toutes résolues, aucune branche manquante) ET effectivement plus
      // petite ; sinon la forme déployée reste transmise, sans aucun risque.
      const utilisable = lostBranchesOf(json, deref).length === 0
        && JSON.stringify(refs.reduced).length < JSON.stringify(inline.reduced).length;
      if (utilisable) { shape = 'factorise'; p = refs; resolu = deref; }
    }
    // Lot 109J : contrat du fournisseur vérifié AVANT tout appel — un schéma
    // non conforme n'est pas envoyé (aucun 400 payé puis masqué par un repli
    // en JSON libre) : l'appel garde le mode JSON, schéma du contrat dans le
    // prompt, motif `provider_contract` et écarts tracés.
    // Lot 115 (#784) : mots-clés, types, énumérations et taille contrôlés sur
    // le schéma RÉELLEMENT TRANSMIS ; bornes imbriquées et profondeur sur sa
    // forme déréférencée — une factorisation ne doit pas masquer un état.
    const issues = [
      ...geminiSchemaIssues(p.reduced, { maxProperties: cap }),
      ...(shape === 'factorise' ? geminiSchemaIssues(resolu).filter((i) => i.code === 'NESTED_ARRAY_BOUNDS' || i.code === 'TOO_DEEP') : []),
    ];
    const codes = schemaIssueCodes(issues);
    const metrics = geminiSchemaMetrics(p.reduced);
    // Lot 115 (#784, A2) : INVARIANT de conformité — la projection ne transmet
    // que des mots-clés du sous-ensemble documenté. `KEEP` l'assure déjà ; ce
    // contrôle garde l'invariant si `reduce` évolue (un mot-clé hors contrat
    // ferait basculer l'appel en mode JSON, jamais partir tel quel).
    const horsContrat = [...new Set(issues.filter((i) => i.code === 'UNSUPPORTED_KEYWORD').map((i) => i.detail))].sort();
    // Lot 114 (#776, AC07) : la projection ne retire aucune BRANCHE du contrat
    // canonique. Si elle en perdait une (évolution future de `reduce`), le
    // schéma amputé n'est PAS transmis : l'appel garde le mode JSON avec le
    // contrat complet dans le prompt, motif `projection_lossy` tracé — jamais
    // de donnée métier sacrifiée pour faire accepter un schéma.
    const lost = lostBranchesOf(json, resolu);
    const base = { dropped: [...p.dropped].sort(), nodes: p.nodes, issues: codes, metrics, shape };
    res = p.nodes > MAX_PROVIDER_SCHEMA_NODES
      ? { ...base, schema: null, omitted: 'too_complex' }
      : lost.length > 0
        ? { ...base, schema: null, omitted: 'projection_lossy', lostBranches: lost.slice(0, 50) }
        : !geminiSchemaAcceptable(issues) || horsContrat.length > 0
          ? { ...base, schema: null, omitted: 'provider_contract' }
          : { ...base, schema: p.reduced, omitted: null };
  } catch {
    res = { schema: null, dropped: [], nodes: 0, omitted: 'unrepresentable', shape: 'inline' };
  }
  byCap.set(cacheKey, res);
  cache.set(schema, byCap);
  return res;
}

/**
 * Lot 115 (carte #784, §A) — VARIANTES de projection, mesurées sans aucun
 * appel fournisseur. La cause des refus HTTP 400 n'ayant pas pu être établie
 * dans l'atelier, le code ne change PAS la projection au hasard : il mesure ce
 * que chaque réduction candidate apporterait (taille, propriétés, unions,
 * bornes imbriquées) et si elle reste SANS PERTE de branche, pour que la
 * préproduction décide sur des chiffres.
 *
 *   · `deployee`        forme déployée (chaque sous-schéma répété en entier) ;
 *   · `sans_bornes`     bornes numériques non transmises (revalidées par Zod) ;
 *   · `sans_maxitems`   aucune borne de liste transmise ;
 *   · `sans_textes`     descriptions non transmises (le contrat reste au prompt) ;
 *   · `refs_factorises` sous-schémas répétés factorisés (`$defs` / `$ref`) —
 *                       forme transmise par défaut depuis ce lot.
 */
export type ProjectionVariantName = 'deployee' | 'sans_bornes' | 'sans_maxitems' | 'sans_textes' | 'refs_factorises';

export interface ProjectionVariant {
  name: ProjectionVariantName;
  metrics: GeminiSchemaMetrics;
  /** Branches du contrat canonique perdues par cette variante (vide : sans perte). */
  lostBranches: string[];
  /** Conforme au contrôle statique du fournisseur. */
  conform: boolean;
  /** Mots-clés hors sous-ensemble documenté (vide : aucun). */
  unsupportedKeywords: string[];
}

/** Variantes mesurées d'un schéma métier (pure, aucun réseau, aucun cache). */
export function projectionVariants(schema: ZodType): ProjectionVariant[] {
  const main = splitPipe(schema).main;
  const canonical = z.toJSONSchema(main, { io: 'input', unrepresentable: 'any', reused: 'inline' }) as Json;
  const build = (name: ProjectionVariantName): ProjectionVariant => {
    const source = name === 'refs_factorises'
      ? (z.toJSONSchema(main, { io: 'input', unrepresentable: 'any', reused: 'ref' }) as Json)
      : canonical;
    let projected = project(source).reduced;
    if (name === 'sans_bornes') projected = stripKeywords(projected, ['minimum', 'maximum']);
    if (name === 'sans_maxitems') projected = stripKeywords(projected, ['maxItems', 'minItems']);
    if (name === 'sans_textes') projected = stripKeywords(projected, ['description']);
    const issues = geminiSchemaIssues(projected);
    return {
      name, metrics: geminiSchemaMetrics(projected),
      // Une variante factorisée référence ses sous-schémas : les branches se lisent sur le schéma déréférencé.
      lostBranches: lostBranchesOf(canonical, name === 'refs_factorises' ? inlineRefs(projected) : projected),
      conform: geminiSchemaAcceptable(issues),
      unsupportedKeywords: [...new Set(issues.filter((i) => i.code === 'UNSUPPORTED_KEYWORD').map((i) => i.detail))].sort(),
    };
  };
  return (['deployee', 'sans_bornes', 'sans_maxitems', 'sans_textes', 'refs_factorises'] as const).map(build);
}

/** Retire des MOTS-CLÉS (jamais une propriété métier : `properties` n'est pas traversé comme un dictionnaire de mots-clés). Pure. */
function stripKeywords(node: unknown, keywords: readonly string[]): Json {
  const walk = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.map(walk);
    if (!n || typeof n !== 'object') return n;
    const out: Json = {};
    for (const [k, v] of Object.entries(n as Json)) {
      if (keywords.includes(k)) continue;
      out[k] = k === 'properties' && v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v as Json).map(([pk, pv]) => [pk, walk(pv)]))
        : walk(v);
    }
    return out;
  };
  return walk(node) as Json;
}

/**
 * Lot 115 (carte #784, §A2) — DÉRÉFÉRENCE `$ref` / `$defs` (profondeur bornée)
 * : forme déployée d'un schéma factorisé. C'est sur ELLE que se contrôlent les
 * branches du contrat, les bornes de liste imbriquées et la profondeur — une
 * factorisation ne doit ni cacher une perte, ni cacher un état. Pure.
 */
export function resolveSchemaRefs(schema: Json): Json {
  return inlineRefs(schema);
}

/** Déréférence `$ref` / `$defs` (profondeur bornée) pour comparer les branches. Pure. */
function inlineRefs(schema: Json): Json {
  const defs = (schema.$defs && typeof schema.$defs === 'object' ? schema.$defs : {}) as Json;
  const walk = (n: unknown, depth: number): unknown => {
    if (Array.isArray(n)) return n.map((x) => walk(x, depth));
    if (!n || typeof n !== 'object') return n;
    const node = n as Json;
    const ref = typeof node.$ref === 'string' ? /^#\/\$defs\/(.+)$/.exec(node.$ref) : null;
    if (ref && depth < 12) {
      const cible = defs[decodeURIComponent(ref[1])];
      if (cible) return walk(cible, depth + 1);
    }
    const out: Json = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === '$defs' || k === '$ref') continue;
      out[k] = k === 'properties' && v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v as Json).map(([pk, pv]) => [pk, walk(pv, depth)]))
        : walk(v, depth);
    }
    return out;
  };
  return walk(schema, 0) as Json;
}

/**
 * Structured output activé ? Variable `AI_STRUCTURED_OUTPUT` (défaut : actif) ;
 * `off` le coupe pour tous les appels, sans redéploiement de code.
 */
export function structuredOutputEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(off|false|0|no|disabled)$/i.test((env.AI_STRUCTURED_OUTPUT ?? '').trim());
}

/**
 * Refus de schéma mémorisés — lot 114 (carte #776) : la mémoire locale de
 * 6 heures (`noteSchemaRejected`) est REMPLACÉE par la mémoire partagée et
 * durable de `../schema-compat` (clé par couple, réexamen borné et réservé).
 * Les lectures historiques restent exportées d'ici pour leurs appelants.
 */
export { schemaRejectedRecently, clearSchemaRejections } from '../schema-compat';
