import type { ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * Carte d'état vide « une ligne, une explication, une action » (Mes biens,
 * Agenda, onglet Agenda d'un bien, pièces, équipements).
 *
 * Les cinq écrans recopiaient le même bloc en `flex` horizontal avec un bouton
 * `flex-shrink-0` : sur mobile, le bouton gardait toute sa largeur, la colonne
 * de texte était écrasée à un mot par ligne et le bouton finissait par
 * recouvrir le texte.
 *
 * Ici : icône + texte sur une ligne, bouton dessous en pleine largeur sur
 * mobile ; tout sur une seule ligne, bouton à droite, à partir de `sm`.
 */
export interface EmptyStateCardProps {
  icon: ReactNode;
  /** Fond de la pastille d'icône (ex. `bg-[color:var(--accent-soft)]`). */
  iconClassName?: string;
  title: string;
  description?: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  actionVariant?: 'default' | 'outline';
  actionSize?: 'default' | 'sm';
  /** Ancre du guide interactif (`data-guide`) posée sur le bouton. */
  actionGuide?: string;
  className?: string;
}

export function EmptyStateCard({
  icon,
  iconClassName = 'bg-[color:var(--accent-soft)]',
  title,
  description,
  actionLabel,
  onAction,
  actionVariant,
  actionSize,
  actionGuide,
  className,
}: EmptyStateCardProps) {
  return (
    <Card className={cn('border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] rounded-2xl shadow-sm', className)}>
      <CardContent className="flex flex-col gap-3 py-4 px-5 sm:flex-row sm:items-center sm:gap-4">
        <div className="flex items-center gap-4 min-w-0 sm:flex-1">
          <div className={cn('w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0', iconClassName)}>
            {icon}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-[color:var(--text-primary)]">{title}</p>
            {description && (
              <p className="text-xs text-[color:var(--text-muted)] mt-0.5">{description}</p>
            )}
          </div>
        </div>
        {actionLabel && onAction && (
          <Button
            variant={actionVariant}
            size={actionSize}
            onClick={onAction}
            data-guide={actionGuide}
            className="btn-add px-4 w-full sm:w-auto sm:flex-shrink-0"
          >
            <Plus className="btn-add-plus-icon w-4 h-4 mr-2" />
            {actionLabel}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
