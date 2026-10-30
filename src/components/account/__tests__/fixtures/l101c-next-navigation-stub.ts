/** Lot 101C — remplace `next/navigation` dans le harnais navigateur (aucun routeur Next monté). */
const router = { push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} };
export const useRouter = () => router;
export const usePathname = () => '/mon-compte';
export const useSearchParams = () => new URLSearchParams(window.location.search);
