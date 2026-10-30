/**
 * Lot 100B — TESTS DE MUTATION des oracles (ticket #601, partie 1/5) — PUR.
 *
 * Pour chaque fait crucial d'un oracle, une sortie de référence CORRECTE est
 * altérée de façon ciblée ; l'oracle doit REJETER chaque variante erronée :
 *   · montant faux, omission, contradiction, mauvais bien, source inventée,
 *     mauvais statut ;
 * et ACCEPTER les variantes correctes équivalentes :
 *   · ordre des éléments différent, montant réécrit dans un autre format,
 *     valeur équivalente déclarée par l'oracle.
 * Une mutation non applicable (pas d'occurrence à altérer, aucune source
 * déclarée…) est signalée comme telle, jamais comptée réussie.
 *
 * La sortie de référence est la sortie ENREGISTRÉE du cas (rôle « réponse »)
 * qui passe l'oracle ; elle sert à éprouver l'oracle, jamais à l'établir.
 */
import { amountEur, evaluateOracle, norm, toIsoDate } from './oracle';
import type { Oracle, OracleFact } from './model';

export const MUTATIONS = ['WRONG_AMOUNT', 'OMISSION', 'CONTRADICTION', 'WRONG_ENTITY', 'INVENTED_SOURCE', 'WRONG_STATUS'] as const;
export const EQUIVALENTS = ['REORDERED', 'REFORMATTED_AMOUNT', 'DECLARED_EQUIVALENT'] as const;
export type MutationKind = (typeof MUTATIONS)[number] | (typeof EQUIVALENTS)[number];

export const MUTATION_LABELS: Readonly<Record<MutationKind, string>> = {
  WRONG_AMOUNT: 'montant faux', OMISSION: 'omission', CONTRADICTION: 'contradiction', WRONG_ENTITY: 'mauvais bien',
  INVENTED_SOURCE: 'source inventée', WRONG_STATUS: 'mauvais statut',
  REORDERED: 'réponse équivalente (ordre)', REFORMATTED_AMOUNT: 'réponse équivalente (format du montant)', DECLARED_EQUIVALENT: 'réponse équivalente (valeur déclarée équivalente)',
};

export interface MutationRow {
  caseId: string;
  fact: string;
  mutation: MutationKind;
  expected: 'REJECT' | 'ACCEPT';
  outcome: 'REJECTED' | 'ACCEPTED' | 'NOT_APPLICABLE';
  /** Le comportement de l'oracle est celui attendu. */
  ok: boolean;
  detail: string;
}

export interface MutationReport {
  caseId: string;
  referencePasses: boolean;
  rows: MutationRow[];
  summary: { applicable: number; ok: number; failed: number; notApplicable: number };
}

type Json = unknown;
const clone = <T>(v: T): T => structuredClone(v);

/** Visite toutes les feuilles ; `edit` rend la nouvelle valeur (ou `undefined` : inchangée ; `DELETE` : suppression). */
const DELETE = Symbol('delete');
function mapLeaves(v: Json, edit: (leaf: unknown, key: string) => unknown | typeof DELETE): { value: Json; changed: number } {
  let changed = 0;
  const rec = (x: Json, key: string): Json | typeof DELETE => {
    if (Array.isArray(x)) {
      const out: Json[] = [];
      for (const e of x) {
        const r = rec(e, key);
        if (r === DELETE) { changed += 1; continue; }
        out.push(r);
      }
      return out;
    }
    if (x && typeof x === 'object') {
      const out: Record<string, Json> = {};
      for (const [k, e] of Object.entries(x as Record<string, Json>)) {
        const r = rec(e, k);
        if (r === DELETE) { changed += 1; continue; }
        out[k] = r;
      }
      return out;
    }
    const r = edit(x, key);
    if (r === DELETE) return DELETE;
    if (r !== undefined && r !== x) { changed += 1; return r as Json; }
    return x;
  };
  const value = rec(v, '');
  return { value: value === DELETE ? null : value, changed };
}

/** La feuille porte-t-elle la valeur du fait ? */
function leafMatches(f: OracleFact, leaf: unknown, key: string): boolean {
  if (f.kind === 'AMOUNT') {
    const cible = amountEur(f.value, f.unit ?? null);
    if (cible == null) return false;
    if (typeof leaf === 'number') return /cents|minor/i.test(key) ? leaf / 100 === cible : leaf === cible;
    if (typeof leaf === 'string') return norm(leaf).includes(norm(frAmount(cible)).replace(' €', '')) || amountEur(leaf) === cible;
    return false;
  }
  if (f.kind === 'DATE') return typeof leaf === 'string' && (toIsoDate(leaf) === toIsoDate(f.value) || leaf.includes(String(f.value)));
  if (typeof leaf === 'string' || typeof leaf === 'number' || typeof leaf === 'boolean') return norm(String(leaf)) === norm(String(f.value)) || (f.kind === 'TEXT' && typeof leaf === 'string' && norm(leaf).includes(norm(String(f.value))));
  return false;
}

/** « 18 500,00 € ». */
function frAmount(eur: number): string {
  const [e, c] = eur.toFixed(2).split('.');
  return `${e.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${c} €`;
}

