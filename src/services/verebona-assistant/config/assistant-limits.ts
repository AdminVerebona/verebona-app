/**
 * Lot 111M (ticket « budgets IA », §4 T2) — bornes de SÉCURITÉ de l'assistant,
 * sans dépendance (partagées par la configuration et les outils de lecture :
 * une seule valeur, jamais une copie divergente).
 *
 *   · `ASSISTANT_INPUT_SAFETY_TOKENS` (12 000) — plafond d'entrée CONSERVÉ :
 *     il borne la latence (12 s par tentative, §30.1) et le coût d'un message ;
 *     il s'applique désormais au contexte RÉELLEMENT transmis (prompt maître
 *     actif compris) et ne coupe plus de preuve tant qu'il n'est pas atteint.
 *     Mesure : 8 sources de 4 000 caractères + prompt maître ≈ 11 500 jetons
 *     estimés. Surcharge : `VEREBONA_ASSISTANT_MAX_INPUT_TOKENS` (BO / env).
 *   · `ASSISTANT_EXCERPT_READ_CHARS` (1 500 → 4 000) — borne de LECTURE d'un
 *     extrait : une preuve en fin d'extrait n'est plus coupée avant le calcul
 *     du budget ; le plafond d'entrée reste la limite haute du coût.
 */
export const ASSISTANT_INPUT_SAFETY_TOKENS = 12_000;
export const ASSISTANT_EXCERPT_READ_CHARS = 4_000;
