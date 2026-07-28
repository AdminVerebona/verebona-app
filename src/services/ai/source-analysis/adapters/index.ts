/**
 * Résolution de l'adaptateur — CDC §4.1.2.
 *
 * Ajouter une source future (email, import externe) consiste à enregistrer un
 * adaptateur ici. Le pipeline n'est pas modifié.
 */
import type { SourceAdapter } from './source-adapter.port';
import type { SourceType } from '../types';
import { FileSourceAdapter } from './file-source.adapter';
import { WebLinkSourceAdapter } from './web-link-source.adapter';

const adapters = new Map<SourceType, SourceAdapter>([
  ['file', new FileSourceAdapter()],
  ['web_link', new WebLinkSourceAdapter()],
]);

export function getSourceAdapter(sourceType: SourceType): SourceAdapter {
  const adapter = adapters.get(sourceType);
  if (!adapter) throw new Error(`[source-adapters] Aucun adaptateur pour « ${sourceType} ».`);
  return adapter;
}

export function registerSourceAdapter(adapter: SourceAdapter): void {
  adapters.set(adapter.sourceType, adapter);
}

export type { SourceAdapter, AdapterPrepareInput } from './source-adapter.port';
export { FileSourceAdapter } from './file-source.adapter';
export { WebLinkSourceAdapter, assertSafeUrl, extractTextFromHtml } from './web-link-source.adapter';