function wrongValue(f: OracleFact, leaf: unknown, key: string): unknown {
  if (f.kind === 'AMOUNT') {
    if (typeof leaf === 'number') return /cents|minor/i.test(key) ? leaf + 4500 : leaf + 45;
    if (typeof leaf === 'string') { const c = amountEur(f.value, f.unit ?? null)!; return leaf.replace(/\d[\d\s  .,]*/, frAmount(c + 45).replace(' €', '')); }
  }
  if (f.kind === 'DATE' && typeof leaf === 'string') { const d = toIsoDate(leaf) ?? String(f.value); return `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`; }
  if (typeof leaf === 'number') return leaf + 1;
  if (typeof leaf === 'boolean') return !leaf;
  return `${String(leaf)} (mutation)`;
}

/** Supprime les éléments de tableau qui portent la valeur (omission « propre » : le reste de la sortie est intact). */
function removeHolders(v: Json, f: OracleFact): { value: Json; changed: number } {
  let changed = 0;
  const porte = (x: Json): boolean => {
    let hit = false;
    mapLeaves(x, (leaf, key) => { if (leafMatches(f, leaf, key)) hit = true; return undefined; });
    return hit;
  };
  const rec = (x: Json): Json => {
    if (Array.isArray(x)) {
      const out = x.filter((e) => {
        if (e && typeof e === 'object' && porte(e)) { changed += 1; return false; }
        return true;
      });
      return out.map(rec);
    }
    if (x && typeof x === 'object') {
      const out: Record<string, Json> = {};
      for (const [k, e] of Object.entries(x as Record<string, Json>)) {
        // Champ scalaire ou méta-champ ({ value, evidence }) porteur : retiré.
        if ((e !== null && typeof e !== 'object' && leafMatches(f, e, k)) || (e && typeof e === 'object' && !Array.isArray(e) && 'value' in (e as object) && leafMatches(f, (e as { value: unknown }).value, k))) { changed += 1; continue; }
        out[k] = rec(e);
      }
      return out;
    }
    return x;
  };
  const value = rec(v);
  // Restes (texte libre) : la valeur effacée du texte.
  const r = mapLeaves(value, (leaf, key) => (typeof leaf === 'string' && leafMatches(f, leaf, key) ? '(information non reprise)' : undefined));
  return { value: r.value, changed: changed + r.changed };
}

/** Duplique le premier élément de tableau porteur avec une valeur contradictoire. */
function contradict(v: Json, f: OracleFact): { value: Json; changed: number } {
  let done = false;
  const rec = (x: Json): Json => {
    if (Array.isArray(x)) {
      const out: Json[] = [];
      for (const e of x) {
        out.push(rec(e));
        if (!done && e && typeof e === 'object') {
          let hit = false;
          const m = mapLeaves(e, (leaf, key) => { if (leafMatches(f, leaf, key)) { hit = true; return wrongValue(f, leaf, key); } return undefined; });
          if (hit) { out.push(m.value); done = true; }
        }
      }
      return out;
    }
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x as Record<string, Json>).map(([k, e]) => [k, rec(e)]));
    return x;
  };
  const value = rec(v);
  return { value, changed: done ? 1 : 0 };
}

function reverseArrays(v: Json): Json {
  if (Array.isArray(v)) return [...v].reverse().map(reverseArrays);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, Json>).map(([k, e]) => [k, reverseArrays(e)]));
  return v;
}

/**
 * Suite de mutations d'un cas (pure). `reference` : sortie correcte (passe
 * l'oracle). Rapport ligne par ligne : chaque mutation attendue rejetée,
 * chaque variante équivalente acceptée.
 */
