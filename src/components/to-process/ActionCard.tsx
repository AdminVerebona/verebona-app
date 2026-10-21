'use client';

/**
 * Carte d'action — CDC V2.0 §8.4, §8.5, §8.6, §16.2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE PRÉSENTATION : LES CARTES
 *
 * Lot 60A (point 6, retour utilisateur du 15/10) : la vue « Liste »
 * (`ActionRow`, CDC §8.2 / §8.7) est supprimée — écart assumé au CDC. La
 * carte est la seule présentation, dans la file « À traiter » comme dans les
 * choix ouverts depuis la mascotte (`TodoChoicesDialog`) : propositions
 * cliquables, « Ouvrir », source ouvrable, nature et priorité.
 *
 * ── LES PROPOSITIONS PASSENT À LA LIGNE (lot 60A, point 7) ────────────────
 *
 * Une proposition longue (« Oui, « Entretien réalisé — Peugeot 3008 Hybrid -
 * 2022 » du 19/10/2025 ») débordait de la carte et recouvrait son texte :
 * hauteur fixe, libellé sur une ligne. Les boutons de choix passent
 * désormais à la ligne entre eux (flex-wrap) ET sur plusieurs lignes dans
 * leur propre libellé, sans dépasser la largeur de la carte — lisibles à
 * 360 px, sans défilement horizontal.
 *
 * ── LA PRIORITÉ N'EST PAS PORTÉE PAR LA COULEUR SEULE ─────────────────────
 *
 * §16.2 : « Ne pas communiquer une priorité ou un état uniquement par la
 * couleur. » Les badges portent donc leur libellé en toutes lettres. C'est
 * aussi ce qui les rend lisibles à 320 px sans dépendre d'une légende.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FileText, Image as ImageIcon, Home, Package, Calendar, Wrench, LayoutGrid } from 'lucide-react';
import { ACTION_KIND_LABELS, INTERVENTION_CARD_LABEL, MICROCOPY } from '@/lib/referential/v2/microcopy';
import { PRIORITY_LABELS } from '@/services/to-process/priority';
import type { ActionKind, ActionPriority } from '@/services/to-process/action-model';
import { openCardDocumentPreview, previewAriaLabel } from './document-preview';

export interface ActionProposalView {
  value: string | number | boolean | null;
  label: string;
  isCurrentValue?: boolean;
  sourceContext?: { label: string };
}

export interface ActionView {
  publicId: string;
  targetType: 'DOCUMENT' | 'ASSET' | 'EQUIPMENT' | 'ROOM' | 'AGENDA_ITEM' | 'SUPPLIER';
  targetId: number;
  fieldKey: string | null;
  relationKey: string | null;
  actionKind: ActionKind;
  priority: ActionPriority;
  ruleCode: string;
  question: string;
  proposals: ActionProposalView[];
  /** Lot 28 — « À compléter » saisissable sur la carte (sinon : le tiroir). */
  inputType?: 'date' | 'text' | null;
  target: {
    label: string;
    mimeType?: string | null;
    /** Lot 34, point 11 — miniature signée du document (vue Cartes). */
    thumbnailUrl?: string | null;
    publicId?: string | null;
    assetName?: string | null;
    /** Fournisseur résolu (cible SUPPLIER) — ouvre `/fournisseurs/[id]`. */
    supplierId?: number | null;
  };
}

interface Handlers {
  onChoose: (action: ActionView, value: ActionProposalView) => void;
  /** « Autre » et « Ouvrir » mènent au même endroit : le drawer, sur le champ. */
  onOpenTarget: (action: ActionView) => void;
  busy?: boolean;
  /**
   * Carte ciblée par son ID (mascotte, OPEN_TODO_CARD — lot 32) : mise en
   * évidence, le temps que l'utilisateur la repère.
   */
  focused?: boolean;
}

/** Ancre DOM d'une carte, par l'ID de l'action — jamais par son libellé. */
export const todoCardDomId = (publicId: string) => `todo-${publicId}`;

