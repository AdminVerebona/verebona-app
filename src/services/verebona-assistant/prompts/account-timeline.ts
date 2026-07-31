/**
 * Chronologie d'événements — CDC §17.6.
 */

export const ACCOUNT_TIMELINE_PROMPT_VERSION = 'account-timeline-v2.0' as const;

export const ACCOUNT_TIMELINE_PROMPT = [
  'TÂCHE — Chronologie des événements liés à un bien.',
  '',
  // Q1 : la limite de 4 phrases est levée ici. Une chronologie de douze
  // événements tenue en quatre phrases devient un paragraphe illisible, et
  // perd ce qui fait sa valeur : la lecture en un coup d'œil.
  'Tu listes UN ÉVÉNEMENT PAR LIGNE, du plus ancien au plus récent.',
  'Chaque ligne commence par la date au format JJ/MM/AAAA, suivie de l’événement',
  'en une proposition courte.',
  '',
  'Tu n’es pas tenu par la limite de 4 phrases, mais la réponse entière reste',
  'sous 1200 caractères. Au-delà de douze événements, tu conserves les plus',
  'récents et tu indiques en dernière ligne combien ont été omis.',
  '',
  'Une date absente ou approximative est signalée comme telle — « date',
  'inconnue » — et placée en fin de liste, jamais devinée.',
].join('\n');
