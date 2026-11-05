/**
 * T3 DOCUMENT_NAMING — DÉPENDANCES DE CONTEXTE COLLECTIF (lot 111A, ticket
 * « T3 nommage — angles morts E1 à E4 », E1). Pure.
 *
 * Un examen IA ne dépend pas que du document examiné : il lit la composition
 * de la famille, les documents de référence et les conventions. Le lot 76B
 * (C3) ne comparait, à la reprise, que l'empreinte de chaque document déjà
 * examiné et ne propageait qu'aux familles décrites par l'IA. Ce module :
 *
 *   · `dependencySnapshot` — mémorise, pour chaque document du lot vu par
 *     l'examen en cours, sa famille de code (`familyKeyOf`, hachée) et
 *     l'empreinte de ses DONNÉES (hors nom) : composition, références et
 *     éléments déterminants effectivement vus ;
 *   · `impactedByContext` — à la reprise : documents ajoutés, retirés ou
 *     déplacés, données modifiées (y compris d'un document seulement vu en
 *     RÉFÉRENCE) → familles impactées. Famille de l'IA (conventions) quand
 *     elle couvre le document ; à défaut (conventions absentes ou
 *     partielles), famille de code. Seuls les membres DÉJÀ EXAMINÉS de ces
 *     familles sont réinscrits ; les autres examens restent acquis ;
 *   · `freshSinceReview` — documents nouveaux ou modifiés depuis le dernier
 *     examen complet : jamais écartés par le préfiltre « titres conformes » ;
 *   · `extendToImpactedFamilies` — réexamen d'un lot volumineux : la famille
 *     d'un document nouveau / modifié / retiré est réexaminée avec lui.
 *
 * BORNE : une famille de code impactée n'est réinscrite que si ses membres à
 * réexaminer tiennent dans un appel (`maxFamily`) — sinon le document nouveau
 * est examiné avec les membres de sa famille en RÉFÉRENCE (convention lue),
 * et la famille trop grande est COMPTÉE (signalée au rapport) : jamais de
 * réexamen global systématique, jamais de boucle sur une famille volumineuse
 * alimentée en continu.
 */
import { createHash } from 'node:crypto';
import { documentFingerprint, docSnapshotHash, isProtected, type NamingDoc } from './context';
import { familyKeyOf } from './adaptive';

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** Famille de code d'un document (hachée, 6 caractères). */
export const familyHash = (d: NamingDoc): string => sha(familyKeyOf(d)).slice(0, 6);
/** Empreinte des DONNÉES d'un document (hors nom) — même formule que la première partie de `examinedContextHash`. */
export const dataHash = (d: NamingDoc): string => sha([isProtected(d), documentFingerprint(d)]).slice(0, 12);

/** Dépendances mémorisées dans la progression : identifiant → `famille:données`. */
export type DependencySnapshot = Record<string, string>;

/** Composition vue par l'examen (pure) : chaque document du lot, sa famille et ses données. */
export function dependencySnapshot(docs: readonly NamingDoc[]): DependencySnapshot {
  return Object.fromEntries(docs.map((d) => [String(d.id), `${familyHash(d)}:${dataHash(d)}`]));
}

/** Familles décrites par l'IA (conventions mémorisées) : identifiants des documents. */
export function conventionFamilies(conventions: readonly unknown[]): number[][] {
  return conventions
    .map((x) => (x && typeof x === 'object' && Array.isArray((x as { documentIds?: unknown }).documentIds) ? ((x as { documentIds: unknown[] }).documentIds).map(Number) : []))
    .filter((l) => l.length > 0);
}

export interface ContextImpact {
  /** Documents déjà examinés à réinscrire (familles impactées). */
  reexamine: number[];
  /** Origine de l'impact. */
  added: number[];
  removed: number[];
  changed: number[];
  /** Familles impactées (IA ou code) et familles de code trop grandes pour être réexaminées (signalées). */
  families: number;
  familiesTooLarge: number;
}

/**
 * Familles impactées par des documents ajoutés / retirés / modifiés (pure) :
 * membres DÉJÀ EXAMINÉS à réinscrire. `changed` : documents dont les données
 * ont changé (examinés ou vus en référence) ; `removedFamilies` : famille de
 * code mémorisée des documents retirés.
 */
function impactedMembers(p: {
  docs: readonly NamingDoc[];
  examined: ReadonlySet<number>;
  conventions: readonly unknown[];
  sources: ReadonlyArray<{ id: number; families: string[] }>;
  maxFamily: number;
}): { reexamine: Set<number>; families: number; familiesTooLarge: number } {
  const ia = conventionFamilies(p.conventions);
  const couverts = new Set(ia.flat());
  const reexamine = new Set<number>();
  let families = 0;
  let familiesTooLarge = 0;
  // Familles de l'IA contenant une source : tous leurs membres examinés (décision de convention du modèle).
  for (const fam of ia) {
    if (!p.sources.some((s) => fam.includes(s.id))) continue;
    families++;
    for (const x of fam) if (p.examined.has(x)) reexamine.add(x);
  }
  // Sources non couvertes par une famille de l'IA : famille de code (convention absente ou partielle).
  const codes = new Set<string>();
  for (const s of p.sources) if (!couverts.has(s.id)) for (const f of s.families) codes.add(f);
  for (const f of codes) {
    const membres = p.docs.filter((d) => p.examined.has(d.id) && familyHash(d) === f).map((d) => d.id);
    if (!membres.length) continue;
    families++;
    if (membres.length > p.maxFamily) { familiesTooLarge++; continue; }
    for (const x of membres) reexamine.add(x);
  }
  return { reexamine, families, familiesTooLarge };
}

