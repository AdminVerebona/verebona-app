"use client";

/**
 * Navigation basse flottante — Direction D v2 §4.1.
 *
 * Accueil, Biens, « + Ajouter » (bouton central surélevé), Documents,
 * À traiter (+ pastille au-delà de zéro). Flou, rayon 32.
 *
 * Libellés sans possessif : cinq entrées sur 390 px laissent environ 78 px
 * chacune, « Mes documents » passait à la ligne.
 *
 * Le compteur « À traiter » est celui de la coquille (une seule lecture pour
 * le menu latéral et la barre basse : deux lectures, c'était deux nombres).
 */
import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { House, Package, FileText, CircleAlert, Plus } from 'lucide-react';
import { MobileActionsSheet } from './mobile-actions-sheet';
import { badgeLabel } from '@/lib/shell/sidebar-state';

const LEFT_ITEMS = [
  { id: 'accueil', name: 'Accueil', href: '/accueil', icon: House },
  { id: 'biens', name: 'Biens', href: '/assets', icon: Package },
];

const RIGHT_ITEMS = [
  { id: 'documents', name: 'Documents', href: '/documents', icon: FileText },
  { id: 'a-traiter', name: 'À traiter', href: '/accueil/a-traiter', icon: CircleAlert },
];

function isActive(id: string, href: string, pathname: string): boolean {
  if (id === 'accueil') return pathname === '/accueil';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function BottomNavigation({ toProcessCount }: { toProcessCount?: number | null }) {
  const pathname = usePathname() ?? '';
  const [showActionsSheet, setShowActionsSheet] = useState(false);
  const badge = badgeLabel(toProcessCount);

  const item = (it: typeof LEFT_ITEMS[number]) => {
    const active = isActive(it.id, it.href, pathname);
    const b = it.id === 'a-traiter' ? badge : null;
    return (
      <Link
        key={it.id}
        href={it.href}
        aria-current={active ? 'page' : undefined}
        aria-label={b ? `${it.name}, ${b}` : undefined}
        className={`flex min-h-11 flex-1 flex-col items-center gap-1 p-2 text-[10px] font-medium ${active ? 'text-[color:var(--accent)]' : 'text-[color:var(--text-muted)]'}`}
      >
        <span className="relative flex">
          <it.icon className="h-5 w-5" aria-hidden />
          {b && (
            <span className="absolute -right-2 -top-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[color:var(--vb-red-500)] px-1 text-[9px] font-bold text-white" aria-hidden>
              {b}
            </span>
          )}
        </span>
        <span className="whitespace-nowrap">{it.name}</span>
      </Link>
    );
  };

  return (
    <>
      <div data-mobile-bottom-nav className="fixed inset-x-0 bottom-0 z-50 bg-gradient-to-t from-[color:var(--bg-page)] via-[color:var(--bg-page)]/90 to-transparent px-4 pb-[max(22px,env(safe-area-inset-bottom))] pt-2 md:hidden">
        <nav
          aria-label="Navigation principale"
          className="flex items-center rounded-[32px] border border-[color:var(--border-subtle)] p-2 shadow-relief-lg backdrop-blur-[16px]"
          style={{ background: 'color-mix(in srgb, var(--bg-card) 80%, transparent)' }}
        >
          {LEFT_ITEMS.map(item)}
          <div className="-mt-10 flex flex-shrink-0 flex-col items-center gap-1 px-1.5">
            <button
              type="button"
              onClick={() => setShowActionsSheet(true)}
              aria-label="Ajouter un bien, un document ou une échéance"
              className="group flex h-16 w-16 items-center justify-center rounded-full border-4 border-[color:var(--bg-page)] text-white shadow-relief-2xl"
              style={{ background: 'linear-gradient(135deg, var(--vb-blue-500), var(--vb-blue-700))' }}
            >
              <Plus
                className={`h-[30px] w-[30px] transition-transform duration-[250ms] ease-[cubic-bezier(.34,1.56,.64,1)] group-hover:rotate-90 ${showActionsSheet ? 'rotate-90' : ''}`}
                strokeWidth={2.2}
                aria-hidden
              />
            </button>
            <span className="text-[10px] font-medium text-[color:var(--accent)]">Ajouter</span>
          </div>
          {RIGHT_ITEMS.map(item)}
        </nav>
      </div>

      <MobileActionsSheet open={showActionsSheet} onOpenChange={setShowActionsSheet} />
    </>
  );
}
