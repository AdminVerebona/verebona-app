/**
 * Lot 87B (CODE-10) — VALIDATION d'une décision T4 de représentation Agenda.
 * PURE.
 *
 * Une réponse invalide est REFUSÉE EN BLOC (aucune mutation, décision tracée
 * avec ses motifs) et n'est JAMAIS remplacée par une heuristique du code :
 *   · sortie hors schéma ;
 *   · référence inexistante (élément, élément restaurable) ou hors du
 *     périmètre à décider ;
 *   · contradiction interne : un élément dans plusieurs occurrences, une
 *     restauration répétée, plusieurs principaux, `keep` hors de son
 *     occurrence, abstention accompagnée de décisions ;
 *   · décision incomplète : un élément à décider absent de la réponse.
 * Les PROTECTIONS (objet de l'utilisateur, autre Opération…) ne rendent pas
 * la réponse invalide : la mutation concernée est refusée et tracée
 * (`plan.ts`), les autres restent applicables si elles sont indépendantes.
 */
import { T4AgendaRepresentationOutput, type ValidationIssue } from './contract';
import type { RepresentationScope } from './context';

interface ValidationProblem { issue: ValidationIssue; detail: string }

export type ValidationResult =
  | { ok: true; decision: T4AgendaRepresentationOutput }
  | { ok: false; problems: ValidationProblem[] };

export function validateRepresentation(output: unknown, scope: RepresentationScope): ValidationResult {
  const parsed = T4AgendaRepresentationOutput.safeParse(output);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.slice(0, 10).map((i) => ({ issue: 'SCHEMA' as const, detail: `${i.path.join('.') || '(racine)'} : ${i.message}`.slice(0, 200) })) };
  }
  const v = parsed.data;
  const problems: ValidationProblem[] = [];
  const parRef = new Map(scope.items.map((i) => [i.ref, i]));
  const restRefs = new Set(scope.restorables.map((r) => r.ref));
  const vus = new Map<string, number>();

  if (v.outcome === 'ABSTAIN') return { ok: true, decision: v };

  v.occurrences.forEach((o, k) => {
    if (!o.items.includes(o.keep)) problems.push({ issue: 'KEEP_NOT_IN_ITEMS', detail: `occurrence ${k} : ${o.keep}` });
    for (const ref of o.items) {
      const it = parRef.get(ref);
      if (!it) { problems.push({ issue: 'UNKNOWN_REFERENCE', detail: `élément ${ref}` }); continue; }
      if (!it.inScope) { problems.push({ issue: 'OUT_OF_SCOPE_REFERENCE', detail: `élément ${ref} (contexte seulement)` }); continue; }
      if (vus.has(ref)) problems.push({ issue: 'ITEM_IN_SEVERAL_OCCURRENCES', detail: `élément ${ref} (occurrences ${vus.get(ref)} et ${k})` });
      else vus.set(ref, k);
    }
  });
  const restaurees = new Set<string>();
  for (const r of v.restorations) {
    if (!restRefs.has(r.restore)) { problems.push({ issue: 'UNKNOWN_REFERENCE', detail: `restaurable ${r.restore}` }); continue; }
    if (restaurees.has(r.restore)) problems.push({ issue: 'RESTORATION_REPEATED', detail: r.restore });
    restaurees.add(r.restore);
  }
  const principaux = v.occurrences.filter((o) => o.role === 'PRINCIPAL').length + v.restorations.filter((r) => r.role === 'PRINCIPAL').length;
  if (principaux > 1) problems.push({ issue: 'SEVERAL_PRINCIPALS', detail: `${principaux} principaux` });
  for (const it of scope.items.filter((i) => i.inScope)) {
    if (!vus.has(it.ref)) problems.push({ issue: 'ITEM_NOT_DECIDED', detail: `élément ${it.ref}` });
  }
  if (v.identityConcern) {
    for (const ref of v.identityConcern.items) if (!parRef.has(ref)) problems.push({ issue: 'UNKNOWN_REFERENCE', detail: `élément ${ref} (identité)` });
    const op = v.identityConcern.operation;
    if (op && !(op in scope.operations)) problems.push({ issue: 'UNKNOWN_REFERENCE', detail: `Opération ${op}` });
  }
  return problems.length ? { ok: false, problems } : { ok: true, decision: v };
}
