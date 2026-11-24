/**
 * Carte #790 (relance du 21/11/2026) — modules remplacés dans le harnais NAVIGATEUR de l'espace de réponse :
 * la navigation Next et la garde d'écriture (hors sujet du test). Tout le reste est le code de l'application.
 * Jamais importé par l'application.
 */
export const useRouter = () => ({ push: () => {}, replace: () => {}, prefetch: () => {}, back: () => {} });
export const usePathname = () => '/accueil';
export const useSearchParams = () => new URLSearchParams();
export const useWriteGuard = () => ({ garder: (f: () => void) => f(), signalerRefus: () => {} });
