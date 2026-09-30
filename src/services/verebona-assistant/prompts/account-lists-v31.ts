/**
 * Consignes chronologie et comparaison v3.1 — CDC 15 T2-36 (lot 15).
 *
 * Utilisées SEULEMENT avec `ASSISTANT_CANONICAL_READ=enabled` (prompt
 * `generate_answer_v5`). En legacy, les textes v3.0 (`account-timeline.ts`,
 * `account-comparison.ts`) restent envoyés tels quels, octet pour octet.
 *
 * v3.1 : plus de « limite de 4 phrases » levée dans la consigne ; la longueur
 * vient de la règle unique par intention (`answer-format.ts`).
 */
import { lengthRuleText } from './answer-format';

export const ACCOUNT_TIMELINE_PROMPT_V31_VERSION = 'account-timeline-v3.1' as const;
export const ACCOUNT_COMPARISON_PROMPT_V31_VERSION = 'account-comparison-v3.1' as const;

export const ACCOUNT_TIMELINE_PROMPT_V31 = [
  'TÂCHE — Chronologie des événements liés à un bien.',
  '',
  'Tu listes UN ÉVÉNEMENT PAR LIGNE, du plus ancien au plus récent.',
  'Chaque ligne commence par la date au format JJ/MM/AAAA, suivie de l’événement',
  'en une proposition courte.',
  '',
  lengthRuleText('ACCOUNT_TIMELINE'),
  'Au-delà, tu conserves les plus récents et tu indiques en dernière ligne',
  'combien ont été omis.',
  '',
  'Une date absente ou approximative est signalée comme telle — « date',
  'inconnue » — et placée en fin de liste, jamais devinée.',
].join('\n');

export const ACCOUNT_COMPARISON_PROMPT_V31 = [
  'TÂCHE — Comparaison entre plusieurs biens ou documents.',
  '',
  'Tu emploies une liste : une puce par bien ou document comparé.',
  'Chaque puce commence par le nom de l’élément, puis la valeur comparée.',
  'Tu ouvres par une phrase qui énonce le critère de comparaison retenu.',
  lengthRuleText('ACCOUNT_COMPARISON'),
  '',
  'Tu compares UNIQUEMENT ce que les sources permettent de comparer. Si un',
  'élément n’a pas la donnée, tu l’indiques à sa puce plutôt que de l’omettre :',
  'une absence est une information.',
  '',
  'Tu ne classes pas et ne recommandes pas : tu présentes. Dire « le premier',
  'est plus avantageux » serait un conseil, hors de ton périmètre.',
].join('\n');
