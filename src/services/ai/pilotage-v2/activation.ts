/**
 * Variable `AI_PILOTAGE_V2` — lot 89A (CDC Pilotage IA V2, phase P8 :
 * MIG-01, MIG-04, LIV-01/02). PUR.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * INVENTAIRE (25/10/2026, code du lot 88)
 *
 * Aucune variable `AI_V2_*` ni `AI_PILOTAGE_V2` n'existait dans le code : les
 * phases P1 à P7 (lots 82C à 87A) ont été livrées SANS interrupteur — chaque
 * fonction n'a qu'un chemin, le nouveau, actif dès son déploiement (règle du
 * dépôt depuis le lot 16b : aucun drapeau `AI_*` de déploiement, voir
 * `config/retired-variables.ts` ; MIG-01 : aucun déploiement fonctionnel
 * fractionné). Les anciens chemins ont été retirés au fil des lots (84D, 85C,
 * 86A, 86B) ; le dernier — la règle transitoire « qualification technique
 * seulement » des preuves du fichier global — l'est au lot 89A.
 *
 * Il n'y a donc RIEN à basculer : `AI_PILOTAGE_V2` n'aiguille aucun chemin
 * (le réintroduire comme aiguillage créerait le second chemin que MIG-04
 * interdit). Elle porte le seul geste de « jour J » encore utile :
 *
 *   on        le reclassement de l'historique (P8, MIG-03) est lancé
 *             AUTOMATIQUEMENT par la tâche planifiée
 *             `ai-history-reclassification` (au démarrage, puis toutes les
 *             heures tant qu'il reste des appels à classer), avec le marquage
 *             « manuel, non qualifié » des configurations existantes (MIG-02) ;
 *   absente / off / autre
 *             la tâche ne fait rien (note « en attente du jour J ») ; le
 *             bouton du BO (Exploitation › Rattrapages) reste disponible.
 *
 * Retour arrière : `off` arrête les passes automatiques ; « Restaurer » du
 * rattrapage annule le reclassement et le marquage (colonnes remises à vide,
 * traces d'origine jamais touchées). Aucun autre comportement ne dépend de
 * cette variable.
 * ══════════════════════════════════════════════════════════════════════════
 */

const PILOTAGE_V2_VARIABLE = 'AI_PILOTAGE_V2' as const;

export type PilotageV2State = 'on' | 'off' | 'absent' | 'invalid';

const ON = new Set(['on', 'true', '1', 'yes', 'oui']);
const OFF = new Set(['off', 'false', '0', 'no', 'non']);

/** État lu de l'environnement (sous-ensemble de `process.env`). Pur. */
export function pilotageV2State(env: Record<string, string | undefined> = process.env): PilotageV2State {
  const raw = (env[PILOTAGE_V2_VARIABLE] ?? '').trim().toLowerCase();
  if (raw === '') return 'absent';
  if (ON.has(raw)) return 'on';
  if (OFF.has(raw)) return 'off';
  return 'invalid';
}

/** Le reclassement automatique de l'historique est-il demandé (jour J passé) ? Pur. */
export function automaticHistoryReclassificationEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return pilotageV2State(env) === 'on';
}

export const PILOTAGE_V2_STATE_LABELS: Readonly<Record<PilotageV2State, string>> = {
  on: 'activé (AI_PILOTAGE_V2=on) : reclassement automatique de l’historique',
  off: 'désactivé (AI_PILOTAGE_V2=off) : aucune passe automatique',
  absent: 'non posé : en attente du jour J (aucune passe automatique)',
  invalid: 'valeur non reconnue : traitée comme désactivée (poser « on » ou « off »)',
};
