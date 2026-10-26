'use client';

/**
 * Carte d'entité cliquable — lot 75H.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE CARTE, TOUS LES TIROIRS
 *
 * Dans un tiroir (équipement, pièce, document, échéance, fournisseur…), une
 * carte qui désigne une AUTRE fiche (document associé, échéance, équipement,
 * pièce, fournisseur, bien) ouvre cette fiche :
 *
 * · document / échéance / équipement / pièce : tiroir EMPILÉ au-dessus du
 *   tiroir courant (`openDrawer(t, { stack: true })`), la fermeture ramène au
 *   tiroir d'origine ;
 * · fournisseur / bien : lien vers la page (fiche fournisseur, page du bien),
 *   sauf si l'écran fournit `onOpen` (tiroir fournisseur local, par exemple).
 *
 * Élément interactif RÉEL : un lien `<a href>` (lien profond `?tiroir=` pour
 * les fiches en tiroir — un clic molette / Ctrl ouvre la fiche dans un nouvel
 * onglet) ; Entrée l'active nativement, l'anneau de focus de la charte
 * (globals.css, `a[href]:focus-visible`) s'applique. Nom accessible : type de
 * fiche (texte masqué) + titre + ligne secondaire.
 *
 * Pas d'interactif imbriqué : les badges (`badges`) sont du texte ; les
 * commandes propres à la carte (`actions` : bouton « Statut à confirmer »,
 * menu…) sont rendues À CÔTÉ du lien, dans le même cadre, jamais dedans.
 *
 * Même composant sur ordinateur et téléphone (les tiroirs sont plein écran
 * sur mobile) ; zone cliquable = toute la carte hors `actions`.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Usage (ex. section « Équipements » du tiroir Pièce, lot 75B) :
 *
 *   <EntityCardList>
 *     {equipements.map((e) => (
 *       <EntityCard key={e.id} kind="equipement" id={e.id} title={e.name}
 *         icon={<Wrench className="w-3.5 h-3.5" />} meta={e.type} />
 *     ))}
 *   </EntityCardList>
 */
import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { drawerHref, openDrawer, type DrawerKind } from '@/lib/drawers';
import { supplierHref } from '@/lib/supplier-routes';

export type EntityCardKind = DrawerKind | 'fournisseur' | 'bien';

/** Préfixe lu par les lecteurs d'écran (« Ouvrir le document : Facture… »). */
export const ENTITY_CARD_KIND_LABELS: Record<EntityCardKind, string> = {
  document: 'Ouvrir le document',
  echeance: 'Ouvrir l’échéance',
  equipement: 'Ouvrir l’équipement',
  piece: 'Ouvrir la pièce',
  fournisseur: 'Ouvrir le fournisseur',
  bien: 'Ouvrir le bien',
};

const DRAWER_KINDS: ReadonlySet<EntityCardKind> = new Set<EntityCardKind>(['document', 'echeance', 'equipement', 'piece']);

function isDrawerKind(kind: EntityCardKind): kind is DrawerKind {
  return DRAWER_KINDS.has(kind);
}

/**
 * Adresse portée par la carte : lien profond `?tiroir=` sur la page courante
 * pour une fiche en tiroir, page du fournisseur ou du bien sinon.
 */
export function entityCardHref(kind: EntityCardKind, id: number, path?: string): string {
  if (isDrawerKind(kind)) {
    const here = path ?? (typeof window !== 'undefined' ? window.location.pathname : undefined);
    return drawerHref({ kind, id }, here);
  }
  return kind === 'fournisseur' ? supplierHref(id) : `/assets/${id}`;
}

interface ClickLike {
  preventDefault(): void;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  button?: number;
}

/**
 * Clic sur la carte (pure, testée). Un clic modifié (nouvel onglet, molette)
 * suit le lien. Sinon : `onOpen` de l'écran s'il est fourni, tiroir empilé
 * pour une fiche en tiroir, navigation ordinaire pour une page.
 * Rend `true` si le clic a été pris en charge sans navigation.
 */
