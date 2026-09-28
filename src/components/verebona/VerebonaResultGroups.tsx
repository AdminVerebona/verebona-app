'use client';
/**
 * Cartes de résultats groupées par type — CDC §11.3, §22.2, §22.3, 37.1.
 *
 * 5 cartes visibles au plus (§22.3), dans l'ordre des groupes ; au-delà,
 * « Voir tous les résultats » déplie tous les groupes (quotas du §11.3). Un
 * groupe qui a plus de résultats que son quota propose sa page complète.
 * Pas de carrousel : une liste verticale, utilisable au clavier (liens).
 */
import { useState } from 'react';
import { VerebonaResultCard } from './VerebonaResultCard';
import { visibleResultGroups, type UiResultGroup } from '@/lib/verebona/assistant-ui';
import { openDrawerFromLink } from '@/lib/drawers';

export function VerebonaResultGroups({ groups }: { groups: UiResultGroup[] }) {
  const [all, setAll] = useState(false);
  const { groups: visibles, hiddenCount } = visibleResultGroups(groups, all);
  if (visibles.length === 0) return null;
  return (
    <div className="mt-2 space-y-2" aria-label="Résultats">
      {visibles.map((g) => (
        <section key={g.type} aria-label={g.label}>
          <h4 className="mb-1 text-[11px] font-medium text-muted-foreground">
            {g.label}{g.total > g.items.length ? ` (${g.total})` : ''}
          </h4>
          <ul className="space-y-1">
            {g.items.map((c) => (
              <li key={c.id}>
                <VerebonaResultCard
                  title={c.title}
                  typeLabel={c.typeLabel}
                  subtitle={[c.subtitle, c.date ? formatDate(c.date) : null, c.status].filter(Boolean).join(' · ') || undefined}
                  excerpt={c.excerpt ?? undefined}
                  href={c.href}
                />
              </li>
            ))}
          </ul>
          {all && g.hasMore && g.moreHref && (
            <a
              href={g.moreHref}
              onClick={(e) => openDrawerFromLink(e, g.moreHref)}
              className="mt-1 inline-block text-xs text-primary underline"
            >
              Tout voir dans {g.label.toLowerCase()}
            </a>
          )}
        </section>
      ))}
      {!all && hiddenCount > 0 && (
        <button type="button" onClick={() => setAll(true)} className="text-xs text-primary underline">
          Voir tous les résultats
        </button>
      )}
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('fr-FR');
}
