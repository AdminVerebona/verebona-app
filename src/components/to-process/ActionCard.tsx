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

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FileText, Image as ImageIcon, Home, Package, Calendar, Wrench } from 'lucide-react';
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
  targetType: 'DOCUMENT' | 'ASSET' | 'EQUIPMENT' | 'AGENDA_ITEM' | 'SUPPLIER';
  targetId: number;
  fieldKey: string | null;
  relationKey: string | null;
  actionKind: ActionKind;
  priority: ActionPriority;
  ruleCode: string;
  question: string;
  proposals: ActionProposalView[];
  target: {
    label: string;
    mimeType?: string | null;
    publicId?: string | null;
    assetName?: string | null;
  };
}

interface Handlers {
  onChoose: (action: ActionView, value: ActionProposalView) => void;
  /** « Autre » et « Compléter » mènent au même endroit : le drawer, sur le champ. */
  onOpenTarget: (action: ActionView) => void;
  busy?: boolean;
}

function TargetIcon({ action }: { action: ActionView }) {
  const className = 'h-4 w-4 text-muted-foreground shrink-0';
  if (action.targetType === 'DOCUMENT') {
    return action.target.mimeType?.startsWith('image/')
      ? <ImageIcon className={className} aria-hidden />
      : <FileText className={className} aria-hidden />;
  }
  if (action.targetType === 'ASSET') return <Home className={className} aria-hidden />;
  if (action.targetType === 'EQUIPMENT') return <Wrench className={className} aria-hidden />;
  if (action.targetType === 'AGENDA_ITEM') return <Calendar className={className} aria-hidden />;
  return <Package className={className} aria-hidden />;
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

export function ActionCard({ action, ...handlers }: { action: ActionView } & Handlers) {
  return (
    <article className="rounded-lg border bg-card p-4 shadow-sm focus-within:ring-2 focus-within:ring-ring">
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
    </article>
  );
}

export function ActionRow({ action, ...handlers }: { action: ActionView } & Handlers) {
  return (
    <article className="flex flex-col gap-2 border-b py-3 last:border-b-0 focus-within:ring-2 focus-within:ring-ring sm:flex-row sm:items-center sm:justify-between">
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
