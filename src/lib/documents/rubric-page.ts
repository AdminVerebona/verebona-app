/**
 * Contrat de la page documents par Rubrique, partagé entre le serveur
 * (`rubric-query.service.ts`) et l'écran (`DocumentsByRubric`).
 *
 * Fichier sans dépendance serveur : l'écran peut l'importer sans embarquer
 * l'accès à la base.
 */
import { RUBRICS } from '@/lib/referential/v2/rubrics';
import type { RubricDefinition } from '@/lib/referential/v2/types';

/**
 * Rubriques à rendre dans la page.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN DOCUMENT CLASSÉ DOIT RESTER ATTEIGNABLE
 *
 * La visibilité des Rubriques dépend du périmètre (familles de biens, état
 * locatif, §3.3 et §6.2). Mais un document peut être classé dans une Rubrique
 * hors de ce périmètre (bien changé de famille, classement manuel, référentiel
 * modifié). Avec l'aperçu paginé, il n'apparaissait nulle part alors que le
 * total le comptait.
 *
 * Pour les pages documentaires (`includePresent`), chaque Rubrique qui
 * contient au moins un document est rendue, à sa place dans l'ordre du
 * référentiel ; les Rubriques vides restent soumises à la visibilité. Un
 * code inconnu du référentiel est rendu en dernier, sous son code.
 * ══════════════════════════════════════════════════════════════════════════
 */
export function rubricsForPage(
  visibleRubrics: readonly RubricDefinition[],
  countByRubric: ReadonlyMap<string, number>,
  includePresent: boolean,
): Array<{ code: string; label: string }> {
  if (!includePresent) return visibleRubrics.map((r) => ({ code: r.code, label: r.label }));
  const visibles = new Set<string>(visibleRubrics.map((r) => r.code));
  const present = (code: string) => (countByRubric.get(code) ?? 0) > 0;
  const connues = new Set<string>(RUBRICS.map((r) => r.code));
  return [
    ...RUBRICS.filter((r) => visibles.has(r.code) || present(r.code)).map((r) => ({ code: r.code, label: r.label })),
    ...[...countByRubric.keys()]
      .filter((code) => !connues.has(code) && present(code) && !code.startsWith('__'))
      .sort()
      .map((code) => ({ code, label: code })),
  ];
}
