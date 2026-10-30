/**
 * Lot 100B — PAIRES ADVERSARIALES (ticket #601, partie 2/5 ; recette 7) — PUR.
 *
 * Une paire = deux cas A et B qui ne diffèrent que par un élément
 * DISCRIMINANT. Exécution des DEUX côtés obligatoire ; l'échec ou l'absence
 * d'un côté INVALIDE la paire. On vérifie en plus que le discriminant change
 * la décision quand il le doit (`discriminantChangesDecision: true`), ou ne
 * la change pas quand ce n'est qu'une variation de présentation (`false`).
 */
import type { ManifestEntry } from './model';

export type SideOutcome = 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | 'NOT_RUN';

export interface PairSideResult {
  caseId: string;
  outcome: SideOutcome;
  /** Décisions lues sur la sortie (oracle) — comparaison A / B. */
  decisions: string[];
}

export type PairVerdict = 'VALID' | 'INVALID_SIDE_MISSING' | 'INVALID_SIDE_FAILED' | 'INVALID_SIDE_INCONCLUSIVE' | 'INVALID_DISCRIMINANT' | 'INCOMPLETE_DECLARATION';

export interface PairAssessment {
  pairId: string;
  a: string | null;
  b: string | null;
  verdict: PairVerdict;
  reason: string;
}

export const PAIR_VERDICT_LABELS: Readonly<Record<PairVerdict, string>> = {
  VALID: 'paire valide (A et B réussis, discriminant respecté)',
  INVALID_SIDE_MISSING: 'paire incomplète : un côté absent ou non exécuté',
  INVALID_SIDE_FAILED: 'paire invalide : un côté en échec',
  INVALID_SIDE_INCONCLUSIVE: 'paire non concluante : un côté non concluant',
  INVALID_DISCRIMINANT: 'paire invalide : le discriminant ne produit pas l’effet attendu sur la décision',
  INCOMPLETE_DECLARATION: 'paire mal déclarée (côtés en double ou déclarations divergentes)',
};

/** Paires déclarées dans le manifeste (une entrée par identifiant de paire). */
export function pairsOf(entries: readonly ManifestEntry[]): Map<string, ManifestEntry[]> {
  const m = new Map<string, ManifestEntry[]>();
  for (const e of entries) if (e.pair) m.set(e.pair.id, [...(m.get(e.pair.id) ?? []), e]);
  return m;
}

const same = (a: string[], b: string[]) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());

/** Évalue une paire (pur). `results` : résultat de chaque cas exécuté (identifiant du manifeste). */
export function assessPair(pairId: string, sides: readonly ManifestEntry[], results: ReadonlyMap<string, PairSideResult>): PairAssessment {
  const a = sides.filter((s) => s.pair?.side === 'A');
  const b = sides.filter((s) => s.pair?.side === 'B');
  if (a.length > 1 || b.length > 1 || (a[0] && b[0] && a[0].pair!.discriminantChangesDecision !== b[0].pair!.discriminantChangesDecision)) {
    return { pairId, a: a[0]?.id ?? null, b: b[0]?.id ?? null, verdict: 'INCOMPLETE_DECLARATION', reason: PAIR_VERDICT_LABELS.INCOMPLETE_DECLARATION };
  }
  const ea = a[0];
  const eb = b[0];
  const ra = ea ? results.get(ea.id) : undefined;
  const rb = eb ? results.get(eb.id) : undefined;
  const ids = { a: ea?.id ?? null, b: eb?.id ?? null };
  if (!ea || !eb || !ra || !rb || ra.outcome === 'NOT_RUN' || rb.outcome === 'NOT_RUN') {
    const manque = !ea ? 'côté A absent du corpus' : !eb ? 'côté B absent du corpus' : !ra || ra.outcome === 'NOT_RUN' ? `côté A (${ea.id}) non exécuté` : `côté B (${eb.id}) non exécuté`;
    return { pairId, ...ids, verdict: 'INVALID_SIDE_MISSING', reason: `${PAIR_VERDICT_LABELS.INVALID_SIDE_MISSING} — ${manque}` };
  }
  if (ra.outcome === 'FAILED' || rb.outcome === 'FAILED') {
    return { pairId, ...ids, verdict: 'INVALID_SIDE_FAILED', reason: `${PAIR_VERDICT_LABELS.INVALID_SIDE_FAILED} — ${ra.outcome === 'FAILED' ? `A (${ea.id})` : `B (${eb.id})`}` };
  }
  if (ra.outcome !== 'PASSED' || rb.outcome !== 'PASSED') {
    return { pairId, ...ids, verdict: 'INVALID_SIDE_INCONCLUSIVE', reason: `${PAIR_VERDICT_LABELS.INVALID_SIDE_INCONCLUSIVE} — ${ra.outcome !== 'PASSED' ? `A (${ea.id})` : `B (${eb.id})`}` };
  }
  const change = !same(ra.decisions, rb.decisions);
  const attendu = ea.pair!.discriminantChangesDecision;
  if (change !== attendu) {
    return {
      pairId, ...ids, verdict: 'INVALID_DISCRIMINANT',
      reason: `${PAIR_VERDICT_LABELS.INVALID_DISCRIMINANT} — ${attendu ? `décision identique des deux côtés (${ra.decisions.join(', ') || '—'}) alors que le discriminant doit la changer` : `décision changée (${ra.decisions.join(', ')} → ${rb.decisions.join(', ')}) par une simple variation de présentation`}`,
    };
  }
  return { pairId, ...ids, verdict: 'VALID', reason: PAIR_VERDICT_LABELS.VALID };
}

/** Toutes les paires du manifeste (dans le périmètre donné). */
export function assessPairs(entries: readonly ManifestEntry[], results: ReadonlyMap<string, PairSideResult>, scope?: (e: ManifestEntry) => boolean): PairAssessment[] {
  const out: PairAssessment[] = [];
  for (const [id, sides] of pairsOf(entries)) {
    if (scope && !sides.some(scope)) continue;
    out.push(assessPair(id, sides, results));
  }
  return out.sort((x, y) => x.pairId.localeCompare(y.pairId));
}
