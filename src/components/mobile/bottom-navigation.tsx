"use client";

/**
 * Navigation basse flottante — Direction D v2 §4.1, maquette mobile
 * (« Nav mobile — options », répartition 2b).
 *
 * Cinq onglets répartis également : Accueil, Biens, Agenda, Documents,
 * À traiter (+ pastille au-delà de zéro). Le « + Ajouter » est DÉTACHÉ
 * au-dessus de la barre, centré : il ne consomme aucune place, Agenda passe
 * dessous sans être masqué. Onglet actif : pilule « accent-soft ». Rayon 30.
 *
 * Charte « Sérénité » 2026 (lot 66) : barre en aplat fond carte (pas de
 * flou ni de transparence), « + » pétrole plein (pétrole clair en sombre),
 * sans dégradé ni changement d'échelle ; pastille « À traiter » cuivre.
 *
 * Libellés courts : cinq entrées sur 390 px laissent environ 70 px chacune,
 * « Mes documents » passait à la ligne.
 *
 * Le compteur « À traiter » est celui de la coquille (une seule lecture pour
 * le menu latéral et la barre basse : deux lectures, c'était deux nombres).
 */
import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { House, Package, CalendarDays, FileText, CircleAlert, Plus } from 'lucide-react';
import { MobileActionsSheet } from './mobile-actions-sheet';
import { useMountedOnce } from '@/hooks/useMountedOnce';
import { badgeLabel } from '@/lib/shell/sidebar-state';

export const NAV_ITEMS = [
  { id: 'accueil', name: 'Accueil', href: '/accueil', icon: House },
  { id: 'biens', name: 'Biens', href: '/assets', icon: Package },
  { id: 'agenda', name: 'Agenda', href: '/agenda', icon: CalendarDays },
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
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  // Panneau monté à sa première ouverture seulement (APP-PERF-05), puis
  // conservé : le formulaire choisi y vit après la fermeture du panneau.
  const sheetMounted = useMountedOnce(showActionsSheet);
  const badge = badgeLabel(toProcessCount);

  const item = (it: typeof NAV_ITEMS[number]) => {
    const active = isActive(it.id, it.href, pathname);
    const b = it.id === 'a-traiter' ? badge : null;
    return (
      <Link
        key={it.id}
        href={it.href}
        aria-current={active ? 'page' : undefined}
        aria-label={b ? `${it.name}, ${b}` : undefined}
        className={`flex min-h-12 min-w-0 flex-col items-center gap-[5px] rounded-full px-0.5 pb-[7px] pt-[9px] text-[10.5px] transition-colors duration-[180ms] ${active ? 'bg-[color:var(--accent-soft)] font-semibold text-[color:var(--accent)]' : 'font-medium text-[color:var(--text-muted)]'}`}
      >
        <span className="relative flex">
          <it.icon className="h-5 w-5" aria-hidden />
          {b && (
            <span data-badge="a-traiter" className="absolute -right-[9px] -top-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full border-2 border-[color:var(--bg-card)] bg-[color:var(--badge-todo)] px-1 text-[9px] font-bold tabular-nums text-[color:var(--on-badge-todo)]" aria-hidden>
              {b}
            </span>
          )}
        </span>
        <span className="max-w-full truncate">{it.name}</span>
      </Link>
    );
  };

  return (
    <>
      {/* Lot 34 (point 8) : le bandeau (dégradé + marges) laisse passer les
          touchers — seuls le « + » et la barre les captent. Il recouvrait
          la flèche « Retour en haut », dont le clic ne faisait rien. */}
      <div data-mobile-bottom-nav className="pointer-events-none fixed inset-x-0 bottom-0 z-50 bg-gradient-to-t from-[color:var(--bg-page)] via-[color:var(--bg-page)] via-60% to-transparent px-3.5 pb-[max(20px,env(safe-area-inset-bottom))] pt-2 md:hidden">
        <div className="flex flex-col items-center">
          {/* « + » détaché, au-dessus de la barre, centré (2b). */}
          <button
            type="button"
            onClick={(e) => { setAnchor(e.currentTarget.getBoundingClientRect()); setShowActionsSheet(true); }}
            aria-haspopup="menu"
            aria-expanded={showActionsSheet}
            aria-label="Ajouter un bien, un document ou une échéance"
            className="pointer-events-auto group relative z-[2] -mb-3.5 flex h-[58px] w-[58px] items-center justify-center rounded-full border-4 border-[color:var(--bg-page)] bg-[color:var(--accent)] text-[color:var(--on-accent)] shadow-[var(--vb-shadow-card)] transition-colors duration-[180ms] hover:bg-[color:var(--accent-hover)]"
          >
            <Plus
              className={`h-[26px] w-[26px] transition-transform duration-[180ms] ease-[cubic-bezier(.2,.7,.2,1)] ${showActionsSheet ? 'rotate-45' : ''}`}
              strokeWidth={2.4}
              aria-hidden
            />
          </button>
          <nav
            aria-label="Navigation principale"
            className="pointer-events-auto grid w-full grid-cols-5 items-center gap-0.5 rounded-[30px] border border-[color:var(--border)] bg-[color:var(--bg-card)] px-1.5 pb-1.5 pt-4"
          >
            {NAV_ITEMS.map(item)}
          </nav>
        </div>
      </div>

      {sheetMounted && <MobileActionsSheet open={showActionsSheet} onOpenChange={setShowActionsSheet} anchor={anchor} />}
    </>
  );
}
