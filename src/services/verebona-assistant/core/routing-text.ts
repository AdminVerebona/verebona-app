/**
 * Normalisation du texte pour le routage — CDC §9.3, §9.4, §11.2, CA-21.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI LES RÈGLES NE SE DÉCLENCHAIENT PAS
 *
 * En JavaScript, `\b` ne connaît que [A-Za-z0-9_] : « À », « é » ne sont pas
 * des lettres pour lui. `\b(à quoi sert)` ne reconnaissait donc jamais « À
 * quoi sert À traiter ? », et `\bévolution` jamais « évolution ». Les motifs
 * accentués échouaient en silence et la question partait en classification
 * (UNKNOWN en Standard).
 *
 * Deux mesures :
 *   1. le message est normalisé AVANT les motifs (minuscules, sans accents,
 *      apostrophes typographiques unifiées, espaces réduits) — les motifs
 *      s'écrivent en ASCII, une seule fois ;
 *   2. les bornes de mot sont des bornes Unicode (`\p{L}`, `\p{N}`, drapeau
 *      `u`) et non `\b`.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Minuscules, sans diacritiques, apostrophes unifiées, espaces réduits. */
export function normalizeForRouting(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

/**
 * Motif « mot entier » à bornes Unicode : `alternatives` est un fragment
 * d'expression régulière (alternatives séparées par `|`), écrit en ASCII
 * sur le texte normalisé.
 */
export function word(alternatives: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, 'u');
}

/** Motif ancré en début de message, borne Unicode à droite. */
export function startsWith(alternatives: string): RegExp {
  return new RegExp(`^(?:${alternatives})(?![\\p{L}\\p{N}])`, 'u');
}