export function runMutationSuite(caseId: string, oracle: Oracle, reference: unknown): MutationReport {
  const rows: MutationRow[] = [];
  const base = evaluateOracle(oracle, reference);
  const referencePasses = base.defects.length === 0;
  const judge = (fact: string, mutation: MutationKind, mutated: { value: Json; changed: number } | null, why?: string) => {
    const expected: MutationRow['expected'] = (MUTATIONS as readonly string[]).includes(mutation) ? 'REJECT' : 'ACCEPT';
    if (!mutated || mutated.changed === 0) {
      rows.push({ caseId, fact, mutation, expected, outcome: 'NOT_APPLICABLE', ok: false, detail: why ?? 'aucune occurrence à altérer dans la sortie de référence' });
      return;
    }
    const r = evaluateOracle(oracle, mutated.value);
    const outcome = r.defects.length ? 'REJECTED' : 'ACCEPTED';
    rows.push({
      caseId, fact, mutation, expected, outcome,
      ok: (expected === 'REJECT') === (outcome === 'REJECTED'),
      detail: r.defects.length ? r.defects.slice(0, 2).map((d) => d.message).join(' ; ') : 'aucun défaut relevé',
    });
  };
  if (!referencePasses) {
    rows.push({ caseId, fact: '*', mutation: 'OMISSION', expected: 'REJECT', outcome: 'NOT_APPLICABLE', ok: false, detail: `sortie de référence en échec (${base.defects[0]?.message ?? '?'}) : mutations non mesurables` });
    return { caseId, referencePasses, rows, summary: summarize(rows) };
  }
  for (const f of oracle.requiredFacts.filter((x) => x.critical)) {
    if (f.kind === 'AMOUNT' || f.kind === 'DATE' || f.kind === 'NUMBER' || f.kind === 'TEXT' || f.kind === 'IDENTIFIER') {
      judge(f.key, 'WRONG_AMOUNT', f.kind === 'AMOUNT' ? mapLeaves(clone(reference), (leaf, key) => (leafMatches(f, leaf, key) ? wrongValue(f, leaf, key) : undefined)) : null,
        f.kind === 'AMOUNT' ? undefined : 'fait non monétaire');
    }
    judge(f.key, 'OMISSION', removeHolders(clone(reference), f));
    if (f.kind === 'AMOUNT' || f.kind === 'DATE' || f.kind === 'BOOLEAN') judge(f.key, 'CONTRADICTION', contradict(clone(reference), f), 'fait hors tableau : contradiction non constructible');
    if (f.kind === 'STATUS') {
      const autre = oracle.decisions.forbidden[0] ?? 'MUTATION_STATUT';
      judge(f.key, 'WRONG_STATUS', mapLeaves(clone(reference), (leaf, key) => (leafMatches(f, leaf, key) ? autre : undefined)));
    }
    if (f.kind === 'AMOUNT') {
      // Équivalent : montant numérique réécrit en texte français dans un champ texte voisin → toujours accepté si la valeur reste.
      judge(f.key, 'REFORMATTED_AMOUNT', mapLeaves(clone(reference), (leaf, key) => (typeof leaf === 'string' && leafMatches(f, leaf, key) ? leaf.replace(/(\d[\d\s  .,]*\d)\s*€/, (_m, n: string) => `${amountEur(n)!.toFixed(2)} EUR`) : undefined)),
        'montant porté seulement par un champ numérique');
    }
    const eq = oracle.equivalences.find((e) => e.key === f.key)?.values.find((v) => norm(String(v)) !== norm(String(f.value)));
    if (eq !== undefined) judge(f.key, 'DECLARED_EQUIVALENT', mapLeaves(clone(reference), (leaf, key) => (leafMatches(f, leaf, key) && typeof leaf === typeof eq ? eq : undefined)));
  }
  // Entité : mauvais bien.
  for (const id of oracle.entities.expected) {
    const remplacant = oracle.entities.forbidden[0] ?? (typeof id === 'number' ? id + 100_000 : `${id}-autre`);
    judge(`entité ${String(id)}`, 'WRONG_ENTITY', mapLeaves(clone(reference), (leaf) => (String(leaf) === String(id) ? (typeof leaf === 'number' ? Number(remplacant) : String(remplacant)) : undefined)));
  }
  // Décision : mauvais statut.
  if (oracle.decisions.allowed.length) {
    const autre = oracle.decisions.forbidden[0] ?? 'MUTATION_STATUT';
    judge('décision', 'WRONG_STATUS', mapLeaves(clone(reference), (leaf) => (typeof leaf === 'string' && oracle.decisions.allowed.some((a) => norm(a) === norm(leaf)) ? autre : undefined)));
  }
  // Source inventée.
  if (oracle.allowedSources.length) {
    let added = 0;
    const ajout = (x: Json, key: string): Json => {
      if (Array.isArray(x)) {
        if (!added && /^(sourceIds|source_ids|evidenceIds|sources)$/.test(key)) { added = 1; return [...x, 'source-inventee:mutation']; }
        return x.map((e) => ajout(e, key));
      }
      if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x as Record<string, Json>).map(([k, e]) => [k, ajout(e, k)]));
      return x;
    };
    const v = ajout(clone(reference), '');
    judge('sources', 'INVENTED_SOURCE', { value: v, changed: added }, 'aucune liste de sources citées dans la sortie');
  } else {
    rows.push({ caseId, fact: 'sources', mutation: 'INVENTED_SOURCE', expected: 'REJECT', outcome: 'NOT_APPLICABLE', ok: false, detail: 'oracle sans sources autorisées déclarées' });
  }
  // Équivalent : ordre des éléments.
  judge('*', 'REORDERED', { value: reverseArrays(clone(reference)), changed: 1 });
  return { caseId, referencePasses, rows, summary: summarize(rows) };
}

function summarize(rows: MutationRow[]): MutationReport['summary'] {
  const applicables = rows.filter((r) => r.outcome !== 'NOT_APPLICABLE');
  return { applicable: applicables.length, ok: applicables.filter((r) => r.ok).length, failed: applicables.filter((r) => !r.ok).length, notApplicable: rows.length - applicables.length };
}

/** Une mutation attendue rejetée a été acceptée (oracle trop faible) ou une réponse équivalente refusée (oracle trop strict). */
export function mutationFailures(reports: readonly MutationReport[]): MutationRow[] {
  return reports.flatMap((r) => r.rows.filter((x) => x.outcome !== 'NOT_APPLICABLE' && !x.ok));
}
