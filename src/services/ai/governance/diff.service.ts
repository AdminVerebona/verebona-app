/**
 * Production du diff — CDC §4.5.3.
 *
 * « L'aperçu des modifications doit être affiché avant validation. »
 *
 * FONCTION PURE. Un diff ligne à ligne suffit pour un prompt : ce sont des
 * textes courts, structurés en règles numérotées, et l'administrateur doit
 * pouvoir juger d'un coup d'œil ce que le modèle propose de changer.
 */
export type DiffOp = 'equal' | 'added' | 'removed';

export interface DiffLine {
  op: DiffOp;
  /** Numéro de ligne dans la version d'origine, null pour un ajout. */
  baseLine: number | null;
  /** Numéro de ligne dans la version candidate, null pour une suppression. */
  candidateLine: number | null;
  text: string;
}

export interface DiffSummary {
  lines: DiffLine[];
  added: number;
  removed: number;
  unchanged: number;
  /** true si la proposition ne change rien — cas à refuser d'emblée. */
  identical: boolean;
}

export function computeDiff(base: string, candidate: string): DiffSummary {
  const a = base.split('\n');
  const b = candidate.split('\n');
  const lcs = longestCommonSubsequence(a, b);

  const lines: DiffLine[] = [];
  let i = 0, j = 0, k = 0;

  while (i < a.length || j < b.length) {
    if (k < lcs.length && i < a.length && j < b.length && a[i] === lcs[k] && b[j] === lcs[k]) {
      lines.push({ op: 'equal', baseLine: i + 1, candidateLine: j + 1, text: a[i] });
      i++; j++; k++;
      continue;
    }
    if (i < a.length && (k >= lcs.length || a[i] !== lcs[k])) {
      lines.push({ op: 'removed', baseLine: i + 1, candidateLine: null, text: a[i] });
      i++;
      continue;
    }
    if (j < b.length) {
      lines.push({ op: 'added', baseLine: null, candidateLine: j + 1, text: b[j] });
      j++;
    }
  }

  const added = lines.filter((l) => l.op === 'added').length;
  const removed = lines.filter((l) => l.op === 'removed').length;

  return {
    lines,
    added,
    removed,
    unchanged: lines.length - added - removed,
    identical: added === 0 && removed === 0,
  };
}

function longestCommonSubsequence(a: string[], b: string[]): string[] {
  const m = a.length, n = b.length;
  const table: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const result: string[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { result.push(a[i]); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) i++;
    else j++;
  }
  return result;
}

/** Rendu textuel du diff, pour journalisation et courriel de validation. */
export function renderDiff(diff: DiffSummary): string {
  return diff.lines
    .filter((l) => l.op !== 'equal')
    .map((l) => `${l.op === 'added' ? '+' : '-'} ${l.text}`)
    .join('\n');
}
