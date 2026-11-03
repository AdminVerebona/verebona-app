/**
 * Lot 107E — présentation des liens directs d'une carte « À traiter » (pure,
 * testée sans DOM). Le serveur fournit des identifiants typés et vérifiés
 * (`services/to-process/card-links.ts`) ; ce module décide seulement QUOI
 * afficher, sans surcharge ni répétition :
 *
 *   · une ligne par proposition JUSTIFIÉE : « 69,99 € · Voir la facture » —
 *     la proposition sans source n'en reçoit aucune (jamais de justificatif
 *     factice, notamment pour la valeur actuelle) ;
 *   · une rangée de liens de la carte : justificatif(s) de la carte, objet
 *     (« Voir la fiche », « Voir le document », « Voir l’événement »), objets
 *     liés (« Voir l’événement de référence ») ;
 *   · un document déjà offert n'est pas répété (la facture CIBLE de la carte
 *     n'est pas reproposée sur chaque ligne) ;
 *   · plusieurs justificatifs → « Voir les justificatifs (n) », liste limitée
 *     aux preuves de la carte ;
 *   · source ou objet devenu inaccessible → état écrit, jamais un lien.
 *
 * Le mot « Opération » n'apparaît jamais : « événement de référence ».
 */
import type { CardLinkKind, CardLinkRef, CardLinks } from '@/services/to-process/card-links';

export const CARD_LINK_TEXT = {
  invoice: 'Voir la facture',
  document: 'Voir le document',
  sheet: 'Voir la fiche',
  event: 'Voir l’événement',
  reference: 'Voir l’événement de référence',
  documents: (n: number) => `Voir les justificatifs (${n})`,
  unavailableOne: 'Justificatif plus disponible',
  unavailableMany: (n: number) => `${n} justificatifs plus disponibles`,
  proposalUnavailable: 'justificatif plus disponible',
  objectUnavailable: {
    document: 'Document plus disponible',
    asset: 'Fiche plus disponible',
    equipement: 'Fiche plus disponible',
    piece: 'Fiche plus disponible',
    supplier: 'Fiche plus disponible',
    echeance: 'Événement plus disponible',
    reference: 'Événement plus disponible',
  } satisfies Record<CardLinkKind, string>,
} as const;

export function cardLinkText(ref: Pick<CardLinkRef, 'kind' | 'invoice'>): string {
  switch (ref.kind) {
    case 'document': return ref.invoice ? CARD_LINK_TEXT.invoice : CARD_LINK_TEXT.document;
    case 'echeance': return CARD_LINK_TEXT.event;
    case 'reference': return CARD_LINK_TEXT.reference;
    default: return CARD_LINK_TEXT.sheet;
  }
}

export type CardLinkItem =
  | { type: 'link'; key: string; ref: CardLinkRef; text: string; aria: string }
  | { type: 'documents'; key: string; docs: CardLinkRef[]; text: string; aria: string };

export interface CardProposalLine {
  index: number;
  /** Libellé de la proposition, tel que sur son bouton. */
  value: string;
  items: CardLinkItem[];
  unavailable: number;
}

export interface CardLinksModel {
  lines: CardProposalLine[];
  nav: CardLinkItem[];
  notes: string[];
}

interface ProposalLike { label: string; isCurrentValue?: boolean }

export const refKey = (r: Pick<CardLinkRef, 'kind' | 'id'>) => `${r.kind}:${r.id}`;

function linkItem(ref: CardLinkRef, scope: string, about?: string): CardLinkItem {
  const text = cardLinkText(ref);
  return {
    type: 'link', key: `${scope}:${refKey(ref)}`, ref, text,
    aria: about ? `${text} justifiant « ${about} »` : `${text} — ${ref.label}`,
  };
}

function docsItem(docs: CardLinkRef[], scope: string, about?: string): CardLinkItem {
  if (docs.length === 1) return linkItem(docs[0], scope, about);
  const text = CARD_LINK_TEXT.documents(docs.length);
  return { type: 'documents', key: `${scope}:docs`, docs, text, aria: about ? `${text} justifiant « ${about} »` : text };
}

const sameSet = (a: number[], b: number[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Modèle d'affichage des liens d'une carte (pur). `null` : rien à afficher. */
export function cardLinksModel(proposals: readonly ProposalLike[], links: CardLinks | null | undefined): CardLinksModel | null {
  if (!links) return null;
  const byId = new Map(links.documents.map((d) => [d.id, d]));
  const objectDoc = links.object?.kind === 'document' ? links.object.id : null;
  const notes: string[] = [];

  // Lignes candidates : sources de chaque proposition, hors document cible.
  const raw = proposals.map((p, index) => {
    const pl = links.proposals[index];
    const ids = (pl?.documents ?? []).filter((id) => id !== objectDoc && byId.has(id));
    return {
      index,
      value: p.isCurrentValue ? `${p.label} (actuelle)` : p.label,
      ids,
      target: pl?.target ?? null,
      unavailable: pl?.unavailable ?? 0,
    };
  }).filter((l) => l.ids.length > 0 || l.target || l.unavailable > 0);

  // Plusieurs propositions justifiées par EXACTEMENT les mêmes pièces : une
  // seule entrée dans la rangée (pas la même facture répétée sur chaque ligne).
  const collapse = raw.length >= 2 && raw.every((l) => !l.target && l.unavailable === 0 && sameSet(l.ids, raw[0].ids));
  const lines: CardProposalLine[] = collapse ? [] : raw.map((l) => ({
    index: l.index,
    value: l.value,
    unavailable: l.unavailable,
    items: [
      ...(l.ids.length ? [docsItem(l.ids.map((id) => byId.get(id)!), `p${l.index}`, l.value)] : []),
      ...(l.target ? [linkItem(l.target, `p${l.index}`)] : []),
    ],
  }));

  const navDocIds = [...new Set([
    ...links.cardDocuments.filter((id) => id !== objectDoc && byId.has(id)),
    ...(collapse ? raw[0].ids : []),
  ])];
  const nav: CardLinkItem[] = [];
  if (links.object?.kind === 'document') nav.push(linkItem(links.object, 'o'));
  if (navDocIds.length) nav.push(docsItem(navDocIds.map((id) => byId.get(id)!), 'c'));
  if (links.object && links.object.kind !== 'document') nav.push(linkItem(links.object, 'o'));
  for (const r of links.related) nav.push(linkItem(r, 'r'));

  if (links.objectUnavailable) notes.push(CARD_LINK_TEXT.objectUnavailable[links.objectUnavailable]);
  if (links.unavailable === 1) notes.push(CARD_LINK_TEXT.unavailableOne);
  else if (links.unavailable > 1) notes.push(CARD_LINK_TEXT.unavailableMany(links.unavailable));

  if (!lines.length && !nav.length && !notes.length) return null;
  return { lines, nav, notes };
}
