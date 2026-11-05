"use client"

import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Lot 111J — action principale des pieds de fenêtre et de tiroir
 * (« Importer », « Enregistrer », « Créer », « Ajouter », « Utiliser »…).
 *
 * Avant : l'action principale était une cellule de la barre segmentée
 * (icône 16 px au-dessus d'un libellé 12 px, fond clair `bg-muted/30`,
 * texte pétrole ou encre) : rien ne la distinguait d'« Annuler ».
 *
 * Désormais (charte « Sérénité », bouton primaire §5) : fond plein
 * `--accent`, texte `--on-accent` 15 px gras, survol `--accent-hover`,
 * hauteur ≥ 44 px. Trois états distincts, tous en jetons :
 *   - prêt       : pétrole plein ;
 *   - en cours   : `--accent-hover` + roue + libellé « … » + aria-busy ;
 *   - désactivé  : `--muted` / `--muted-foreground` (≥ 4,5:1, lisible,
 *                  sans opacité réduite) + curseur interdit.
 * Aucune couleur brute : jetons existants uniquement.
 */

export type FooterPrimaryState = 'ready' | 'busy' | 'disabled';

/** Disposition : cellule d'une barre segmentée, ou bouton pleine largeur. */
export type FooterPrimaryLayout = 'cell' | 'block';

const BASE =
  'inline-flex items-center justify-center gap-2 min-h-[44px] px-4 text-[15px] leading-5 font-bold ' +
  'transition-[background-color,color] duration-[180ms] ease-[cubic-bezier(.2,.7,.2,1)]';

const LAYOUT: Record<FooterPrimaryLayout, string> = {
  // Dans la barre segmentée (`overflow-hidden rounded-xl`) : remplit la cellule.
  cell: 'flex-1 self-stretch py-3',
  // Seul dans un pied de fenêtre : pleine largeur, 48 px, rayon 12 px.
  block: 'w-full h-12 rounded-[12px]',
};

const STATE: Record<FooterPrimaryState, string> = {
  ready: 'bg-[color:var(--accent)] text-[color:var(--on-accent)] hover:bg-[color:var(--accent-hover)]',
  busy: 'bg-[color:var(--accent-hover)] text-[color:var(--on-accent)] cursor-progress',
  disabled: 'bg-[color:var(--muted)] text-[color:var(--muted-foreground)] cursor-not-allowed',
};

/** État affiché : « en cours » l'emporte sur « désactivé ». */
export function footerPrimaryState(opts: { busy?: boolean; disabled?: boolean }): FooterPrimaryState {
  if (opts.busy) return 'busy';
  if (opts.disabled) return 'disabled';
  return 'ready';
}

/** Classes de l'action principale (exportées pour SegmentedActionBar et les tests). */
export function footerPrimaryClass(state: FooterPrimaryState, layout: FooterPrimaryLayout = 'cell'): string {
  return cn(BASE, LAYOUT[layout], STATE[state]);
}

export interface FooterPrimaryActionProps {
  label: ReactNode;
  icon?: LucideIcon;
  busy?: boolean;
  /** Libellé pendant l'envoi / la sauvegarde (sinon `label`). */
  busyLabel?: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  type?: 'button' | 'submit';
  form?: string;
  layout?: FooterPrimaryLayout;
  /** Pourquoi l'action n'est pas encore possible (lu par les lecteurs d'écran). */
  disabledReasonId?: string;
  className?: string;
}

export function FooterPrimaryAction({
  label, icon: Icon, busy = false, busyLabel, disabled = false, onClick,
  type = 'button', form, layout = 'cell', disabledReasonId, className,
}: FooterPrimaryActionProps) {
  const state = footerPrimaryState({ busy, disabled });
  return (
    <button
      type={type}
      form={form}
      onClick={onClick}
      disabled={state !== 'ready'}
      aria-busy={state === 'busy' || undefined}
      aria-describedby={state === 'disabled' ? disabledReasonId : undefined}
      data-variant="footer-primary"
      data-state={state}
      className={cn(footerPrimaryClass(state, layout), className)}
    >
      {state === 'busy'
        ? <Loader2 className="w-[18px] h-[18px] animate-spin" aria-hidden="true" />
        : Icon ? <Icon className="w-[18px] h-[18px]" aria-hidden="true" /> : null}
      <span>{state === 'busy' && busyLabel ? busyLabel : label}</span>
    </button>
  );
}
