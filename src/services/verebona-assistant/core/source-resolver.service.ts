/**
 * Résolveur de sources & explicabilité — CDC §19.
 *
 * Transforme les `RetrievedSource` (internes) en `ResolvedSource` (affichables) :
 * type lisible, titre, extrait ≤ 240 car., date utile, disponibilité, action d'ouverture.
 * Construit aussi le mapping claim↔source pour « Pourquoi ? » (§19.6-19.8).
 */
import type { RetrievedSource, ResolvedSource, SourceType, Claim } from '../types/sources';
import { getAssistantConfig } from '../config/assistant-config';

const TYPE_LABELS: Record<SourceType, string> = {
  asset_field: 'Bien', document: 'Document', document_extraction: 'Donnée extraite',
  agenda_item: 'Échéance', supplier: 'Fournisseur', to_process_item: 'À traiter',
  help_entry: 'Aide', product_rule: "Règle d'offre",
};

export function resolveSourcesForDisplay(sources: RetrievedSource[]): ResolvedSource[] {
  const cfg = getAssistantConfig();
  return sources.slice(0, cfg.maxVisibleSources).map((s) => ({
    // Conservé : c'est ce qui relie une citation à son document.
    id: s.id,
    type: s.type,
    typeLabel: TYPE_LABELS[s.type],
    title: s.title,
    linkedAssetLabel: (s.meta?.assetName as string) ?? null,
    usefulDate: (s.meta?.date as string) ?? null,
    excerpt: s.content.slice(0, 240),
    // Optimiste par défaut ; `marquerDisponibilite` tranche juste avant
    // l'affichage (§19.10). Vérifier ici forcerait une requête par source
    // dans une boucle de rendu.
    isAvailable: true,
    openAction: null,  // rempli par action-resolver si l'ouverture est autorisée
  }));
}

/**
 * Explication « Pourquoi ? » — §19.7.
 *
 * Rapproche chaque affirmation des TITRES de ses sources, non de leurs
 * identifiants. « doc_128 » ne dit rien à personne ; « Acte de vente du
 * 14 mars 2025 » permet de vérifier.
 *
 * Un identifiant sans correspondance est conservé tel quel plutôt qu'écarté :
 * une affirmation dont une source a disparu de l'affichage reste une
 * affirmation sourcée, et le masquer donnerait à croire qu'elle sort de nulle
 * part.
 */
export function buildExplanation(
  claims: Claim[],
  sources: ResolvedSource[],
): Array<{ claim: string; sources: string[] }> {
  const titreParId = new Map(sources.map((s) => [s.id, s.title]));
  return claims.map((c) => ({
    claim: c.text,
    sources: c.sourceIds.map((id) => titreParId.get(id) ?? id),
  }));
}
