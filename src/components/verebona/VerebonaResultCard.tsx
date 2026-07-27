'use client';
/** Carte de résultat (bien/document/échéance) — CDC §7 / §19. Réutilise ui/card. */
import { Card } from '@/components/ui/card';

export interface VerebonaResultCardProps {
  title: string;
  subtitle?: string;
  typeLabel?: string;
  href?: string | null;
}

export function VerebonaResultCard({ title, subtitle, typeLabel, href }: VerebonaResultCardProps) {
  const content = (
    <Card className="p-3 transition hover:bg-muted">
      {typeLabel && <div className="text-[10px] uppercase text-muted-foreground">{typeLabel}</div>}
      <div className="text-sm font-medium">{title}</div>
      {subtitle && <div className="text-xs text-muted-foreground">{subtitle}</div>}
    </Card>
  );
  return href ? <a href={href}>{content}</a> : content;
}
