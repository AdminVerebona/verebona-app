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
import { geminiSchemaAcceptable, geminiSchemaIssues, schemaIssueCodes } from '../providers/gemini-schema-contract';

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
 */
export const PROVIDER_SCHEMA_ADAPTER_VERSION = 'ps-2026-11-a';
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

const KEEP = new Set(['type', 'properties', 'required', 'items', 'enum', 'anyOf', 'description', 'minimum', 'maximum', 'minItems', 'maxItems', 'format', 'propertyOrdering']);
const SAFE_BOUND = 9_007_199_254_740_991;

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
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(Object.entries(v as Json).map(([pk, pv]) => [pk, reduce(pv, dropped, count)]));
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

const cache = new WeakMap<object, ProviderSchema>();

/** Schéma JSON réduit pour le fournisseur (mémorisé par schéma). */
export function providerJsonSchema(schema: ZodType): ProviderSchema {
  const hit = cache.get(schema);
  if (hit) return hit;
  let res: ProviderSchema;
  try {
    const json = z.toJSONSchema(splitPipe(schema).main, { io: 'input', unrepresentable: 'any', reused: 'inline' }) as Json;
    const dropped = new Set<string>();
    const count = { n: 0 };
    const reduced = reduce(json, dropped, count) as Json;
    dropped.delete('$schema');
    // Lot 109J : contrat du fournisseur vérifié AVANT tout appel — un schéma
    // non conforme n'est pas envoyé (aucun 400 payé puis masqué par un repli
    // en JSON libre) : l'appel garde le mode JSON, schéma du contrat dans le
    // prompt, motif `provider_contract` et écarts tracés.
    const issues = geminiSchemaIssues(reduced);
    const codes = schemaIssueCodes(issues);
    // Lot 114 (#776, AC07) : la projection ne retire aucune BRANCHE du contrat
    // canonique. Si elle en perdait une (évolution future de `reduce`), le
    // schéma amputé n'est PAS transmis : l'appel garde le mode JSON avec le
    // contrat complet dans le prompt, motif `projection_lossy` tracé — jamais
    // de donnée métier sacrifiée pour faire accepter un schéma.
    const lost = lostBranchesOf(json, reduced);
    res = count.n > MAX_PROVIDER_SCHEMA_NODES
      ? { schema: null, dropped: [...dropped].sort(), nodes: count.n, omitted: 'too_complex', issues: codes }
      : lost.length > 0
        ? { schema: null, dropped: [...dropped].sort(), nodes: count.n, omitted: 'projection_lossy', issues: codes, lostBranches: lost.slice(0, 50) }
        : !geminiSchemaAcceptable(issues)
          ? { schema: null, dropped: [...dropped].sort(), nodes: count.n, omitted: 'provider_contract', issues: codes }
          : { schema: reduced, dropped: [...dropped].sort(), nodes: count.n, omitted: null, issues: codes };
  } catch {
    res = { schema: null, dropped: [], nodes: 0, omitted: 'unrepresentable' };
  }
  cache.set(schema, res);
  return res;
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
