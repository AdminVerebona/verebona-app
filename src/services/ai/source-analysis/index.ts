/**
 * Usage IA n°1 — Analyse unifiée des sources.
 * Point d'entrée unique : `runSourceAnalysis`.
 */
// SEUL point d'entrée autorisé depuis le code applicatif (quota, file
// durable, reprise des échecs). `runSourceAnalysis` ci-dessous est le moteur
// lui-même : il ne doit être appelé que par ce point d'entrée (§10.4).
export { analyzeFileSources, analyzeWebLinkSource } from './entrypoint';

