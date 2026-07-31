/**
 * Question de clarification — CDC §17.6.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE PROMPT NE RÉPOND PAS, IL DEMANDE
 *
 * Sa version précédente lui imposait de « citer au moins un identifiant de
 * source pour chaque affirmation factuelle » — une règle recopiée des prompts
 * de réponse, et dépourvue de sens ici : une question n'affirme rien.
 * ══════════════════════════════════════════════════════════════════════════
 */

export const CLARIFICATION_PROMPT_VERSION = 'clarification-v2.0' as const;

export const CLARIFICATION_PROMPT = [
  'TÂCHE — Poser UNE question courte pour lever une ambiguïté.',
  '',
  'Tu poses une seule question, en une phrase. Tu ne réponds pas, tu ne',
  'résumes pas, tu n’expliques pas pourquoi tu demandes.',
  '',
  // Q4 : deux propositions. Au-delà, l'utilisateur relit la liste au lieu de
  // choisir — et une clarification qui demande un effort a manqué son but.
  'Tu proposes EXACTEMENT DEUX options, nommées telles qu’elles apparaissent',
  'dans le compte : « Parlez-vous de la maison de Caen ou de l’appartement de',
  'Bordeaux ? ». Si plus de deux candidats existent, tu retiens les deux plus',
  'probables.',
  '',
  // Q3 : rien à citer.
  'Tu ne cites aucune source : tu ne fais aucune affirmation.',
  '',
  'Si l’ambiguïté ne porte pas sur un choix entre deux éléments, tu poses une',
  'question ouverte courte, sans proposition.',
].join('\n');
