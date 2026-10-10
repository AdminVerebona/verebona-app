'use client';

/**
 * Carte et ligne d'action — CDC V2.0 §8.4, §8.5, §8.6, §8.7, §16.2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX DENSITÉS, UN SEUL PARCOURS
 *
 * Le §8.7 ne laisse pas de marge : « La vue Liste ne simplifie pas le parcours
 * fonctionnel : propositions cliquables, bouton Compléter, source ouvrable,
 * nature et priorité restent directement accessibles. Seule la densité
 * visuelle change. » (critère UX-02)
 *
 * D'où un seul fichier et une seule logique d'interaction : `ActionCard` et
 * `ActionRow` diffèrent par leur mise en page, jamais par ce qu'elles
 * permettent. Deux composants autonomes auraient divergé au premier ajout —
 * et c'est toujours la vue dense qui perd une capacité.
 *
 * ── LA PRIORITÉ N'EST PAS PORTÉE PAR LA COULEUR SEULE ─────────────────────
 *
 * §16.2 : « Ne pas communiquer une priorité ou un état uniquement par la
 * couleur. » Les badges portent donc leur libellé en toutes lettres. C'est
 * aussi ce qui les rend lisibles à 320 px sans dépendre d'une légende.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FileText, Image as ImageIcon, Home, Package, Calendar, Wrench, LayoutGrid } from 'lucide-react';
import { ACTION_KIND_LABELS, MICROCOPY } from '@/lib/referential/v2/microcopy';
import { PRIORITY_LABELS } from '@/services/to-process/priority';
import type { ActionKind, ActionPriority } from '@/services/to-process/action-model';

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
  /** « Autre » et « Compléter » mènent au même endroit : le drawer, sur le champ. */
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
 */
export function CardVisual({ action }: { action: ActionView }) {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const url = action.targetType === 'DOCUMENT' ? action.target.thumbnailUrl ?? null : null;
  const src = !url ? null : step === 0 ? url : step === 1 ? `/api/files/${action.targetId}/thumbnail` : null;
  if (src) {
    return (
      <span data-card-visual="thumbnail" className="relative block h-14 w-11 shrink-0 overflow-hidden rounded border bg-white shadow-sm sm:h-[88px] sm:w-[68px]">
        {/* eslint-disable-next-line @next/next/no-img-element -- miniature autorisée (APP-PERF-06), icône si absente */}
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setStep((x) => (x === 0 ? 1 : 2))}
          className="absolute inset-0 h-full w-full object-cover object-top"
        />
      </span>
    );
  }
  return (
    <span data-card-visual="icon" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border bg-muted/40 sm:h-14 sm:w-14">
      <TargetIcon action={action} className="h-5 w-5 text-muted-foreground sm:h-6 sm:w-6" />
    </span>
  );
}

function Badges({ action }: { action: ActionView }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge variant="outline" className="text-[11px] font-normal">
        {ACTION_KIND_LABELS[action.actionKind]}
      </Badge>
      <Badge variant="secondary" className="text-[11px] font-normal">
        {PRIORITY_LABELS[action.priority]}
      </Badge>
    </div>
  );
}

/**
 * Contrôles de résolution.
 *
 * Partagés par les deux densités, pour la raison donnée en tête de fichier.
 * Les zones tactiles restent à 36 px de haut et les propositions passent à la
 * ligne plutôt que de se tronquer (§16.1).
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
        {MICROCOPY.complete}
      </Button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {action.proposals.map((proposal, index) => (
        <Button
          key={`${action.publicId}-${index}`}
          size="sm"
          variant={proposal.isCurrentValue ? 'secondary' : 'default'}
          disabled={busy}
          onClick={() => onChoose(action, proposal)}
          className="h-9 max-w-full whitespace-normal text-left"
        >
          <span className="truncate">{proposal.label}</span>
          {proposal.isCurrentValue && (
            // §8.5 : la valeur actuelle est proposée pour confirmation, et
            // identifiée « discrètement ».
            <span className="ml-1.5 text-[11px] opacity-70">(actuelle)</span>
          )}
        </Button>
      ))}
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => onOpenTarget(action)}
        className="h-9"
      >
        {MICROCOPY.otherChoice}
      </Button>
    </div>
  );
}

/**
 * « À compléter » en ligne (lot 28) : une date de fin de contrat ou de
 * garantie se saisit sur la carte, sans ouvrir le document. La valeur suit
 * le même chemin qu'une proposition retenue (résolution atomique, toast
 * « Annuler »). « Compléter » ouvre toujours l'objet.
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
        {MICROCOPY.complete}
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
      className={`scroll-mt-24 rounded-lg border bg-card p-4 shadow-sm focus-within:ring-2 focus-within:ring-ring ${visual ? 'flex items-start gap-3 sm:gap-4' : ''} ${focused ? 'ring-2 ring-primary' : ''}`}
    >
      {visual ? (
        <>
          <div className="min-w-0 flex-1"><CardBody action={action} {...handlers} /></div>
          {/* Lot 34, point 11 : vignette ou icône de la cible, à droite. */}
          <CardVisual action={action} />
        </>
      ) : (
        <CardBody action={action} {...handlers} />
      )}
    </article>
  );
}

function CardBody({ action, ...handlers }: { action: ActionView } & Handlers) {
  return (
    <>
      {/* §8.4 : la question est l'élément dominant. */}
      <h3 className="text-sm font-medium leading-snug">{action.question}</h3>

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
        <Badges action={action} />
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

export function ActionRow({ action, focused, ...handlers }: { action: ActionView } & Handlers) {
  return (
    <article
      id={todoCardDomId(action.publicId)}
      data-todo-id={action.publicId}
      aria-current={focused ? 'true' : undefined}
      className={`scroll-mt-24 flex flex-col gap-2 border-b py-3 last:border-b-0 focus-within:ring-2 focus-within:ring-ring sm:flex-row sm:items-center sm:justify-between ${focused ? 'ring-2 ring-primary rounded-md' : ''}`}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{action.question}</p>
        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          <TargetIcon action={action} />
          <span className="truncate">{action.target.label}</span>
          <Badges action={action} />
        </div>
        <div className="mt-1">
          <Source action={action} onOpenTarget={handlers.onOpenTarget} />
        </div>
      </div>

      {/* Mêmes capacités qu'en vue Cartes — seule la densité change (§8.7). */}
      <div className="shrink-0">
        <Controls action={action} {...handlers} />
      </div>
    </article>
  );
}
