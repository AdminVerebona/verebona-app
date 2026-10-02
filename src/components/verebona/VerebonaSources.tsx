'use client';
/**
 * Panneau sources repliable — CDC §19.3, §19.5, §19.10, §27.8.
 *
 * Replié derrière « Voir les sources » (§19.5). Déplié : 5 sources, puis
 * « Voir toutes les sources » charge la page suivante (pagination serveur,
 * §27.8). Chaque source affiche son type lisible, son titre, le bien lié, la
 * date utile, son statut, un extrait court et l'ouverture (§19.5).
 *
 * Contrôlable (`open` / `onOpenChange`) : le bouton « Voir les sources »
 * (SHOW_SOURCES, §19.3) déplie ce même panneau.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { openDrawerFromLink } from '@/lib/drawers';
import { trackAssistantUsage } from '@/lib/verebona/usage-events';
import { formatSourceMeta, sourcesToggleLabel, type SourceRow } from '@/lib/verebona/assistant-ui';

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
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);

  const charger = async (offset: number): Promise<{ sources: SourceRow[]; nextOffset: number | null } | null> => {
    const res = await fetch(`/api/verebona/messages/${messageId}/sources?offset=${offset}`).catch(() => null);
    const data = res && res.ok ? await res.json().catch(() => null) : null;
    return data ? { sources: data.sources ?? [], nextOffset: data.nextOffset ?? null } : null;
  };

  // Chargement à la première ouverture, quelle qu'en soit l'origine (lien
  // « Voir les sources » ou bouton SHOW_SOURCES).
  useEffect(() => {
    if (!open || rows) return;
    let annule = false;
    void (async () => {
      const data = await charger(0);
      if (annule) return;
      if (!data) { setError(true); return; }
      setRows(data.sources);
      setNextOffset(data.nextOffset);
    })();
    return () => { annule = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rows, messageId]);

  const toutes = async () => {
    if (nextOffset == null || loadingMore) return;
    setLoadingMore(true);
    const data = await charger(nextOffset);
    setLoadingMore(false);
    if (!data) { setError(true); return; }
    setRows((r) => [...(r ?? []), ...data.sources]);
    setNextOffset(data.nextOffset);
  };

  const toggle = () => {
    const next = !open;
    setError(false);
    if (openProp === undefined) setOpenLocal(next);
    onOpenChange?.(next);
  };

  return (
    <div className="mt-2">
      <button type="button" onClick={toggle} aria-expanded={open} className="text-xs text-primary underline">
        {sourcesToggleLabel(open, count)}
      </button>
      {open && error && (
        <p className="mt-1 text-xs text-muted-foreground" role="status">Les sources ne peuvent pas être chargées pour le moment.</p>
      )}
      {open && rows && (
        <ul className="mt-1 space-y-1">
          {rows.map((r, i) => {
            const meta = formatSourceMeta(r);
            return (
              <li key={`${r.source_id ?? i}-${i}`} className="rounded border p-2 text-xs">
                {r.type_label && <div className="text-[10px] uppercase text-muted-foreground">{r.type_label}</div>}
                <span className="font-medium">{r.title_snapshot ?? 'Source'}</span>
                {!r.is_available && <span className="ml-1 text-muted-foreground">(indisponible)</span>}
                {meta && <div className="text-muted-foreground">{meta}</div>}
                {r.excerpt_snapshot && <p className="text-muted-foreground">{r.excerpt_snapshot}</p>}
                {/* Le lien n'apparaît que si le serveur en a fourni un : pas de
                    destination devinée côté client (§22.1). */}
                {/* Source disponible sans objet à ouvrir (regroupement, règle) :
                    signalée, jamais de lien mort (R8). */}
                {!r.href && r.is_available && (
                  <div className="mt-1 text-muted-foreground">Pas d’élément à ouvrir</div>
                )}
                {r.href && (
                  <Link
                    href={r.href}
                    onClick={(e) => { trackAssistantUsage({ type: 'SOURCE_OPEN', sourceType: r.source_type }); openDrawerFromLink(e, r.href); }}
                    className="mt-1 inline-block text-primary underline"
                  >
                    Ouvrir
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {open && rows && nextOffset != null && (
        <button
          type="button"
          onClick={() => void toutes()}
          disabled={loadingMore}
          className="mt-1 text-xs text-primary underline disabled:opacity-50"
        >
          Voir toutes les sources
        </button>
      )}
    </div>
  );
}
