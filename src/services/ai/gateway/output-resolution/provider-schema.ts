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

export const MAX_PROVIDER_SCHEMA_NODES = 900;

type Json = Record<string, unknown>;

const KEEP = new Set(['type', 'properties', 'required', 'items', 'enum', 'anyOf', 'description', 'minimum', 'maximum', 'minItems', 'maxItems', 'format', 'propertyOrdering']);
const SAFE_BOUND = 9_007_199_254_740_991;

export interface ProviderSchema {
  schema: Json | null;
  /** Mots-clés retirés (contraintes vérifiées par Verebona seulement). */
  dropped: string[];
  nodes: number;
  /** Raison d'absence de schéma (`too_complex`, `unrepresentable`). */
  omitted: string | null;
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
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(Object.entries(v as Json).map(([pk, pv]) => [pk, reduce(pv, dropped, count)]));
      continue;
    }
    out[k] = reduce(v, dropped, count);
  }
  return out;
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
    res = count.n > MAX_PROVIDER_SCHEMA_NODES
      ? { schema: null, dropped: [...dropped].sort(), nodes: count.n, omitted: 'too_complex' }
      : { schema: reduced, dropped: [...dropped].sort(), nodes: count.n, omitted: null };
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

/** Refus de schéma mémorisés (fournisseur, modèle, schéma) — durée de vie du processus, 6 h. */
const refus = new Map<string, number>();
const REFUS_TTL_MS = 6 * 3_600_000;

export function noteSchemaRejected(model: string, schemaHash: string, now = Date.now()): void {
  refus.set(`${model}:${schemaHash}`, now + REFUS_TTL_MS);
}

export function schemaRejectedRecently(model: string, schemaHash: string, now = Date.now()): boolean {
  const until = refus.get(`${model}:${schemaHash}`);
  if (until === undefined) return false;
  if (until < now) { refus.delete(`${model}:${schemaHash}`); return false; }
  return true;
}

/** Réservé aux tests. */
export function clearSchemaRejections(): void {
  refus.clear();
}
