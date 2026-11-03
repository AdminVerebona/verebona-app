'use client';

/**
 * Lot 107E — liens directs d'une carte « À traiter » (mobile et ordinateur).
 *
 * Présentation compacte, sous les propositions :
 *   69,99 € · [Voir la facture]
 *   [Voir la fiche]  [Voir les justificatifs (3)]
 *
 * · Liens textuels explicites, icône à gauche, nom accessible complet
 *   (« Voir la facture justifiant « 69,99 € » ») ; zone tactile de 36 px de
 *   haut au moins en mobile (§16.1), plus serrée à partir de `sm` ; anneau de
 *   focus de la charte ; couleurs par jetons uniquement (aucune couleur brute).
 * · « Voir les justificatifs » : repli natif `<details>` — accessible au
 *   clavier et au lecteur d'écran, sans état React : il reste déplié quand un
 *   tiroir s'ouvre par-dessus, et la carte retrouve son état à la fermeture.
 * · Aucun lien n'est dans un bouton de choix ni dans un formulaire : toucher
 *   un lien ne choisit, ne valide ni ne refuse rien (`openCardLink`).
 * · Composant SANS hook (testé en l'appelant comme une fonction).
 */
import { Calendar, FileText, Files, Home, Package, Wrench, LayoutGrid, Info } from 'lucide-react';
import type { CardLinkRef, CardLinks as CardLinksData } from '@/services/to-process/card-links';
import { cardLinksModel, type CardLinkItem } from '@/lib/to-process-links';
import { openCardLink } from './card-link-open';

export const CARD_LINK_CLASS =
  'inline-flex min-h-9 max-w-full items-center gap-1 rounded-md text-left text-xs font-medium text-[color:var(--accent)] underline-offset-2 hover:underline focus-visible:underline sm:min-h-7';

function LinkIcon({ kind }: { kind: CardLinkRef['kind'] | 'documents' }) {
  const cls = 'h-3.5 w-3.5 shrink-0';
  if (kind === 'document') return <FileText className={cls} aria-hidden />;
  if (kind === 'documents') return <Files className={cls} aria-hidden />;
  if (kind === 'asset') return <Home className={cls} aria-hidden />;
  if (kind === 'equipement') return <Wrench className={cls} aria-hidden />;
  if (kind === 'piece') return <LayoutGrid className={cls} aria-hidden />;
  if (kind === 'echeance' || kind === 'reference') return <Calendar className={cls} aria-hidden />;
  return <Package className={cls} aria-hidden />;
}

interface Props {
  cardId: string;
  proposals: ReadonlyArray<{ label: string; isCurrentValue?: boolean }>;
  links: CardLinksData | null | undefined;
  /** Navigation de l'application (page d'un bien, fiche fournisseur). */
  navigate?: (href: string) => void;
}

export function CardLinkButton({ cardId, item, target, text, aria, navigate }: {
  cardId: string; item: string; target: CardLinkRef; text: string; aria: string; navigate?: (href: string) => void;
}) {
  return (
    <button
      type="button"
      data-card-link={item}
      data-link-kind={target.kind}
      aria-label={aria}
      onClick={(e) => { void openCardLink(e, cardId, target, item, { navigate }); }}
      className={CARD_LINK_CLASS}
    >
      <LinkIcon kind={target.kind} />
      <span className="[overflow-wrap:anywhere]">{text}</span>
    </button>
  );
}

function Item({ cardId, item, navigate }: { cardId: string; item: CardLinkItem; navigate?: (href: string) => void }) {
  if (item.type === 'link') {
    return <CardLinkButton cardId={cardId} item={item.key} target={item.ref} text={item.text} aria={item.aria} navigate={navigate} />;
  }
  return (
    <details data-card-documents={item.key} className="max-w-full basis-full">
      <summary aria-label={item.aria} className={`${CARD_LINK_CLASS} cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden`}>
        <LinkIcon kind="documents" />
        <span>{item.text}</span>
      </summary>
      <ul className="mt-0.5 space-y-0.5 border-l border-[color:var(--border)] pl-3">
        {item.docs.map((d) => (
          <li key={d.id}>
            <CardLinkButton
              cardId={cardId}
              item={`${item.key}:${d.id}`}
              target={d}
              text={d.label}
              aria={`${d.invoice ? 'Voir la facture' : 'Voir le document'} — ${d.label}`}
              navigate={navigate}
            />
          </li>
        ))}
      </ul>
    </details>
  );
}

export function CardLinks({ cardId, proposals, links, navigate }: Props) {
  const model = cardLinksModel(proposals, links);
  if (!model) return null;
  return (
    <div data-card-links className="mt-2 flex min-w-0 max-w-full flex-col gap-0.5 text-xs text-muted-foreground">
      {model.lines.length > 0 && (
        <ul data-card-proposal-sources className="space-y-0.5">
          {model.lines.map((l) => (
            <li key={l.index} data-proposal-index={l.index} className="flex min-w-0 flex-wrap items-center gap-x-1.5">
              <span className="min-w-0 [overflow-wrap:anywhere]">{l.value}</span>
              <span aria-hidden="true">·</span>
              {l.items.map((it) => <Item key={it.key} cardId={cardId} item={it} navigate={navigate} />)}
              {l.unavailable > 0 && l.items.length === 0 && (
                <span data-card-link-unavailable className="inline-flex min-h-9 items-center gap-1 sm:min-h-7">
                  <Info className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  justificatif plus disponible
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {model.nav.length > 0 && (
        <div data-card-nav className="flex min-w-0 flex-wrap items-center gap-x-4">
          {model.nav.map((it) => <Item key={it.key} cardId={cardId} item={it} navigate={navigate} />)}
        </div>
      )}
      {model.notes.map((n) => (
        <p key={n} data-card-link-unavailable className="inline-flex items-center gap-1">
          <Info className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {n}
        </p>
      ))}
    </div>
  );
}
