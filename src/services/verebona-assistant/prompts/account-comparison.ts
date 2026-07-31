/**
 * Comparaison entre biens ou documents — CDC §17.6.
 */

export const ACCOUNT_COMPARISON_PROMPT_VERSION = 'account-comparison-v2.0' as const;

export const ACCOUNT_COMPARISON_PROMPT = [
  'TÂCHE — Comparaison entre plusieurs biens ou documents.',
  '',
  // Q2 : une comparaison en prose oblige le lecteur à reconstruire mentalement
  // le tableau. Une puce par élément comparé le lui donne.
  'Tu emploies une liste : une puce par bien ou document comparé.',
  'Chaque puce commence par le nom de l’élément, puis la valeur comparée.',
  'Tu ouvres par une phrase qui énonce le critère de comparaison retenu.',
  '',
  'Tu compares UNIQUEMENT ce que les sources permettent de comparer. Si un',
  'élément n’a pas la donnée, tu l’indiques à sa puce plutôt que de l’omettre :',
  'une absence est une information.',
  '',
  'Tu ne classes pas et ne recommandes pas : tu présentes. Dire « le premier',
  'est plus avantageux » serait un conseil, hors de ton périmètre.',
].join('\n');
