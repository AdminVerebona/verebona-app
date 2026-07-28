/**
 * Détection de doublon — CDC §4.4.3 étape 3 et §4.4.4.
 *
 * « Un doublon certain ne doit jamais être recréé. »
 * Non-régression §11.4 : « aucun doublon d'agenda n'est créé ».
 *
 * DÉTERMINISTE, sans appel modèle. Le rapprochement repose sur le champ
 * d'origine puis sur la proximité de date et de libellé — un modèle
 * n'apporterait ici qu'une source d'imprévisibilité.
 */
import type { ExistingAgendaItem } from './types';

/** Tolérance de date pour deux événements portant sur la même échéance. */
const DATE_TOLERANCE_DAYS = 3;
/** Similarité de titre au-delà de laquelle deux libellés désignent la même chose. */
const TITLE_SIMILARITY_THRESHOLD = 0.82;

export type DuplicateKind = 'exact' | 'probable' | 'none';

export interface DuplicateMatch {
  kind: DuplicateKind;
  item: ExistingAgendaItem | null;
  reason: string;
}

export function findDuplicate(
  candidate: { title: string; date: string; originFieldKey?: string },
  existing: ExistingAgendaItem[],
): DuplicateMatch {
  // 1. Même champ d'origine et même date : doublon certain, sans ambiguïté.
  if (candidate.originFieldKey) {
    const sameOrigin = existing.find(
      (e) => e.originFieldKey === candidate.originFieldKey && e.date === candidate.date,
    );
    if (sameOrigin) {
      return { kind: 'exact', item: sameOrigin, reason: 'même champ d\'origine et même date' };
    }
  }

  // 2. Titre identique après normalisation et même date.
  const normalizedCandidate = normalizeTitle(candidate.title);
  const sameTitleAndDate = existing.find(
    (e) => normalizeTitle(e.title) === normalizedCandidate && e.date === candidate.date,
  );
  if (sameTitleAndDate) {
    return { kind: 'exact', item: sameTitleAndDate, reason: 'même intitulé et même date' };
  }

  // 3. Titre proche et date voisine : doublon probable, jamais tranché seul.
  for (const e of existing) {
    const dayGap = Math.abs(daysBetween(e.date, candidate.date));
    if (dayGap > DATE_TOLERANCE_DAYS) continue;

    const similarity = titleSimilarity(normalizeTitle(e.title), normalizedCandidate);
    if (similarity >= TITLE_SIMILARITY_THRESHOLD) {
      return {
        kind: 'probable',
        item: e,
        reason: `intitulé proche (${Math.round(similarity * 100)} %) et date à ${dayGap} jour(s)`,
      };
    }
  }

  return { kind: 'none', item: null, reason: 'aucun événement équivalent' };
}

function normalizeTitle(s: string): string {
  return s
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function daysBetween(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00Z`).getTime();
  const db = new Date(`${b}T00:00:00Z`).getTime();
  if (Number.isNaN(da) || Number.isNaN(db)) return Number.MAX_SAFE_INTEGER;
  return Math.round((da - db) / 86_400_000);
}

/**
 * Similarité par coefficient de Dice sur bigrammes de caractères.
 * Robuste aux abréviations et aux inversions de mots, contrairement à une
 * égalité stricte — « Contrôle technique Clio » et « Clio : contrôle technique »
 * doivent être reconnus comme le même événement.
 */
export function titleSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigrams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };

  const ba = bigrams(a);
  const bb = bigrams(b);
  let intersection = 0;
  for (const [g, count] of ba) {
    intersection += Math.min(count, bb.get(g) ?? 0);
  }

  const total = (a.length - 1) + (b.length - 1);
  return (2 * intersection) / total;
}