export function handleEntityCardClick(
  e: ClickLike,
  { kind, id, onOpen }: { kind: EntityCardKind; id: number; onOpen?: () => void },
): boolean {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (e.button ?? 0) !== 0) return false;
  if (onOpen) {
    e.preventDefault();
    onOpen();
    return true;
  }
  if (isDrawerKind(kind)) {
    e.preventDefault();
    openDrawer({ kind, id }, { stack: true });
    return true;
  }
  return false;
}

interface EntityCardProps {
  kind: EntityCardKind;
  id: number;
  title: string;
  /** Pictogramme (décoratif). */
  icon?: ReactNode;
  /** `box` (défaut) : pictogramme sur pastille ; `plain` : tel quel (icône d'état). */
  iconStyle?: 'box' | 'plain';
  /** Ligne secondaire : date, type, bien… (texte, lu avec le titre). */
  meta?: ReactNode;
  /** Pastilles d'état à droite — NON interactives. */
  badges?: ReactNode;
  /** Commandes propres à la carte, rendues hors du lien (pas d'imbrication). */
  actions?: ReactNode;
  /** Ouverture fournie par l'écran (tiroir local) — sinon comportement par défaut. */
  onOpen?: () => void;
  /** Adresse imposée (sinon `entityCardHref`). */
  href?: string;
  /** Fiche indisponible (bien archivé, verrouillé…) : carte non cliquable. */
  disabled?: boolean;
  className?: string;
  'data-testid'?: string;
}

const CARD = 'rounded-lg bg-[color:var(--bg-subtle)] border border-border/60 text-sm';
const CARD_HOVER = 'hover:border-[color:var(--border-info)] hover:bg-[color:var(--accent-soft)] transition-colors';
const ROW = 'flex items-start gap-2.5 p-2.5 text-left';

/**
 * Sans hook : appelable comme une fonction dans les tests (environnement
 * `node`, sans DOM).
 */
export function EntityCard({
  kind, id, title, icon, iconStyle = 'box', meta, badges, actions, onOpen, href, disabled = false, className = '',
  'data-testid': testId,
}: EntityCardProps) {
  const body = (
    <>
      {icon && (
        <span
          aria-hidden
          className={iconStyle === 'plain'
            ? 'flex items-center flex-shrink-0 mt-0.5'
            : 'w-6 h-6 rounded-md bg-muted/40 flex items-center justify-center flex-shrink-0 mt-0.5 text-muted-foreground'}
        >
          {icon}
        </span>
      )}
      <span className="flex-1 min-w-0">
        {!disabled && <span className="sr-only">{ENTITY_CARD_KIND_LABELS[kind]} : </span>}
        <span className="block font-medium text-foreground truncate text-xs leading-tight">{title}</span>
        {meta && <span className="block mt-1 text-[10px] text-muted-foreground">{meta}</span>}
      </span>
      {badges && <span className="flex items-center gap-1.5 flex-shrink-0">{badges}</span>}
      {!disabled && (
        <ChevronRight aria-hidden className="w-3.5 h-3.5 mt-0.5 text-muted-foreground flex-shrink-0" />
      )}
    </>
  );

  if (disabled) {
    return (
      <div className={`${CARD} ${ROW} ${className}`} data-testid={testId} data-entity-card={kind}>
        {body}
      </div>
    );
  }

  const link = (
    <a
      href={href ?? entityCardHref(kind, id)}
      onClick={(e) => { handleEntityCardClick(e, { kind, id, onOpen }); }}
      className={actions ? `${ROW} flex-1 min-w-0 rounded-lg` : `${CARD} ${CARD_HOVER} ${ROW} ${className}`}
      data-testid={actions ? undefined : testId}
      data-entity-card={actions ? undefined : kind}
    >
      {body}
    </a>
  );

  if (!actions) return link;

  return (
    <div className={`${CARD} ${CARD_HOVER} flex items-start ${className}`} data-testid={testId} data-entity-card={kind}>
      {link}
      <div className="flex items-center gap-1.5 flex-shrink-0 self-center pr-2.5">{actions}</div>
    </div>
  );
}

/** Liste de cartes (espacement des tiroirs). */
export function EntityCardList({ children }: { children: ReactNode }) {
  return <div className="space-y-1.5">{children}</div>;
}
