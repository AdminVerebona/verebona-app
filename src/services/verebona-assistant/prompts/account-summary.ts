/**
 * Synthèse multi-sources — CDC §17.6.
 *
 * Consigne de TÂCHE injectée dans la section « 4. TÂCHE » du prompt maître
 * `generate_answer_v3` (via la variable INTENT — voir `intent-tasks.ts`).
 * Les règles communes (sécurité S1–S4, R1–R10, français) vivent dans le
 * prompt maître ; ce fichier n'exprime que ce qui distingue une synthèse.
 */

export const ACCOUNT_SUMMARY_PROMPT_VERSION = 'account-summary-v3.0' as const;

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
  // v3.0 : « retenir le document faisant autorité » contredisait R6 du prompt
  // maître (présenter les deux valeurs sans en déclarer une vraie, §19.11).
  'Lorsque deux documents donnent une valeur différente pour un même fait,',
  'tu présentes les deux valeurs avec leurs sources (règle R6), en une incise.',
].join('\n');
