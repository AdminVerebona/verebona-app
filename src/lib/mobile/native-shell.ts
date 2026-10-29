/**
 * Coque native (Capacitor) vue depuis l'interface web — lot 97 (CDC 12 §3.2
 * Gate 0, §25 API-02, §30 VER-01/03).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CONTRAT AVEC LE PROJET NATIF (à implémenter par le sous-lot Capacitor)
 *
 * L'application iOS / Android affiche l'interface Next.js existante. Avant
 * le chargement de la page, la coque injecte :
 *
 *   window.VerebonaNative = {
 *     platform: 'ios' | 'android',
 *     appVersion: '1.4.0',          // version marketing
 *     build: '52',                  // numéro de build (facultatif)
 *     installationId: '<uuid>',     // généré à l'installation, stockage sécurisé
 *   }
 *
 * L'interface ajoute alors à CHAQUE appel d'API les en-têtes
 * X-Verebona-Client / -App-Version / -App-Build / -Installation-Id. Dans un
 * navigateur (Web, PWA), `window.VerebonaNative` est absent : aucun en-tête,
 * aucun changement.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { runtimeShellInfo } from '@/lib/native/shell-info';

export interface VerebonaNativeInfo {
  platform: 'ios' | 'android';
  appVersion: string;
  build?: string;
  installationId?: string;
}

declare global {
  interface Window {
    VerebonaNative?: VerebonaNativeInfo;
  }
}

/**
 * Informations de la coque native, ou null (navigateur).
 *
 * Lot 95 : à défaut d'objet injecté, le contrat est déduit de la coque
 * Capacitor elle-même (plateforme + marqueur `VerebonaApp/…` de l'agent
 * utilisateur, `lib/native/shell-info.ts`). Dans un navigateur : null, comme
 * avant.
 */
export function nativeShellInfo(): VerebonaNativeInfo | null {
  if (typeof window === 'undefined') return null;
  const n = window.VerebonaNative;
  if (!n || (n.platform !== 'ios' && n.platform !== 'android') || typeof n.appVersion !== 'string') return runtimeShellInfo();
  return n;
}

/** En-têtes du client natif (objet vide dans un navigateur). */
export function mobileClientHeaders(): Record<string, string> {
  const n = nativeShellInfo();
  if (!n) return {};
  return {
    'X-Verebona-Client': n.platform === 'ios' ? 'IOS' : 'ANDROID',
    'X-Verebona-App-Version': n.appVersion,
    ...(n.build ? { 'X-Verebona-App-Build': String(n.build) } : {}),
    ...(n.installationId ? { 'X-Verebona-Installation-Id': n.installationId } : {}),
  };
}

/** Événement : le serveur a refusé une version trop ancienne (`APP_UPDATE_REQUIRED`). */
export const APP_UPDATE_REQUIRED_EVENT = 'verebona:app-update-required';

export interface AppUpdateRequiredDetail {
  minVersion?: string | null;
  storeUrl?: string | null;
}

export function notifyAppUpdateRequired(details: unknown): void {
  if (typeof window === 'undefined') return;
  const d = (details && typeof details === 'object' ? details : {}) as Record<string, unknown>;
  const detail: AppUpdateRequiredDetail = {
    minVersion: typeof d.minVersion === 'string' ? d.minVersion : null,
    storeUrl: typeof d.storeUrl === 'string' ? d.storeUrl : null,
  };
  window.dispatchEvent(new CustomEvent<AppUpdateRequiredDetail>(APP_UPDATE_REQUIRED_EVENT, { detail }));
}