function TargetIcon({ action, className = 'h-4 w-4 text-muted-foreground shrink-0' }: { action: ActionView; className?: string }) {
  if (action.targetType === 'DOCUMENT') {
    return action.target.mimeType?.startsWith('image/')
      ? <ImageIcon className={className} aria-hidden />
      : <FileText className={className} aria-hidden />;
  }
  if (action.targetType === 'ASSET') return <Home className={className} aria-hidden />;
  if (action.targetType === 'EQUIPMENT') return <Wrench className={className} aria-hidden />;
  if (action.targetType === 'ROOM') return <LayoutGrid className={className} aria-hidden />;
  if (action.targetType === 'AGENDA_ITEM') return <Calendar className={className} aria-hidden />;
  // Icône générique (fournisseur, cible inconnue).
  return <Package className={className} aria-hidden />;
}

/**
 * Visuel à droite de la carte (lot 34, point 11).
 *
 * Document : sa miniature SERVEUR (jamais l'original), fournie par la réponse
 * de la file (`target.thumbnailUrl`, URL signée stable pendant l'heure — mêmes
 * vignettes que l'accueil et « Mes documents ») : aucune requête par carte vers
 * l'application, chargement paresseux, décodage asynchrone. URL devenue
 * illisible (onglet resté ouvert) : un essai par la route autorisée
 * `/api/files/:id/thumbnail`, puis l'icône — comme `RecentDocPreview`.
 * Sans miniature : l'icône de la cible (échéance → agenda, bien, équipement,
 * pièce…), sinon une icône générique. Plus petit sur mobile.
 *
 * Lot 76E : la miniature est un BOUTON qui ouvre le tiroir du document
 * (`DocumentPreviewButton`) ; l'icône de repli reste décorative.
 */
export function CardVisual({ action }: { action: ActionView }) {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const url = action.targetType === 'DOCUMENT' ? action.target.thumbnailUrl ?? null : null;
  const src = !url ? null : step === 0 ? url : step === 1 ? `/api/files/${action.targetId}/thumbnail` : null;
  if (src) {
    return <DocumentPreviewButton action={action} src={src} onImageError={() => setStep((x) => (x === 0 ? 1 : 2))} />;
  }
  return (
    <span data-card-visual="icon" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] bg-[color:var(--accent-soft)] sm:h-14 sm:w-14">
      <TargetIcon action={action} className="h-5 w-5 text-[color:var(--accent)] sm:h-6 sm:w-6" />
    </span>
  );
}

/**
 * Lot 76E — vignette d'aperçu cliquable (clic, tap, Entrée / Espace) : ouvre
 * le tiroir document existant, sans déclencher d'action de la carte
 * (`openCardDocumentPreview`). Bouton natif hors du corps de la carte (jamais
 * dans un formulaire ni dans un autre contrôle) ; anneau de focus de la
 * charte (globals.css) ; même composant sur mobile et sur ordinateur.
 * Sans hook : testé en l'appelant comme une fonction.
 */
export function DocumentPreviewButton({ action, src, onImageError }: { action: ActionView; src: string; onImageError: () => void }) {
  return (
    <button
      type="button"
      data-card-visual="thumbnail"
      aria-label={previewAriaLabel(action)}
      onClick={(e) => { void openCardDocumentPreview(e, action); }}
      className="relative block h-14 w-11 shrink-0 cursor-pointer overflow-hidden rounded-[8px] border bg-[color:var(--vb-blanc)] p-0 transition-[border-color] duration-[180ms] hover:border-[color:var(--accent)] sm:h-[88px] sm:w-[68px]"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- miniature autorisée (APP-PERF-06), icône si absente */}
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        onError={onImageError}
        className="absolute inset-0 h-full w-full object-cover object-top"
      />
    </button>
  );
}

/**
 * Lot 61 : carte d'intervention réelle (règle DOC-INTERVENTION) — libellé de
 * nature « Action à mener », choix « C'est fait » / « Pas nécessaire », et
 * « Ouvrir » (le document) au lieu de « Autre ». Même composant sur mobile et
 * sur ordinateur.
 */
