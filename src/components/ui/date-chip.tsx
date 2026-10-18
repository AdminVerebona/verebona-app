import * as React from "react"

import { cn } from "../../lib/utils"

/**
 * Pastille de date d'échéance — charte « Sérénité » 2026 §5 (lot 66).
 *
 * 48 × 48 (44 sur mobile), rayon 10, jour 17 px / 700 + mois 9 px capitales.
 *   - `default`   : brume + pétrole (à venir) ;
 *   - `attention` : cuivre-soft + cuivre texte (proche, à traiter) ;
 *   - `late`      : rouge accessible (retard strict, décision PO lot 66).
 * Décorative (`aria-hidden`) : l'état est TOUJOURS écrit à côté (« En
 * retard de 2 j », « Dans 12 j »), jamais porté par la couleur seule.
 */
export type DateChipTone = 'default' | 'attention' | 'late';

const TONES: Record<DateChipTone, string> = {
  default: 'bg-[color:var(--accent-soft)] text-[color:var(--accent)] border-[color:var(--border)]',
  attention: 'bg-[color:var(--attention-soft)] text-[color:var(--attention-on-soft)] border-[color:var(--attention-edge)]',
  late: 'bg-[color:var(--danger-soft)] text-[color:var(--danger)] border-[color:var(--danger-edge)]',
};

/** Couleur du libellé d'état écrit à côté de la pastille, selon le même ton. */
export const DATE_CHIP_LABEL_TONE: Record<DateChipTone, string> = {
  default: 'text-[color:var(--accent)]',
  attention: 'text-[color:var(--attention)]',
  late: 'text-[color:var(--danger)]',
};

export function DateChip({ day, month, tone = 'default', className }: {
  day: React.ReactNode;
  month: React.ReactNode;
  tone?: DateChipTone;
  className?: string;
}) {
  return (
    <span
      data-slot="date-chip"
      data-tone={tone}
      aria-hidden
      className={cn(
        'flex h-11 w-11 flex-shrink-0 flex-col items-center justify-center rounded-[10px] border leading-none md:h-12 md:w-12',
        TONES[tone],
        className,
      )}
    >
      <span className="text-[15px] font-bold tabular-nums md:text-[17px]">{day}</span>
      <span className="mt-[3px] text-[9px] font-bold uppercase tracking-[.05em]">{month}</span>
    </span>
  );
}
