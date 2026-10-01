/**
 * Incidents de cloisonnement de l'assistant — CDC §32.2 (« incidents de
 * permissions ou de cloisonnement »), §13.2, §27.1.
 *
 * Compteurs PAR INSTANCE, depuis son démarrage (choix ARBITRÉ au lot 19 :
 * pas de persistance ; perdus au redémarrage, non additionnés entre
 * instances — l'écran le dit) : une tentative de surcharge
 * de compte est refusée (403) avant toute création de demande, il n'existe
 * donc aucune ligne en base pour la compter. Aucun contenu, aucun
 * identifiant : le type d'incident seulement (le journal serveur porte la
 * même ligne, sans valeur).
 *
 * Les incidents tracés AVEC une demande (source citée hors des sources
 * autorisées, `MODEL_UNKNOWN_SOURCE_REJECTED`) se lisent en base, sur une
 * période (`telemetry/observability.repository.ts`).
 */

export const SCOPE_INCIDENT_KINDS = ['CLIENT_ACCOUNT_OVERRIDE'] as const;
export type ScopeIncidentKind = (typeof SCOPE_INCIDENT_KINDS)[number];

const compteurs = new Map<ScopeIncidentKind, number>();

export function recordScopeIncident(kind: ScopeIncidentKind): void {
  compteurs.set(kind, (compteurs.get(kind) ?? 0) + 1);
  console.warn(`[verebona][cloisonnement] incident ${kind}`);
}

export function scopeIncidentCounters(): Record<ScopeIncidentKind, number> {
  return Object.fromEntries(SCOPE_INCIDENT_KINDS.map((k) => [k, compteurs.get(k) ?? 0])) as Record<ScopeIncidentKind, number>;
}

/** Réservé aux tests. */
export function resetScopeIncidentsForTests(): void {
  compteurs.clear();
}
