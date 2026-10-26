/**
 * NotificationContentRenderer (CDC §11.1 / §16).
 *
 * Produit, à partir du catalogue central, le contenu adapté à chaque canal
 * (titre/corps cloche, titre/corps push, code de template email) et le lien
 * profond. Le push reste générique (vie privée §4.3).
 */

import type { CatalogEntry, RenderedContent } from './catalog';

export interface RenderResult extends RenderedContent {
  href: string | null;
}

export function renderContent(entry: CatalogEntry, payload: unknown, storedDeepLink?: string | null): RenderResult {
  const content = entry.render(payload);
  // Le lien stocké dans l'outbox prime (il a été calculé au moment de l'émission
  // avec le payload d'origine) ; sinon on le recalcule depuis le catalogue.
  const href = storedDeepLink ?? entry.deepLink(payload);
  return { ...content, href };
}
