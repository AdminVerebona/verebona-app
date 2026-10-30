/**
 * Partage sortant (feuille de partage) — lot 100D (décision PO A9 :
 * parrainage « visible, copiable et partageable » dans l'application).
 *
 *   1. Dans l'app iOS / Android : feuille de partage NATIVE (plugin Capacitor
 *      `Share`, déjà embarqué par la coque — `mobile/package.json`) ;
 *   2. sinon, navigateur qui la propose : `navigator.share` (Web Share API) ;
 *   3. sinon : `unavailable` — l'appelant COPIE le texte (presse-papiers).
 * Une fermeture de la feuille par l'utilisateur rend `cancelled` (aucun
 * message d'erreur). Jamais d'exception.
 */
import { NATIVE_PLUGINS, nativePlugin } from './bridge';

export interface ShareContent { title: string; text: string; url?: string }
export type ShareOutcome = 'shared' | 'cancelled' | 'unavailable';

interface SharePlugin {
  share?: (o: { title?: string; text?: string; url?: string; dialogTitle?: string }) => Promise<unknown>;
  canShare?: () => Promise<{ value?: boolean }>;
}

function isCancel(e: unknown): boolean {
  const m = String((e as { message?: unknown })?.message ?? e ?? '').toLowerCase();
  const n = String((e as { name?: unknown })?.name ?? '');
  return n === 'AbortError' || m.includes('cancel') || m.includes('abort');
}

/** Le partage par feuille est-il possible ici (app, ou navigateur compatible) ? */
export function canShareNatively(): boolean {
  const p = nativePlugin<SharePlugin>(NATIVE_PLUGINS.share);
  if (p && typeof p.share === 'function') return true;
  return typeof navigator !== 'undefined' && typeof (navigator as { share?: unknown }).share === 'function';
}

export async function shareContent(c: ShareContent): Promise<ShareOutcome> {
  const p = nativePlugin<SharePlugin>(NATIVE_PLUGINS.share);
  if (p && typeof p.share === 'function') {
    try {
      const can = typeof p.canShare === 'function' ? await p.canShare().catch(() => ({ value: true })) : { value: true };
      if (can?.value !== false) {
        await p.share({ title: c.title, text: c.text, url: c.url, dialogTitle: c.title });
        return 'shared';
      }
    } catch (e) {
      if (isCancel(e)) return 'cancelled';
      // Plugin en échec : repli sur le navigateur, puis la copie.
    }
  }
  const nav = typeof navigator !== 'undefined' ? (navigator as { share?: (d: ShareData) => Promise<void> }) : null;
  if (nav && typeof nav.share === 'function') {
    try {
      await nav.share({ title: c.title, text: c.text, url: c.url });
      return 'shared';
    } catch (e) {
      if (isCancel(e)) return 'cancelled';
    }
  }
  return 'unavailable';
}