export const isInterventionCard = (action: Pick<ActionView, 'ruleCode'>) => action.ruleCode === 'DOC-INTERVENTION';

/**
 * Lot 76E — étiquettes nature / priorité (retour PO du 21/10/2026, variante 1).
 *
 * Elles chargeaient la carte et se confondaient avec les boutons, entre le
 * texte et les choix. Elles passent EN BAS À DROITE : sous la vignette (ou
 * l'icône) à partir de `sm`, sur leur propre ligne sous les boutons en
 * mobile, en fin de carte sans visuel (mascotte). Texte discret, sans
 * bordure ni fond : rien qui ressemble à un bouton. Ordre DOM = ordre visuel
 * (question, cible, boutons, étiquettes). La priorité reste écrite en toutes
 * lettres (§16.2) ; le séparateur est ignoré des lecteurs d'écran et masqué
 * quand les étiquettes s'empilent (≥ sm, sous la vignette).
 */
function Tags({ action, className = '' }: { action: ActionView; className?: string }) {
  return (
    <p data-card-tags className={`flex max-w-full flex-wrap items-center justify-end gap-x-1.5 gap-y-0.5 text-right text-[11px] leading-snug text-muted-foreground ${className}`}>
      <span data-card-tag="kind">{isInterventionCard(action) ? INTERVENTION_CARD_LABEL : ACTION_KIND_LABELS[action.actionKind]}</span>
      <span aria-hidden="true" className="sm:hidden">·</span>
      <span data-card-tag="priority">{PRIORITY_LABELS[action.priority]}</span>
    </p>
  );
}

/**
 * Classes d'un bouton de proposition (lot 60A, point 7) : 36 px de haut AU
 * MOINS (zone tactile, §16.1) mais hauteur libre, libellé sur plusieurs
 * lignes (jamais `whitespace-nowrap` ni troncature), largeur bornée à la
 * carte, coupure des mots trop longs. Coins adoucis plutôt qu'en pilule pour
 * un libellé sur deux lignes.
 */
export const PROPOSAL_BUTTON_CLASS = 'h-auto min-h-9 max-w-full whitespace-normal rounded-2xl py-1.5 text-left leading-snug';

/**
 * Contrôles de résolution. Les zones tactiles restent à 36 px de haut au
 * moins et les propositions passent à la ligne plutôt que de se tronquer
 * (§16.1).
 */
function Controls({ action, onChoose, onOpenTarget, busy }: { action: ActionView } & Handlers) {
  if (action.actionKind === 'COMPLETE' && action.inputType) {
    return <InlineCompletion action={action} onChoose={onChoose} onOpenTarget={onOpenTarget} busy={busy} />;
  }
  if (action.actionKind === 'COMPLETE') {
    return (
      <Button
        size="sm"
        variant="default"
        disabled={busy}
        onClick={() => onOpenTarget(action)}
        className="h-9"
      >
        {MICROCOPY.open}
      </Button>
    );
  }

  return (
    <div data-proposals className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
      {action.proposals.map((proposal, index) => (
        <Button
          key={`${action.publicId}-${index}`}
          size="sm"
          variant={proposal.isCurrentValue ? 'secondary' : 'default'}
          disabled={busy}
          onClick={() => onChoose(action, proposal)}
          className={PROPOSAL_BUTTON_CLASS}
        >
          <span data-proposal-label className="min-w-0 [overflow-wrap:anywhere]">
            {proposal.label}
            {proposal.isCurrentValue && (
              // §8.5 : la valeur actuelle est proposée pour confirmation, et
              // identifiée « discrètement ».
              <span className="ml-1.5 whitespace-nowrap text-[11px] opacity-70">(actuelle)</span>
            )}
          </span>
        </Button>
      ))}
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => onOpenTarget(action)}
        className="h-9"
      >
        {isInterventionCard(action) ? MICROCOPY.open : MICROCOPY.otherChoice}
      </Button>
    </div>
  );
}

