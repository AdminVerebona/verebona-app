/**
 * Lot 108J — modules remplacés dans le harnais navigateur des suggestions
 * partagées (navigation Next, espace Verebona, garde d'écriture). L'espace
 * enregistre les questions posées (texte et contexte) au lieu de les envoyer.
 * Jamais importé par l'application.
 */
type W = { __navigations: string[]; __asks: Array<{ question: string; context?: Record<string, string> }> };
const w = () => window as unknown as W;
export const useRouter = () => ({ push: (h: string) => { (w().__navigations ??= []).push(h); }, replace: () => {}, prefetch: () => {}, back: () => {} });
export const usePathname = () => '/accueil';
export const useSearchParams = () => new URLSearchParams();
const space = {
  ask: (question: string, context?: Record<string, string>) => { (w().__asks ??= []).push({ question, context }); return Promise.resolve(true); },
  close: () => {}, open: () => {},
};
export const useVerebonaSpace = () => space;
export const useWriteGuard = () => ({ garder: (f: () => void) => f(), signalerRefus: () => {} });
