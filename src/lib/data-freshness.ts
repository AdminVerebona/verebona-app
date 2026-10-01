/**
 * Fraîcheur des données du compte, côté navigateur.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * L'ACCUEIL SE METTAIT À JOUR TRÈS LONGTEMPS APRÈS L'ACTION
 *
 * Trois caches s'additionnaient sur `/api/home/summary` :
 *   1. cache mémoire d'`apiClient` (5 min), qu'aucune action faite sur une
 *      AUTRE page n'effaçait — créer un bien depuis /assets puis revenir à
 *      l'accueil servait l'ancien résumé jusqu'à cinq minutes ;
 *   2. cache serveur de 30 s, jamais invalidé : même un rechargement
 *      explicite après une action sur l'accueil recevait l'ancien état ;
 *   3. les rappels `onSuccess={loadSummary}` relisaient le cache client.
 *
 * Ce module note l'instant de la dernière modification. Toute écriture
 * réussie passée par `apiClient` (POST/PUT/PATCH/DELETE) le met à jour, ainsi
 * que les événements métier déjà émis par l'application. L'accueil demande
 * alors un résumé frais (`x-verebona-fresh: 1`), que le serveur calcule sans
 * lire son cache. Sans modification, le cache serveur reste utilisé.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** En-tête demandant au serveur d'ignorer son cache de lecture. */
export const FRESH_HEADER = 'x-verebona-fresh';

/** Événements métier émis par l'application après une modification. */
export const DATA_MUTATION_EVENTS = [
  'document-added',
  'document-deleted',
  'document-analysis-complete',
  'agenda-mutated',
  'notifications-refresh',
  'refresh-a-traiter',
] as const;

/** Écritures sans effet sur les données affichées (suivi, session). */
const IGNORED_MUTATION_URLS = ['/api/analytics/', '/api/auth/'];

let lastMutationAt = 0;

export function markAccountDataMutated(at: number = Date.now()): void {
  if (at > lastMutationAt) lastMutationAt = at;
}

/** Vrai si une modification a eu lieu depuis `since` (ms epoch). */
export function mutatedSince(since: number): boolean {
  return lastMutationAt > since;
}

/** Une écriture réussie vers cette URL modifie-t-elle les données du compte ? */
export function isDataMutation(method: string, url: string): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  return !IGNORED_MUTATION_URLS.some((prefix) => url.includes(prefix));
}

/** Réservé aux tests. */
export function resetDataFreshness(): void {
  lastMutationAt = 0;
}

// Les événements métier comptent comme des modifications, où que l'on soit :
// l'écoute est posée une fois, dès le chargement du module (importé par
// `apiClient`), et non par la seule page d'accueil quand elle est affichée.
if (typeof window !== 'undefined') {
  for (const name of DATA_MUTATION_EVENTS) {
    window.addEventListener(name, () => markAccountDataMutated());
  }
}

/**
 * Signale une modification des données du compte constatée SANS écriture
 * `apiClient` (même effet que `apiClient.post` réussi) : fraîcheur de
 * l'accueil + événement `verebona:data-mutated`, écouté par la mascotte
 * (CDC 11 §15 : sujet PROC-EXPORT recalculé sans attendre le minuteur).
 */
export function notifyDataMutated(): void {
  markAccountDataMutated();
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('verebona:data-mutated'));
}

// ── Génération d'export : passage à un état final (CDC 11 §15, lot 19) ─────

/** Statuts finals d'une génération V12 qui changent l'état présenté (prêt, partiel, erreur). */
const EXPORT_SETTLED = new Set(['ready', 'partial', 'failed']);

/** Une génération est-elle passée d'un état non final à prêt / partiel / erreur ? */
export function exportJustSettled(previous: string | null | undefined, next: string | null | undefined): boolean {
  return !!next && EXPORT_SETTLED.has(next) && !(previous && EXPORT_SETTLED.has(previous));
}

/**
 * Suivi par interrogation (GET) des générations d'export : mémorise le
 * dernier statut vu de chaque génération et émet `notifyDataMutated` UNE fois
 * quand l'une passe à prêt / partiel / erreur. `seed` : premier relevé d'une
 * liste (historique) — les générations déjà finales ne déclenchent rien.
 */
export function createExportSettleWatcher(notify: () => void = notifyDataMutated) {
  const vus = new Map<string, string>();
  let amorce = false;
  return {
    /** Relevé d'une génération ; vrai si elle vient de se terminer (événement émis). */
    observe(id: string | number, status: string | null | undefined): boolean {
      const k = String(id);
      const avant = vus.get(k);
      if (status) vus.set(k, status);
      if (!exportJustSettled(avant, status)) return false;
      notify();
      return true;
    },
    /** Relevé d'une liste : la première fois, mémorise sans émettre ; ensuite, un seul événement au plus. */
    observeList(items: ReadonlyArray<{ id: string | number; status: string | null | undefined }>): boolean {
      if (!amorce) {
        amorce = true;
        for (const i of items) if (i.status) vus.set(String(i.id), i.status);
        return false;
      }
      let termine = false;
      for (const i of items) {
        const k = String(i.id);
        const avant = vus.get(k);
        if (i.status) vus.set(k, i.status);
        // Nouvelle ligne déjà finale (créée et terminée entre deux relevés) : aussi un changement.
        if (exportJustSettled(avant, i.status)) termine = true;
      }
      if (termine) notify();
      return termine;
    },
  };
}
