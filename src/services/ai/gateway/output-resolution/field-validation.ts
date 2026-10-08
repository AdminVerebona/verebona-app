/**
 * Validation champ par champ — lot 33D (ticket « réussite malgré les
 * désalignements », §12, §13).
 *
 * « 1 champ incorrect → toute la réponse rejetée » n'est plus la règle :
 * après normalisation (et, le cas échéant, réparation ciblée), un champ
 * FACULTATIF qui reste invalide est retiré — les champs valides sont
 * conservés tels quels. Un élément invalide d'une liste est retiré seul, si
 * la liste reste dans ses bornes. Un champ OBLIGATOIRE invalide n'est jamais
 * retiré : c'est son objet parent qui l'est, s'il est lui-même facultatif ;
 * sinon la sortie reste invalide (repli). Le discriminant (`task`, `mode`)
 * n'est jamais touché. Chaque retrait est consigné.
 */
import type { ZodType } from 'zod';
import type { OutputRepairStep } from '../diagnostics/taxonomy';
import { describe, descAt } from './schema-introspect';
import { genericPath, jsonPath, valueAt } from '../diagnostics/classify';
import { redact } from '../redaction';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Schéma « préparé » : un `z.preprocess(fn, X)` est séparé en sa préparation
 * et son schéma `X`. Les chemins d'erreur portent alors sur la valeur
 * PRÉPARÉE — c'est elle qu'on élague, puis qu'on valide avec `X` seul.
 */
export function splitPipe(schema: ZodType): { pre: ZodType | null; main: ZodType } {
  const d = (schema as unknown as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
  if (d?.type === 'pipe') {
    const inDef = (d.in as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
    if (inDef?.type === 'transform') return { pre: d.in as ZodType, main: d.out as ZodType };
  }
  return { pre: null, main: schema };
}

export interface PruneResult {
  value: unknown;
  success: boolean;
  data?: unknown;
  pruned: number;
  /** Dernière erreur de validation (si échec). */
  error?: import('zod').ZodError;
}

/**
 * Élagage itératif des champs facultatifs et éléments de liste invalides,
 * jusqu'à validité (au plus `maxRounds` passes).
 */
export function pruneInvalidFields(
  value: unknown, schema: ZodType, report: OutputRepairStep[],
  options: { protectedKeys?: string[]; maxRounds?: number } = {},
): PruneResult {
  const root = describe(schema);
  const protegees = new Set(options.protectedKeys ?? []);
  let cur = structuredClone(value);
  let pruned = 0;
  for (let round = 0; round < (options.maxRounds ?? 8); round++) {
    const r = schema.safeParse(cur);
    if (r.success) return { value: cur, success: true, data: r.data, pruned };
    const deletions: Array<{ parent: PropertyKey[]; key: string }> = [];
    const removals = new Map<string, { path: PropertyKey[]; indices: Set<number> }>();
    for (const issue of r.error.issues) {
      const path = issue.path as PropertyKey[];
      for (let len = path.length; len > 0; len--) {
        const sub = path.slice(0, len);
        const parentPath = sub.slice(0, -1);
        const key = sub[len - 1];
        const parentVal = valueAt(cur, parentPath);
        if (typeof key === 'number' && Array.isArray(parentVal)) {
          const arr = descAt(root, parentPath, cur);
          if (arr?.node.kind === 'array') {
            const k = JSON.stringify(parentPath);
            const entry = removals.get(k) ?? { path: parentPath, indices: new Set<number>() };
            if (entry.indices.has(key)) break;
            const restants = parentVal.length - entry.indices.size - 1;
            if (arr.node.min === null || restants >= arr.node.min) {
              entry.indices.add(key);
              removals.set(k, entry);
              report.push({
                stage: 'field_pruning', rule: 'array_element_pruned', path: genericPath(jsonPath(sub)),
                detail: redact(issue.message).slice(0, 200),
              });
              break;
            }
          }
          continue;
        }
        if (typeof key === 'string' && isObj(parentVal) && !(len === 1 && protegees.has(key))) {
          const parent = descAt(root, parentPath, cur);
          const f = parent?.node.kind === 'object' ? parent.node.shape[key] : undefined;
          if (f?.optional && key in parentVal) {
            if (deletions.some((x) => x.key === key && JSON.stringify(x.parent) === JSON.stringify(parentPath))) break;
            deletions.push({ parent: parentPath, key });
            report.push({
              stage: 'field_pruning', rule: 'field_pruned_invalid', path: genericPath(jsonPath(sub)),
              detail: redact(issue.message).slice(0, 200),
            });
            break;
          }
        }
      }
    }
    if (deletions.length === 0 && removals.size === 0) return { value: cur, success: false, pruned, error: r.error };
    for (const d of deletions) {
      const p = valueAt(cur, d.parent);
      if (isObj(p) && d.key in p) { delete p[d.key]; pruned++; }
    }
    // Retraits d'éléments : indices décroissants, liste par liste.
    for (const { path, indices } of removals.values()) {
      const arr = valueAt(cur, path);
      if (!Array.isArray(arr)) continue;
      for (const i of [...indices].sort((a, b) => b - a)) { if (i < arr.length) { arr.splice(i, 1); pruned++; } }
    }
    cur = structuredClone(cur);
  }
  const last = schema.safeParse(cur);
  return last.success
    ? { value: cur, success: true, data: last.data, pruned }
    : { value: cur, success: false, pruned, error: last.error };
}
