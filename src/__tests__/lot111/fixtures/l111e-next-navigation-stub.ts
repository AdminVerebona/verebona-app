/** Lot 111E — remplace `next/navigation` dans le harnais navigateur (aucun routeur Next monté). */
const w = window as unknown as { __routes: string[] };
w.__routes = [];
const router = {
  push: (u: string) => { w.__routes.push(u); }, replace: (u: string) => { w.__routes.push(`replace:${u}`); },
  refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {},
};
export const useRouter = () => router;
export const usePathname = () => window.location.pathname;
export const useSearchParams = () => new URLSearchParams(window.location.search);
