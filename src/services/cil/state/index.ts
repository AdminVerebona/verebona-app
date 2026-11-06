/**
 * Service commun d'état CIL (lot 111U) — UNE projection :
 *   getCilState()        état granulaire (Informations, diagnostic BO) ;
 *   evaluateCilReadiness (cil-preparation.service) en dérive les blocs de la
 *   préparation, du blocage de génération et du mappeur PDF, à partir des
 *   MÊMES entrées chargées une seule fois (`loadCilStateInput`).
 */
import { loadCilStateInput, type CilAssetRef } from './load';
import { evaluateCilState, type CilStateInput } from './evaluate';
import type { CilState } from '@/lib/cil/cil-state-types';

export { evaluateCilState, classifyCilDocs } from './evaluate';
export type { CilStateInput } from './evaluate';
export { loadCilStateInput, cilProjectionSchemaReady, CIL_DOCUMENT_SCOPE_SQL } from './load';

/** État CIL d'un bien du compte ; `null` si le bien est introuvable. Lève en cas d'erreur (jamais d'état vide trompeur). */
export async function getCilState(ref: CilAssetRef): Promise<{ state: CilState; input: CilStateInput } | null> {
  const input = await loadCilStateInput(ref);
  if (!input) return null;
  return { state: evaluateCilState(input), input };
}
