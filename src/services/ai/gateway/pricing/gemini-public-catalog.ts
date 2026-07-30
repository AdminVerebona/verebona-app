/**
 * Grille tarifaire publique Gemini — relevée sur la page officielle.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI UN CATALOGUE EN DUR PLUTÔT QU'UN SEUL RELEVÉ AUTOMATIQUE
 *
 * Le défaut n°10 du CDC refonte — « les tarifs enregistrés ne correspondent à
 * aucun des modèles réellement utilisés » — vient d'une table de prix inventée.
 * Le remède ne peut pas être un analyseur de page web fragile : le jour où
 * Google change sa mise en page, un analyseur produit soit une erreur, soit
 * pire, un chiffre faux.
 *
 * D'où ce découpage :
 *   • CE FICHIER fait foi. Chaque ligne a été relevée sur la page officielle,
 *     à la date indiquée, et porte la référence du palier concerné.
 *   • `gemini-public.source.ts` va lire la page et VÉRIFIE que ces montants
 *     y figurent toujours. En cas d'écart, il alerte — il ne corrige pas.
 *
 * Un tarif faux devient donc impossible sans qu'un humain l'ait validé.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * CONVENTION D'UNITÉ
 * `inputMicros` est en micro-unités de devise par token (cf. `cost-catalog.ts`,
 * coût = tokens × micros). Un tarif de 1,50 $ par million de tokens vaut donc
 * exactement 1,50 micro-dollar par token : les deux nombres coïncident.
 *
 * ⚠️ LIMITE CONNUE — TARIFICATION À DEUX PALIERS
 * Les modèles Pro facturent plus cher au-delà de 200 000 tokens d'invite
 * (2,5 Pro : 1,25 $ puis 2,50 $ ; 3.1 Pro : 2,00 $ puis 4,00 $). `ModelPrice`
 * ne porte qu'un seul tarif : ce sont les tarifs sous 200 000 tokens qui sont
 * enregistrés. Les invites plus longues sont donc sous-évaluées. Les modèles
 * Pro ne servent aujourd'hui qu'aux opérations de gouvernance, dont les
 * invites sont courtes ; à revoir si cela change.
 */
import type { ModelPrice } from './pricing-source.port';

/** Date du relevé. À mettre à jour avec les montants. */
export const CATALOG_SNAPSHOT_DATE = '2026-07-30';

/** Page de référence, également interrogée pour la détection d'écart. */
export const CATALOG_SOURCE_URL = 'https://ai.google.dev/gemini-api/docs/pricing';

export interface CatalogEntry {
  model: string;
  /** Dollars par million de tokens d'entrée, palier Standard payant. */
  inputPerMillion: number;
  /** Dollars par million de tokens de sortie, palier Standard payant. */
  outputPerMillion: number;
  /** Renseigné lorsque le modèle est remplacé par un plus récent. */
  supersededBy?: string;
  note?: string;
}

/**
 * Palier « Standard », offre payante, en dollars US.
 *
 * Les paliers Batch (−50 %), Flex et Priority ne sont pas retenus : la
 * passerelle appelle l'API en synchrone, donc au tarif Standard.
 */
export const GEMINI_PUBLIC_CATALOG: readonly CatalogEntry[] = [
  // ── Génération 3.x ──────────────────────────────────────────────────────
  {
    model: 'gemini-3.6-flash',
    inputPerMillion: 1.5,
    outputPerMillion: 7.5,
    note: 'Sortie 17 % moins chère que 3.5 Flash, à intelligence annoncée équivalente.',
  },
  {
    model: 'gemini-3.5-flash',
    inputPerMillion: 1.5,
    outputPerMillion: 9.0,
    supersededBy: 'gemini-3.6-flash',
  },
  { model: 'gemini-3.5-flash-lite', inputPerMillion: 0.3, outputPerMillion: 2.5 },
  { model: 'gemini-3.1-flash-lite', inputPerMillion: 0.25, outputPerMillion: 1.5 },
  { model: 'gemini-3-flash-preview', inputPerMillion: 0.5, outputPerMillion: 3.0 },
  {
    model: 'gemini-3.1-pro-preview',
    inputPerMillion: 2.0,
    outputPerMillion: 12.0,
    note: 'Au-delà de 200 000 tokens : 4,00 $ / 18,00 $. Non modélisé.',
  },

  // ── Génération 2.5 ──────────────────────────────────────────────────────
  {
    model: 'gemini-2.5-pro',
    inputPerMillion: 1.25,
    outputPerMillion: 10.0,
    note: 'Au-delà de 200 000 tokens : 2,50 $ / 15,00 $. Non modélisé.',
  },
  { model: 'gemini-2.5-flash', inputPerMillion: 0.3, outputPerMillion: 2.5 },
  {
    model: 'gemini-2.5-flash-lite',
    inputPerMillion: 0.1,
    outputPerMillion: 0.4,
    note: "Tarif d'entrée le plus bas du catalogue. Des sources secondaires " +
      "annoncent un retrait en octobre 2026 : à confronter à la page des " +
      'dépréciations avant de bâtir dessus.',
  },
] as const;

const BY_MODEL = new Map(GEMINI_PUBLIC_CATALOG.map((e) => [e.model, e]));

export function findCatalogEntry(model: string): CatalogEntry | undefined {
  return BY_MODEL.get(model);
}

/** Convertit une entrée du catalogue en tarif exploitable par la passerelle. */
export function toModelPrice(entry: CatalogEntry): ModelPrice {
  return {
    provider: 'gemini',
    model: entry.model,
    // $/million de tokens ≡ micro-dollars/token : la conversion est l'identité.
    inputMicros: entry.inputPerMillion,
    outputMicros: entry.outputPerMillion,
    currency: 'USD',
    sourceReference: `public-catalog:${CATALOG_SNAPSHOT_DATE}`,
  };
}

/** Modèles du catalogue remplacés par une version plus récente. */
export function listSupersededModels(): CatalogEntry[] {
  return GEMINI_PUBLIC_CATALOG.filter((e) => e.supersededBy);
}
