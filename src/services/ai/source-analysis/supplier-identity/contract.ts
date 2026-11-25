/**
 * Carte #839 — activation PRUDENTE du contrat `t1-supplier-identity-v1`
 * (identité de l'émetteur, bloc PO 52 du guide des prompts).
 *
 * Même modèle que `billing-period/contract.ts` (lot 97A) : le schéma de sortie
 * T1 ACCEPTE toujours `document.supplier.identity` (champ facultatif, transmis
 * au fournisseur avec le structured output) ; le titre ne l'EXPLOITE que si la
 * version EFFECTIVE du prompt maître T1 porte le marqueur (texte collé par le
 * PO) et que c'est bien cette version qui a répondu. Sans lui, une identité
 * rendue spontanément par un modèle est conservée (aucune perte) mais marquée
 * `CONTRACT_NOT_CARRIED` : le titre garde le nom lu aujourd'hui.
 * Coupure d'urgence : `T1_SUPPLIER_IDENTITY_ENABLED=0` (aussi appliquée à la
 * lecture par le nommage, `supplierIdentityFromAnalysis`).
 *
 * Ce module ne modifie AUCUN prompt : il lit le texte effectif.
 */
import { supplierIdentityEnabled, T1_SUPPLIER_IDENTITY_CONTRACT } from '@/lib/documents/document-title-convention';

export interface SupplierIdentityCapability {
  carried: boolean;
  version: string | null;
  reason: 'CARRIED' | 'MARKER_MISSING' | 'DISABLED' | 'UNREADABLE';
}

/** Le texte d'un prompt porte-t-il le contrat ? (pure, simple recherche du marqueur) */
export function promptCarriesSupplierIdentity(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.includes(T1_SUPPLIER_IDENTITY_CONTRACT);
}

let cache: { at: number; value: SupplierIdentityCapability } | null = null;
const CACHE_MS = 60_000;

/** Réservé aux tests : vide le cache de disponibilité. */
export function __resetSupplierIdentityCapabilityCacheForTests(): void { cache = null; }

/** Le prompt T1 effectif porte-t-il le contrat ? Lecture seule, cache 60 s, ne lève pas. */
export async function supplierIdentityCapability(): Promise<SupplierIdentityCapability> {
  if (!supplierIdentityEnabled()) return { carried: false, version: null, reason: 'DISABLED' };
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  let value: SupplierIdentityCapability;
  try {
    const { effectivePromptOf } = await import('../../master-prompts/effective-prompt');
    const p = await effectivePromptOf('t1_analyze_document');
    const carried = promptCarriesSupplierIdentity(p.text);
    value = { carried, version: p.version, reason: carried ? 'CARRIED' : 'MARKER_MISSING' };
  } catch (e) {
    console.error('[t1-supplier-identity] version du prompt T1 illisible :', (e as Error).message);
    value = { carried: false, version: null, reason: 'UNREADABLE' };
  }
  cache = { at: Date.now(), value };
  return value;
}

/** Contrat porté PAR LA VERSION QUI A RÉPONDU ? (pure) */
export function identityContractFor(cap: SupplierIdentityCapability, respondingVersion: string | null | undefined): { carried: boolean; reason: string } {
  if (!cap.carried) return { carried: false, reason: cap.reason };
  if (cap.version !== null && respondingVersion && cap.version !== respondingVersion) return { carried: false, reason: 'OTHER_PROMPT_VERSION' };
  return { carried: true, reason: 'CARRIED' };
}
