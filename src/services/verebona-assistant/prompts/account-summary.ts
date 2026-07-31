/**
 * Synthèse multi-sources — CDC §17.6.
 *
 * Les règles communes — sources, vouvoiement, périmètre, absence — vivent
 * dans `SYSTEM_PROMPT_V1`. Ce fichier n'exprime que ce qui distingue une
 * synthèse d'une comparaison ou d'une chronologie.
 */

export const ACCOUNT_SUMMARY_PROMPT_VERSION = 'account-summary-v2.0' as const;

export const ACCOUNT_SUMMARY_PROMPT = [
  'TÂCHE — Synthèse d’un bien ou du compte à partir de plusieurs documents.',
  '',
  // Q1 : 4 phrases pour une synthèse. C'est le format le plus contraint des
  // cinq, et c'est voulu : une synthèse qui s'allonge cesse d'en être une.
  'Tu réponds en 4 phrases maximum.',
  '',
  'Tu ordonnes par IMPORTANCE, non par date : ce qui engage l’utilisateur',
  'd’abord — un montant, une échéance, une obligation —, le descriptif ensuite.',
  '',
  'Lorsque deux documents donnent une valeur différente pour un même fait,',
  'tu retiens celle du document faisant autorité et tu signales l’écart en une',
  'incise, sans en faire une phrase entière.',
].join('\n');
