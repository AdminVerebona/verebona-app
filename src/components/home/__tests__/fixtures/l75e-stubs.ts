/**
 * Lot 75E — modules remplacés dans le harnais navigateur de la mascotte
 * (navigation Next, espace Verebona, garde d'écriture), comme dans le rendu
 * serveur du lot 71F. Jamais importé par l'application.
 */
const nav = () => ((window as unknown as { __navigations: string[] }).__navigations ??= []);
export const useRouter = () => ({ push: (h: string) => { nav().push(h); }, replace: (h: string) => { nav().push(h); }, prefetch: () => {}, back: () => {} });
export const usePathname = () => '/accueil';
export const useSearchParams = () => new URLSearchParams();
export const useVerebonaSpace = () => null;
export const useWriteGuard = () => ({ garder: (f: () => void) => f(), signalerRefus: () => {} });
