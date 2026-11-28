/**
 * Carte #880 (E01, R01) — retrait NON DESTRUCTIF des mots de la question.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Les stratégies déterministes T2 retirent les mots qui disent CE QUE L'ON
 * DEMANDE (« coût de possession », « sinistre », « quel », « de »…) avant de
 * résoudre le bien sur le reste. Ces listes étaient appliquées SANS
 * frontières de mot : « Quel est le coût de possession de Maison ? »
 * devenait « ison ? » (« ma » retiré de « Maison »), « Mercedes » devenait
 * « rce s », « Chalet » « Cha t »… et aucun bien n'était trouvé.
 *
 * Règle : une expression n'est retirée que si elle forme des MOTS ENTIERS —
 * jamais une sous-chaîne d'un nom propre. Frontières Unicode (lettres
 * accentuées comprises) ; une expression qui finit par une apostrophe
 * (« d’ », « qu’ ») se colle au mot suivant, comme en français.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Expression régulière qui ne reconnaît `source` (alternatives) qu'en mots entiers. */
export function wholeWords(source: string | RegExp, flags = 'gi'): RegExp {
  const src = typeof source === 'string' ? source : source.source;
  const f = [...new Set(`${flags}u`.split(''))].join('');
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${src})(?:(?<=['’])|(?![\\p{L}\\p{N}]))`, f);
}

/** Retire les expressions (mots entiers) du texte : le reste garde ses noms intacts. */
export function stripWholeWords(text: string, re: RegExp): string {
  return text.replace(re, ' ');
}

const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/['’]/g, '\'').toLowerCase();

/**
 * Retire les expressions HORS des noms de biens présents dans le texte :
 * « Où en est le sinistre de la Ferme du Suivi ? » garde « Ferme du Suivi »
 * entier (« suivi » est aussi un mot de la question). Comparaison sans
 * accents ni casse, en mots entiers ; le texte d'origine est conservé tel
 * quel dans les zones protégées (aucune réécriture du nom).
 */
export function stripOutsideNames(text: string, re: RegExp, names: readonly string[]): string {
  const zones: Array<[number, number]> = [];
  const t = norm(text);
  if (t.length === text.length) {
    for (const n of [...new Set(names.map((x) => norm(x).trim()).filter((x) => x.length >= 2))].sort((a, b) => b.length - a.length)) {
      const motif = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(n)}(?![\\p{L}\\p{N}])`, 'gu');
      for (const m of t.matchAll(motif)) {
        const debut = m.index ?? 0;
        const fin = debut + m[0].length;
        if (!zones.some(([a, b]) => debut < b && fin > a)) zones.push([debut, fin]);
      }
    }
  }
  if (!zones.length) return stripWholeWords(text, re);
  zones.sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = 0;
  for (const [a, b] of zones) {
    out += stripWholeWords(text.slice(pos, a), re) + text.slice(a, b);
    pos = b;
  }
  return out + stripWholeWords(text.slice(pos), re);
}

/** Échappe une chaîne littérale pour l'inclure dans une alternative. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
