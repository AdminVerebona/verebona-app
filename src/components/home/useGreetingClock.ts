'use client';

/**
 * Lot 78C — date et salutation de l'accueil TOUJOURS celles du jour.
 *
 * Constat (capture du mercredi 21/10 à 16:24 : « Mardi 20 octobre ») : la
 * date était calculée À CHAQUE RENDU (`new Date()` dans `MascotSpeaks`),
 * jamais rafraîchie autrement. Or l'accueil ne se re-rend pas quand rien ne
 * change : la relecture périodique de la mascotte (10 min) CONSERVE la
 * présentation de même contexte (RUN-001, aucun changement d'état React) —
 * un onglet resté ouvert depuis la veille, ou l'application mobile reprise
 * d'arrière-plan, gardait donc la date (et « Bonjour » / « Bonsoir ») du
 * dernier rendu. Ni le serveur (accueil rendu côté client seulement, après
 * hydratation), ni un cache, ni le build n'étaient en cause.
 *
 * Désormais la date est une source EXTERNE (`useSyncExternalStore`) dont la
 * valeur change au passage de minuit et de 18:00 (heure LOCALE du terminal :
 * fuseau de l'utilisateur), et qui est relue au retour au premier plan
 * (onglet de nouveau visible, fenêtre reprenant le focus, application mobile
 * réveillée) — les minuteries étant ralenties ou suspendues en arrière-plan.
 * Rendu serveur / hydratation : `null` (aucune date figée côté serveur, aucun
 * décalage d'hydratation) puis la date locale.
 */
import { useMemo, useSyncExternalStore } from 'react';

/** Clé de l'instant pour la salutation : jour local + « avant / après 18:00 » (pure). */
export function greetingClockKey(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}|${now.getHours() < 18 ? 'jour' : 'soir'}`;
}

/** Délai jusqu'au prochain changement de clé (18:00 ou minuit, heure locale) (pure). */
export function msUntilNextGreetingChange(now: Date): number {
  const next = new Date(now);
  if (now.getHours() < 18) next.setHours(18, 0, 0, 0);
  else { next.setDate(next.getDate() + 1); next.setHours(0, 0, 0, 0); }
  return Math.max(1_000, next.getTime() - now.getTime());
}

function subscribe(onChange: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (timer) clearTimeout(timer);
    // +500 ms : jamais un réveil juste AVANT la bascule (horloge imprécise).
    timer = setTimeout(() => { onChange(); arm(); }, msUntilNextGreetingChange(new Date()) + 500);
  };
  const reprise = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    onChange();
    arm();
  };
  arm();
  document.addEventListener('visibilitychange', reprise);
  window.addEventListener('focus', reprise);
  window.addEventListener('pageshow', reprise);
  return () => {
    if (timer) clearTimeout(timer);
    document.removeEventListener('visibilitychange', reprise);
    window.removeEventListener('focus', reprise);
    window.removeEventListener('pageshow', reprise);
  };
}

const getSnapshot = () => greetingClockKey(new Date());
const getServerSnapshot = () => null;

/**
 * Instant courant pour la date et la salutation de l'accueil, renouvelé à
 * minuit, à 18:00 et au retour au premier plan. `null` au rendu serveur.
 */
export function useGreetingNow(): Date | null {
  const key = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  // L'instant n'est relu que quand la clé change (jour, avant / après 18:00).
  return useMemo(() => (key ? new Date() : null), [key]);
}
