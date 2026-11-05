/**
 * Lot 110C — modules remplacés dans le harnais navigateur (navigation Next,
 * espace Verebona, garde d'écriture). Par défaut, l'espace « accueil »
 * enregistre les questions posées ; sous `T2Ctx` (harnais de « Demander à
 * Verebona »), il expose l'API lue par `SpaceBody`, alimentée par le VRAI
 * magasin des suggestions partagées. Jamais importé par l'application.
 */
import { createContext, useContext } from 'react';

type Ask = { question: string; context?: Record<string, string> };
type W = { __navigations: string[]; __asks: Ask[] };
const w = () => window as unknown as W;
export const useRouter = () => ({ push: (h: string) => { (w().__navigations ??= []).push(h); }, replace: () => {}, prefetch: () => {}, back: () => {} });
export const usePathname = () => '/accueil';
export const useSearchParams = () => new URLSearchParams();
export const recordAsk = (question: string, context?: Record<string, string>) => { (w().__asks ??= []).push({ question, context }); return Promise.resolve(true); };
const homeSpace = { ask: recordAsk, close: () => {}, open: () => {} };
export const T2Ctx = createContext<unknown>(null);
export const useVerebonaSpace = () => (useContext(T2Ctx) ?? homeSpace) as never;
export const useWriteGuard = () => ({ garder: (f: () => void) => f(), signalerRefus: () => {} });