/**
 * « À compléter » en ligne (lot 28) : une date de fin de contrat ou de
 * garantie se saisit sur la carte, sans ouvrir le document. La valeur suit
 * le même chemin qu'une proposition retenue (résolution atomique, toast
 * « Annuler »). « Ouvrir » ouvre toujours l'objet.
 */
function InlineCompletion({ action, onChoose, onOpenTarget, busy }: { action: ActionView } & Handlers) {
  const [value, setValue] = useState('');
  const trimmed = value.trim();
  const label = action.inputType === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? trimmed.split('-').reverse().join('/')
    : trimmed;
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (trimmed) onChoose(action, { value: trimmed, label });
      }}
    >
      <Input
        type={action.inputType === 'date' ? 'date' : 'text'}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={busy}
        aria-label={action.question}
        className="h-9 w-auto min-w-[10rem]"
      />
      <Button type="submit" size="sm" variant="default" disabled={busy || !trimmed} className="h-9">
        Valider
      </Button>
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onOpenTarget(action)} className="h-9">
        {MICROCOPY.open}
      </Button>
    </form>
  );
}

/** Source affichée « légèrement », et ouvrable quand elle existe (§8.4, UX-03). */
function Source({ action, onOpenTarget }: { action: ActionView; onOpenTarget: Handlers['onOpenTarget'] }) {
  const source = action.proposals.find((p) => p.sourceContext)?.sourceContext;
  if (!source) return null;
  return (
    <button
      type="button"
      onClick={() => onOpenTarget(action)}
      className="text-left text-xs text-muted-foreground underline-offset-2 hover:underline focus-visible:underline"
    >
      {source.label}
    </button>
  );
}

export function ActionCard({ action, focused, visual = false, ...handlers }: { action: ActionView; visual?: boolean } & Handlers) {
  return (
    <article
      id={todoCardDomId(action.publicId)}
      data-todo-id={action.publicId}
      aria-current={focused ? 'true' : undefined}
      className={`scroll-mt-24 rounded-[16px] border border-[color:var(--border)] bg-card p-4 transition-[border-color] duration-[180ms] focus-within:border-[color:var(--accent)] ${visual ? 'flex items-start gap-3 sm:gap-4 flex-wrap sm:flex-nowrap' : ''} ${focused ? 'border-[color:var(--accent)] ring-1 ring-[color:var(--accent)]' : ''}`}
    >
      {visual ? (
        <>
          <div className="min-w-0 flex-1"><CardBody action={action} {...handlers} /></div>
          {/* Lot 34, point 11 : vignette ou icône de la cible, à droite.
              Lot 76E : étiquettes dessous (≥ sm) ; en mobile la colonne est
              « transparente » (`contents`) et les étiquettes passent sur
              leur propre ligne, en bas à droite, sous les boutons. */}
          <div data-card-aside className="contents sm:flex sm:shrink-0 sm:flex-col sm:items-end sm:justify-between sm:gap-2 sm:self-stretch">
            <CardVisual action={action} />
            <Tags action={action} className="basis-full sm:basis-auto sm:flex-col sm:items-end" />
          </div>
        </>
      ) : (
        <>
          <CardBody action={action} {...handlers} />
          <Tags action={action} className="mt-3" />
        </>
      )}
    </article>
  );
}

function CardBody({ action, ...handlers }: { action: ActionView } & Handlers) {
  return (
    <>
      {/* §8.4 : la question est l'élément dominant. */}
      <h3 className="text-[14.5px] font-semibold leading-snug">{action.question}</h3>

      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        <TargetIcon action={action} />
        <span className="truncate">{action.target.label}</span>
        {action.target.assetName && (
          <>
            <span aria-hidden>·</span>
            <span className="truncate">{action.target.assetName}</span>
          </>
        )}
      </div>

      <div className="mt-3">
        <Controls action={action} {...handlers} />
      </div>

      <div className="mt-2">
        <Source action={action} onOpenTarget={handlers.onOpenTarget} />
      </div>
    </>
  );
}
