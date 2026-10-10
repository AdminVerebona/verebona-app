/**
 * Lecture de la forme d'un schéma Zod 4 — lot 33D (normalisation pilotée par
 * le schéma).
 *
 * La normalisation déterministe (`normalize.ts`) et l'élagage champ par champ
 * (`field-validation.ts`) ont besoin de savoir, pour chaque chemin : le type
 * attendu, les valeurs d'une énumération, si le champ est facultatif,
 * nullable ou a une valeur par défaut, et les clés connues d'un objet. Ce
 * module le lit dans la définition du schéma (`_zod.def`), sans jamais
 * l'exécuter.
 *
 * Enveloppes traversées : optional, nullable, default, prefault, readonly,
 * catch, nonoptional, lazy, et pipe (préprocesseur → schéma de sortie ;
 * transformation → schéma d'entrée).
 */
import type { ZodType } from 'zod';

export type ShapeNode =
  /** `open` : clés supplémentaires acceptées (`looseObject`, `catchall`) — lot 34D. */
  | { kind: 'object'; shape: Record<string, FieldDesc>; open?: boolean }
  | { kind: 'array'; element: FieldDesc; min: number | null; max: number | null }
  | { kind: 'string'; isoDate: boolean }
  | { kind: 'number'; int: boolean }
  | { kind: 'boolean' }
  | { kind: 'enum'; values: string[] }
  | { kind: 'literal'; values: unknown[] }
  | { kind: 'union'; options: FieldDesc[]; discriminator: string | null }
  | { kind: 'null' }
  | { kind: 'any' };

export interface FieldDesc {
  node: ShapeNode;
  /** Absent accepté (optional, default, prefault). */
  optional: boolean;
  nullable: boolean;
  hasDefault: boolean;
  /** Schéma Zod du nœud (validation locale d'un candidat). */
  schema: ZodType;
}

type Def = Record<string, unknown> & { type: string };
const defOf = (s: unknown): Def => ((s as { _zod?: { def?: Def } })?._zod?.def ?? { type: 'any' }) as Def;

const ISO_DATE_SOURCES = new Set(['^\\d{4}-\\d{2}-\\d{2}$']);

const cache = new WeakMap<object, FieldDesc>();

/** Descripteur d'un schéma (mémorisé par instance). */
export function describe(schema: ZodType): FieldDesc {
  const hit = cache.get(schema);
  if (hit) return hit;
  const desc = build(schema, 0);
  cache.set(schema, desc);
  return desc;
}

function build(schema: ZodType, depth: number): FieldDesc {
  let optional = false;
  let nullable = false;
  let hasDefault = false;
  let cur: unknown = schema;
  for (let guard = 0; guard < 30; guard++) {
    const d = defOf(cur);
    if (d.type === 'optional') { optional = true; cur = d.innerType; continue; }
    if (d.type === 'nullable') { nullable = true; cur = d.innerType; continue; }
    if (d.type === 'default' || d.type === 'prefault') { optional = true; hasDefault = true; cur = d.innerType; continue; }
    if (d.type === 'readonly' || d.type === 'catch' || d.type === 'nonoptional') { cur = d.innerType; continue; }
    if (d.type === 'lazy' && typeof d.getter === 'function') { cur = (d.getter as () => unknown)(); continue; }
    if (d.type === 'pipe') {
      const out = defOf(d.out);
      cur = out.type === 'transform' ? d.in : d.out;
      continue;
    }
    break;
  }
  const node = depth > 25 ? ({ kind: 'any' } as ShapeNode) : nodeOf(cur, depth);
  if (node.kind === 'null') nullable = true;
  return { node, optional, nullable, hasDefault, schema: schema };
}

