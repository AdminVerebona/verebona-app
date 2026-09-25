'use client';
/**
 * Panneau sources repliable — CDC §19 (≤ 5 affichées, disponibilité, ouverture).
 *
 * Contrôlable (`open` / `onOpenChange`) : le bouton « Voir les sources »
 * (SHOW_SOURCES, §19.3) déplie ce même panneau.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { openDrawerFromLink } from '@/lib/drawers';

interface SourceRow {
  source_type: string; title_snapshot: string | null;
  excerpt_snapshot: string | null; is_available: boolean;
  /** Construit par le serveur (§22.1) ; `null` si l'objet n'est pas ouvrable. */
  href: string | null;
}

export interface VerebonaSourcesProps {
  messageId: string;
  count: number;
  /** État contrôlé (facultatif). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function VerebonaSources({ messageId, count, open: openProp, onOpenChange }: VerebonaSourcesProps) {
  const [openLocal, setOpenLocal] = useState(false);
  const open = openProp ?? openLocal;
  const [rows, setRows] = useState<SourceRow[] | null>(null);
  const [error, setError] = useState(false);

  // Chargement à la première ouverture, quelle qu'en soit l'origine (lien
  // « Sources » ou bouton « Voir les sources »).
  useEffect(() => {
    if (!open || rows) return;
    let annule = false;
    void (async () => {
      const res = await fetch(`/api/verebona/messages/${messageId}/sources`).catch(() => null);
      const data = res && res.ok ? await res.json().catch(() => null) : null;
      if (annule) return;
      if (!data) { setError(true); return; }
      setRows(data.sources ?? []);
    })();
    return () => { annule = true; };
  }, [open, rows, messageId]);

  const toggle = () => {
    const next = !open;
    setError(false);
    if (openProp === undefined) setOpenLocal(next);
    onOpenChange?.(next);
  };

  return (
    <div className="mt-2">
      <button type="button" onClick={toggle} aria-expanded={open} className="text-xs text-primary underline">
        {open ? 'Masquer les sources' : `Sources (${count})`}
      </button>
      {open && error && (
        <p className="mt-1 text-xs text-muted-foreground" role="status">Les sources ne peuvent pas être chargées pour le moment.</p>
      )}
      {open && rows && (
        <ul className="mt-1 space-y-1">
          {rows.map((r, i) => (
            <li key={i} className="rounded border p-2 text-xs">
              <span className="font-medium">{r.title_snapshot ?? 'Source'}</span>
              {!r.is_available && <span className="ml-1 text-muted-foreground">(indisponible)</span>}
              {r.excerpt_snapshot && <p className="text-muted-foreground">{r.excerpt_snapshot}</p>}
              {/* Le lien n'apparaît que si le serveur en a fourni un : pas de
                  destination devinée côté client (§22.1). */}
              {r.href && (
                <Link
                  href={r.href}
                  onClick={(e) => openDrawerFromLink(e, r.href)}
                  className="mt-1 inline-block text-primary underline"
                >
                  Ouvrir
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
