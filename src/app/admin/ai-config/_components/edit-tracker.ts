/**
 * Compteur de saisies par traitement (BO IA) — protège une saisie faite
 * PENDANT un enregistrement.
 *
 * L'enregistrement (PUT) puis la relecture (GET) prennent du temps : si
 * l'administrateur modifie de nouveau le traitement entre-temps, la réponse
 * ne doit ni effacer l'état « non enregistré », ni remplacer le brouillon à
 * l'écran par la ligne relue — sa nouvelle saisie serait perdue.
 */
export interface EditTracker {
  /** À appeler à chaque modification saisie par l'administrateur. */
  bump(key: string): void;
  /** Repère à prendre au début de l'enregistrement. */
  mark(key: string): number;
  /** Aucune saisie depuis `mark` : la réponse serveur peut s'appliquer. */
  unchangedSince(key: string, mark: number): boolean;
}

export function createEditTracker(): EditTracker {
  const seq = new Map<string, number>();
  return {
    bump: (key) => { seq.set(key, (seq.get(key) ?? 0) + 1); },
    mark: (key) => seq.get(key) ?? 0,
    unchangedSince: (key, mark) => (seq.get(key) ?? 0) === mark,
  };
}
