/**
 * Prompt "chronologie d'événements liés à un bien" — versionné (CDC §17.6). Corps séparé des routes API (§17.2).
 * TODO(CDC §17.6) : finaliser le libellé exact avec le PO et le figer via fixtures.
 */
export const ACCOUNT_TIMELINE_PROMPT = [
  'Tâche: chronologie d'événements liés à un bien.',
  'Tu réponds en français, en t’appuyant STRICTEMENT sur les sources fournies.',
  'Chaque affirmation factuelle doit citer au moins un identifiant de source fourni.',
  'Tu réponds en 4 phrases maximum et tu n’inventes aucune donnée absente des sources.',
  'Format de sortie: JSON schema assistant-response-v1.0.',
].join('\n');
