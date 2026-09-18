'use client';
/** Panneau sources repliable — CDC §19 (≤ 5 affichées, disponibilité, ouverture). */
import { useState } from 'react';
import Link from 'next/link';

interface SourceRow {
  source_type: string; title_snapshot: string | null;
  excerpt_snapshot: string | null; is_available: boolean;
  /** Construit par le serveur (§22.1) ; `null` si l'objet n'est pas ouvrable. */
  href: string | null;
}

export function VerebonaSources({ messageId, count }: { messageId: string; count: number }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<SourceRow[] | null>(null);

  const toggle = async () => {
    setOpen((o) => !o);
    if (!rows) {
      const res = await fetch(`/api/verebona/messages/${messageId}/sources`);
      const data = await res.json().catch(() => ({ sources: [] }));
      setRows(data.sources ?? []);
    }
  };

  return (
    <div className="mt-2">
      <button onClick={toggle} className="text-xs text-primary underline">
        {open ? 'Masquer' : `Sources (${count})`}
      </button>
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
                <Link href={r.href} className="mt-1 inline-block text-primary underline">
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