/**
 * E1 — impact du contexte collectif à la reprise (pure). `deps` : composition
 * mémorisée par l'examen interrompu (absente : progression antérieure au lot
 * 111A — seules les données des documents examinés sont comparées).
 * `dataChanged` : documents examinés dont les données ont changé (C3).
 */
export function impactedByContext(p: {
  docs: readonly NamingDoc[];
  examined: readonly number[];
  deps: DependencySnapshot | null | undefined;
  dataChanged: readonly number[];
  conventions: readonly unknown[];
  maxFamily: number;
}): ContextImpact {
  const parId = new Map(p.docs.map((d) => [d.id, d]));
  const added: number[] = [];
  const removed: number[] = [];
  const changed = new Set<number>();
  const sources: Array<{ id: number; families: string[] }> = [];
  if (p.deps) {
    for (const [k, v] of Object.entries(p.deps)) {
      const id = Number(k);
      const [fam, donnees] = v.split(':');
      const d = parId.get(id);
      if (!d) { removed.push(id); sources.push({ id, families: [fam] }); continue; }
      if (dataHash(d) !== donnees) { changed.add(id); sources.push({ id, families: [...new Set([fam, familyHash(d)])] }); }
    }
    for (const d of p.docs) if (!(String(d.id) in p.deps)) { added.push(d.id); sources.push({ id: d.id, families: [familyHash(d)] }); }
  }
  for (const id of p.dataChanged) {
    const d = parId.get(id);
    if (!d || changed.has(id)) continue;
    changed.add(id);
    sources.push({ id, families: [familyHash(d)] });
  }
  const examines = new Set(p.examined.filter((id) => parId.has(id)));
  const r = impactedMembers({ docs: p.docs, examined: examines, conventions: p.conventions, sources, maxFamily: p.maxFamily });
  return {
    reexamine: [...r.reexamine].sort((a, b) => a - b), added: added.sort((a, b) => a - b), removed: removed.sort((a, b) => a - b),
    changed: [...changed].sort((a, b) => a - b), families: r.families, familiesTooLarge: r.familiesTooLarge,
  };
}

/**
 * E1 — documents NOUVEAUX ou MODIFIÉS depuis le dernier examen complet
 * (pure) : absents de l'instantané ou d'empreinte différente, plus `extra`
 * (réinscrits par la revalidation). Sans instantané (premier examen) : seuls
 * `extra` (le préfiltre du lot 109J s'applique au stock jamais examiné).
 * `all` : tout le lot (réexamen « contexte enrichi » attendu, C5).
 */
export function freshSinceReview(docs: readonly NamingDoc[], snapshot: Readonly<Record<string, string>> | null, opts: { extra?: Iterable<number>; all?: boolean } = {}): Set<number> {
  if (opts.all) return new Set(docs.map((d) => d.id));
  const out = new Set<number>(opts.extra ?? []);
  if (snapshot) for (const d of docs) if (snapshot[String(d.id)] !== docSnapshotHash(d)) out.add(d.id);
  return out;
}

/**
 * E1 — réexamen d'un lot VOLUMINEUX (pure) : aux documents nouveaux /
 * modifiés (`targets`, issus de `reviewTargets`), ajoute les membres non
 * modifiés de leur famille (IA si elle les couvre, sinon de code), et la
 * famille de l'IA d'un document retiré — dans la borne `maxFamily`.
 */
export function extendToImpactedFamilies(p: {
  docs: readonly NamingDoc[];
  targets: readonly NamingDoc[];
  snapshot: Readonly<Record<string, string>> | null;
  conventions: readonly unknown[];
  maxFamily: number;
}): { targets: NamingDoc[]; added: number[]; familiesTooLarge: number } {
  if (!p.snapshot || !p.targets.length && !Object.keys(p.snapshot).some((k) => !p.docs.some((d) => String(d.id) === k))) {
    return { targets: [...p.targets], added: [], familiesTooLarge: 0 };
  }
  const ids = new Set(p.docs.map((d) => d.id));
  const cibles = new Set(p.targets.map((d) => d.id));
  const sources: Array<{ id: number; families: string[] }> = [
    ...p.targets.map((d) => ({ id: d.id, families: [familyHash(d)] })),
    // Document retiré : sa famille de code n'est pas connue de l'instantané — seule une famille de l'IA le situe.
    ...Object.keys(p.snapshot).map(Number).filter((id) => !ids.has(id)).map((id) => ({ id, families: [] as string[] })),
  ];
  const nonModifies = new Set(p.docs.filter((d) => !cibles.has(d.id)).map((d) => d.id));
  const r = impactedMembers({ docs: p.docs, examined: nonModifies, conventions: p.conventions, sources, maxFamily: p.maxFamily });
  const added = [...r.reexamine].sort((a, b) => a - b);
  const plus = new Set(added);
  return { targets: p.docs.filter((d) => cibles.has(d.id) || plus.has(d.id)), added, familiesTooLarge: r.familiesTooLarge };
}
