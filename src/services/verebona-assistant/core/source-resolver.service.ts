/**
 * Résolveur de sources & explicabilité — CDC §19.
 *
 * Transforme les `RetrievedSource` (internes) en `ResolvedSource` (affichables) :
 * type lisible, titre, extrait ≤ 240 car., date utile, disponibilité, action d'ouverture.
 * Construit aussi le mapping claim↔source pour « Pourquoi ? » (§19.6-19.8).
 */
import { randomUUID } from 'crypto';
import type { RetrievedSource, ResolvedSource, SourceType, Claim } from '../types/sources';
import type { VerebonaAction } from '../types/actions';
import { getAssistantConfig } from '../config/assistant-config';
import { parseEntityRef, hrefEntite } from './entity-ref';
import { integratedHelpHref } from '@/lib/help-center/open';

export const TYPE_LABELS: Record<SourceType, string> = {
  asset_field: 'Bien', document: 'Document', document_extraction: 'Donnée extraite',
  agenda_item: 'Échéance', supplier: 'Fournisseur', to_process_item: 'À traiter',
  help_entry: 'Aide', product_rule: "Règle d'offre",
};

/**
 * Sources résolues — TOUTES celles de la réponse (≤ `maxSources`, 8), et non
 * plus les 5 premières : tronquer avant persistance perdait les sources 6 à 8
 * et leurs liens claim → source (§19.3). L'affichage en montre 5, puis
 * « Voir toutes les sources » (pagination de la route sources, §27.8).
 */
export function resolveSourcesForDisplay(sources: RetrievedSource[]): ResolvedSource[] {
  const cfg = getAssistantConfig();
  return sources.slice(0, Math.max(cfg.maxSources, cfg.maxVisibleSources)).map((s) => ({
    // Conservé : c'est ce qui relie une citation à son document.
    id: s.id,
    type: s.type,
    typeLabel: TYPE_LABELS[s.type],
    title: s.title,
    linkedAssetLabel: typeof s.meta?.assetName === 'string' ? s.meta.assetName : null,
    usefulDate: typeof s.meta?.date === 'string' ? s.meta.date : null,
    excerpt: s.content.slice(0, 240),
    statusLabel: typeof s.meta?.statusLabel === 'string' ? s.meta.statusLabel : null,
    relevanceScore: typeof s.relevanceScore === 'number' ? s.relevanceScore : null,
    // Article d'aide : version du corpus (§19.13, §28.4 `source_version`).
    sourceVersion: typeof s.meta?.version === 'string' ? s.meta.version
      : typeof s.meta?.corpusVersion === 'string' ? s.meta.corpusVersion : null,
    // Optimiste par défaut ; `marquerDisponibilite` tranche juste avant
    // l'affichage (§19.10). Vérifier ici forcerait une requête par source
    // dans une boucle de rendu.
    isAvailable: true,
    openAction: ouvertureDeSource(s),
  }));
}

/**
 * Action d'ouverture attachée à une source — §19.9.
 *
 * Le champ était annoncé « rempli par action-resolver » et restait nul : une
 * source affichée ne menait donc nulle part, ce qui vide le §19.9 de son objet.
 *
 * Aucun contrôle d'accès n'est refait ici, et c'est délibéré : les sources
 * sortent du retrieval, qui est déjà cloisonné par compte et vérifié par
 * `verifierPerimetre` (§29.1). Le refaire coûterait une requête par source dans
 * une boucle d'affichage, pour la même réponse.
 *
 * Les sources sans destination (règle d'offre, article d'aide, élément
 * « À traiter ») renvoient `null` plutôt qu'un lien approximatif.
 */
function ouvertureDeSource(source: RetrievedSource): VerebonaAction | null {
  // Article du Centre d'aide : « sources cliquables » (CDC Centre d'aide §5).
  // Ouvert dans le Centre d'aide intégré de l'application.
  if (source.type === 'help_entry' && typeof source.meta?.path === 'string') {
    const path = source.meta.path.split('#')[0];
    return {
      actionId: randomUUID(),
      type: 'OPEN_HELP',
      label: 'Lire l’article',
      href: integratedHelpHref(path),
      token: null,
      requiresConfirmation: false,
      expiresAt: null,
      analyticsCode: 'verebona.source.open_help',
    };
  }
  const ref = parseEntityRef(source.id);
  if (!ref) return null;

  const href = hrefEntite(ref, source.meta);
  if (!href) return null;

  const type = ref.kind === 'document' ? 'OPEN_DOCUMENT'
    : ref.kind === 'agenda_item' ? 'OPEN_AGENDA_ITEM'
      : ref.kind === 'supplier' ? 'OPEN_SUPPLIER'
        : 'OPEN_ASSET';
  return {
    actionId: randomUUID(),
    type,
    label: 'Ouvrir',
    href,
    token: null,
    requiresConfirmation: false,
    expiresAt: null,
    analyticsCode: 'verebona.source.open',
  };
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
