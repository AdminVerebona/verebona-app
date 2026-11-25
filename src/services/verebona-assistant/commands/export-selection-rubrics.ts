/**
 * Carte #843 (E08) — rubrique documentaire désignée dans une demande d'export (« de la rubrique Assurances ») :
 * rapprochée des libellés du RÉFÉRENTIEL V2 (jamais un code inventé). Tous les mots demandés doivent figurer dans
 * le libellé de la rubrique ; un document répond si l'une de ses rubriques est l'une de celles-là.
 */
import { RUBRICS } from '@/lib/referential/v2';
import { plain } from '../core/routing-text';
import type { ExportDocumentRow } from './export-selection';

const mots = (s: string) => plain(s).split(/[^a-z0-9]+/).filter(Boolean);

export function rubricCodesFor(words: readonly string[]): string[] {
  return RUBRICS.filter((r) => {
    const libelle = mots(r.label);
    return words.length > 0 && words.every((w) => libelle.some((l) => l === w || (w.length >= 4 && l.startsWith(w.slice(0, -1)))));
  }).map((r) => r.code);
}

export function rubricMatcher(words: readonly string[]): (d: ExportDocumentRow) => boolean {
  const codes = new Set(rubricCodesFor(words));
  return (d) => d.rubricCodes.some((c) => codes.has(c));
}