function nodeOf(s: unknown, depth: number): ShapeNode {
  const d = defOf(s);
  switch (d.type) {
    case 'object': {
      const shape = (d.shape ?? {}) as Record<string, ZodType>;
      const out: Record<string, FieldDesc> = {};
      // Accès paresseux : les schémas récursifs ne sont pas dépliés à l'avance.
      for (const k of Object.keys(shape)) {
        let memo: FieldDesc | null = null;
        Object.defineProperty(out, k, {
          enumerable: true,
          get: () => (memo ??= build(shape[k], depth + 1)),
        });
      }
      const catchall = d.catchall ? defOf(d.catchall).type : null;
      return { kind: 'object', shape: out, open: catchall !== null && catchall !== 'never' };
    }
    case 'array': {
      const checks = (d.checks ?? []) as Array<{ _zod?: { def?: Record<string, unknown> } }>;
      let min: number | null = null;
      let max: number | null = null;
      for (const c of checks) {
        const cd = c._zod?.def ?? {};
        if (cd.check === 'min_length' && typeof cd.minimum === 'number') min = cd.minimum;
        if (cd.check === 'max_length' && typeof cd.maximum === 'number') max = cd.maximum;
      }
      return { kind: 'array', element: build(d.element as ZodType, depth + 1), min, max };
    }
    case 'string': {
      const checks = (d.checks ?? []) as Array<{ _zod?: { def?: Record<string, unknown> } }>;
      const isoDate = checks.some((c) => {
        const cd = c._zod?.def ?? {};
        if (cd.format === 'date') return true;
        const p = cd.pattern as RegExp | undefined;
        return cd.format === 'regex' && p instanceof RegExp && ISO_DATE_SOURCES.has(p.source);
      });
      return { kind: 'string', isoDate };
    }
    case 'number': {
      const checks = (d.checks ?? []) as Array<{ _zod?: { def?: Record<string, unknown> } }>;
      const int = checks.some((c) => ['safeint', 'int32', 'uint32', 'int64'].includes(String(c._zod?.def?.format)));
      return { kind: 'number', int };
    }
    case 'int':
      return { kind: 'number', int: true };
    case 'boolean':
      return { kind: 'boolean' };
    case 'enum':
      return { kind: 'enum', values: Object.values((d.entries ?? {}) as Record<string, string>).map(String) };
    case 'literal':
      return { kind: 'literal', values: (d.values ?? []) as unknown[] };
    case 'union':
      return {
        kind: 'union',
        options: ((d.options ?? []) as ZodType[]).map((o) => build(o, depth + 1)),
        discriminator: typeof d.discriminator === 'string' ? d.discriminator : null,
      };
    case 'null':
      return { kind: 'null' };
    default:
      return { kind: 'any' };
  }
}

/**
 * Descripteur au chemin `path` (segments d'objet et indices de tableau) ;
 * `null` si le chemin sort du schéma. Dans une union discriminée, l'option
 * est choisie d'après la valeur réelle.
 */
export function descAt(root: FieldDesc, path: ReadonlyArray<PropertyKey>, value: unknown): FieldDesc | null {
  let desc: FieldDesc | null = root;
  let cur: unknown = value;
  for (const seg of path) {
    if (!desc) return null;
    desc = resolveUnion(desc, cur);
    const n: ShapeNode = desc.node;
    if (n.kind === 'object' && typeof seg === 'string') desc = n.shape[seg] ?? null;
    else if (n.kind === 'array' && typeof seg === 'number') desc = n.element;
    else return null;
    cur = cur !== null && typeof cur === 'object' ? (cur as Record<PropertyKey, unknown>)[seg as never] : undefined;
  }
  return desc ? resolveUnion(desc, cur) : null;
}

/** Option d'une union applicable à `value` (discriminant, sinon unique option objet). */
export function resolveUnion(desc: FieldDesc, value: unknown): FieldDesc {
  const n = desc.node;
  if (n.kind !== 'union') return desc;
  if (n.discriminator && value && typeof value === 'object' && !Array.isArray(value)) {
    const v = (value as Record<string, unknown>)[n.discriminator];
    const hit = n.options.find((o) => {
      const f = o.node.kind === 'object' ? o.node.shape[n.discriminator!] : undefined;
      return f && f.node.kind === 'literal' && f.node.values.includes(v);
    });
    if (hit) return hit;
  }
  const objets = n.options.filter((o) => o.node.kind === 'object');
  if (objets.length === 1 && value && typeof value === 'object' && !Array.isArray(value)) return objets[0];
  return desc;
}
