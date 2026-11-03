/**
 * Masquage du contenu AVANT tout rendu au démarrage à froid — lot 107A.
 *
 * Le module d'exécution natif (`NativeBridgeRuntime`) n'est chargé qu'après
 * l'hydratation : sans ce script, un démarrage à froid après plus de 5 min
 * aurait affiché un instant les données du compte avant le verrou. Ce script
 * bloquant (même principe que `themeBootScript`) pose `data-vb-lock` sur
 * <html> quand l'app native est relancée après le seuil ; la feuille de style
 * masque alors toute la page (`globals.css`, bloc « Lot 107A »). Le module
 * d'exécution reprend la main (`setLockCover`) puis retire le masque après
 * déverrouillage, ou dès qu'aucune session n'existe (écran de connexion).
 *
 * Navigateur / PWA : `window.Capacitor` absent → le script ne fait RIEN.
 * Filet : si le module d'exécution ne reprend pas la main (erreur de
 * chargement), un bouton « Recharger Verebona » apparaît après 20 s — sans
 * jamais révéler le contenu.
 */
import { BACKGROUND_AT_KEY, LOCK_AFTER_BACKGROUND_MS } from './app-lock';

export const LOCK_ATTRIBUTE = 'data-vb-lock';
/** Élément autorisé à rester visible pendant le masquage (écran de secours). */
export const LOCK_SCREEN_ATTRIBUTE = 'data-vb-lock-screen';
export const LOCK_RESCUE_DELAY_MS = 20_000;

export function nativeLockBootScript(): string {
  return `(function(){try{var C=window.Capacitor;if(!C||typeof C.isNativePlatform!=='function'||!C.isNativePlatform())return;`
    + `var v=0;try{v=Number(localStorage.getItem('${BACKGROUND_AT_KEY}'))}catch(e){}if(!(v>0))return;`
    + `var el=Date.now()-v;if(!(el<0||el>=${LOCK_AFTER_BACKGROUND_MS}))return;`
    + `var d=document.documentElement;d.setAttribute('${LOCK_ATTRIBUTE}','boot');`
    + `setTimeout(function(){if(d.getAttribute('${LOCK_ATTRIBUTE}')!=='boot'||document.getElementById('vb-lock-rescue'))return;`
    + `var b=document.createElement('button');b.id='vb-lock-rescue';b.type='button';b.setAttribute('${LOCK_SCREEN_ATTRIBUTE}','');`
    + `b.textContent='Recharger Verebona';b.onclick=function(){location.reload()};document.body.appendChild(b)},${LOCK_RESCUE_DELAY_MS});`
    + `}catch(e){}})();`;
}

/** Masque / démasque le contenu (appelé par le module d'exécution, de façon synchrone). */
export function setLockCover(covered: boolean): void {
  if (typeof document === 'undefined') return;
  const d = document.documentElement;
  if (covered) d.setAttribute(LOCK_ATTRIBUTE, 'on');
  else d.removeAttribute(LOCK_ATTRIBUTE);
  if (!covered) document.getElementById('vb-lock-rescue')?.remove();
}
