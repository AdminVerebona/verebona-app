/**
 * Thème de l'application — charte « Sérénité » 2026 (lot 66).
 *
 * Deux thèmes, valeurs HISTORIQUES conservées dans `localStorage`
 * (« verebona-theme ») et dans l'attribut `data-theme` de <html> :
 *   - `beige` : thème clair (ivoire / pétrole / cuivre) ;
 *   - `blue`  : thème sombre (encre neutre, accent pétrole clair).
 *
 * Choix explicite de l'utilisateur (menu « Thème clair / Thème sombre ») :
 * il est enregistré et l'emporte. Sans choix enregistré, la préférence du
 * système (`prefers-color-scheme`) décide, et la suit en direct.
 *
 * Le script bloquant de `app/layout.tsx` applique la même règle avant le
 * premier rendu (pas de flash) : il est construit ici (`themeBootScript`)
 * pour qu'une seule règle existe.
 */

export type AppTheme = 'blue' | 'beige';

export const THEME_STORAGE_KEY = 'verebona-theme';

/** Fond de page de chaque thème : barre d'état, `theme-color`, manifeste. */
export const THEME_PAGE_COLOR: Record<AppTheme, string> = {
  beige: '#F8F6F1',
  blue: '#1B2529',
};

export function isAppTheme(v: unknown): v is AppTheme {
  return v === 'blue' || v === 'beige';
}

/** Thème effectif : choix enregistré, sinon préférence du système. */
export function resolveTheme(saved: string | null | undefined, systemPrefersDark: boolean): AppTheme {
  if (isAppTheme(saved)) return saved;
  return systemPrefersDark ? 'blue' : 'beige';
}

export function readSavedTheme(): AppTheme | null {
  try {
    const v = typeof window !== 'undefined' ? window.localStorage.getItem(THEME_STORAGE_KEY) : null;
    return isAppTheme(v) ? v : null;
  } catch {
    return null;
  }
}

export function systemPrefersDark(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

/**
 * Applique un thème au document : attribut `data-theme` (jetons CSS), classe
 * du <body> (variantes historiques `[.theme-beige_&]`) et couleur de la barre
 * d'état / `theme-color` (application installée, Safari, Android).
 */
export function applyThemeToDocument(theme: AppTheme, doc: Document | undefined = typeof document !== 'undefined' ? document : undefined): void {
  if (!doc) return;
  doc.documentElement.setAttribute('data-theme', theme);
  doc.body?.classList.remove('theme-blue', 'theme-beige');
  doc.body?.classList.add(`theme-${theme}`);
  const color = THEME_PAGE_COLOR[theme];
  const metas = doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  if (metas.length === 0) {
    const m = doc.createElement('meta');
    m.name = 'theme-color';
    m.content = color;
    doc.head?.appendChild(m);
  } else {
    // Le thème choisi dans l'application l'emporte sur les variantes
    // `media` (clair/sombre du système) déclarées par le layout.
    metas.forEach((m) => { m.content = color; });
  }
}

/** Script bloquant, exécuté dans <head> avant tout rendu. */
export function themeBootScript(): string {
  const light = THEME_PAGE_COLOR.beige;
  const dark = THEME_PAGE_COLOR.blue;
  return `(function(){try{var t=null;try{t=localStorage.getItem('${THEME_STORAGE_KEY}')}catch(e){}`
    + `if(t!=='beige'&&t!=='blue'){t=(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)?'blue':'beige'}`
    + `document.documentElement.setAttribute('data-theme',t);`
    + `var c=t==='blue'?'${dark}':'${light}';var ms=document.querySelectorAll('meta[name="theme-color"]');for(var i=0;i<ms.length;i++){ms[i].setAttribute('content',c)}`
    + `}catch(e){}})();`;
}
