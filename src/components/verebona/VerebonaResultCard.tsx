'use client';
/**
 * Carte de résultat (bien, document, échéance, fournisseur, « À traiter »,
 * aide) — CDC §22.2 : type, titre, bien lié / date / statut, extrait court,
 * ouverture au clic (jamais automatique, §22.10). Réutilise ui/card.
 */
import { openDrawerFromLink } from '@/lib/drawers';
import { Card } from '@/components/ui/card';

export interface VerebonaResultCardProps {
  title: string;
  subtitle?: string;
  typeLabel?: string;
  excerpt?: string;
  href?: string | null;
}

export function VerebonaResultCard({ title, subtitle, typeLabel, excerpt, href }: VerebonaResultCardProps) {
  const content = (
    <Card className="p-3 transition hover:bg-muted">
      {typeLabel && <div className="text-[10px] uppercase text-muted-foreground">{typeLabel}</div>}
      <div className="text-sm font-medium">{title}</div>
      {subtitle && <div className="text-xs text-muted-foreground">{subtitle}</div>}
      {excerpt && <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{excerpt}</div>}
    </Card>
  );
  // Lien réel (focusable, activable au clavier — §22.3, §33.1).
  return href
    ? <a href={href} onClick={(e) => openDrawerFromLink(e, href)} className="block rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary">{content}</a>
    : content;
}
