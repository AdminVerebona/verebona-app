'use client';
/**
 * Page 404 (lot 34, point 9) — mise en scène avec la mascotte, dans le
 * design existant (jetons `--bg-page`, `--text-primary`, `--accent`…) :
 * elle suit le thème choisi, clair (beige) ou sombre.
 *
 * Plus de bloc « DIAGNOSTIC » (code, chemin, heure, environnement) visible
 * par l'utilisateur : ces éléments partent en console pour le support.
 */
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { MascotPose } from '@/components/verebona/space/MascotPose';

export default function NotFound() {
  const pathname = usePathname();

  useEffect(() => {
    console.warn('[404]', { code: 'HTTP_404', path: pathname ?? null, time: new Date().toISOString() });
  }, [pathname]);

  return (
    <main className="flex min-h-[100dvh] flex-col items-center justify-center bg-[color:var(--bg-page)] px-4 pb-[max(24px,env(safe-area-inset-bottom))] pt-[max(24px,env(safe-area-inset-top))] text-center">
      <div className="flex w-full max-w-[420px] flex-col items-center gap-5 rounded-[16px] border border-[color:var(--border)] bg-[color:var(--bg-card)] px-6 pb-7 pt-8 md:px-8">
        <span className="relative flex items-center justify-center">
          <MascotPose pose="questioning" size={112} priority className="relative" />
        </span>
        <div className="flex flex-col items-center gap-2">
          <span className="font-display text-[44px] font-extrabold leading-none tracking-[-.03em] text-[color:var(--accent-display)]">404</span>
          <h1 className="m-0 font-display text-[20px] font-bold tracking-[-.01em] text-[color:var(--text-primary)]">Page introuvable</h1>
          <p className="m-0 max-w-[320px] text-[14px] leading-normal text-[color:var(--muted-foreground)]">
            J’ai cherché partout : cette page n’existe pas ou a été déplacée.
          </p>
        </div>
        {/* Lot 49A (ticket 5) : un SEUL bouton « Accueil » (les deux boutons
            précédents menaient au même endroit). Pleine largeur en mobile. */}
        <a
          href="/accueil"
          data-testid="not-found-home"
          className="inline-flex h-10 w-full items-center justify-center rounded-[12px] bg-[color:var(--accent)] px-6 text-[14px] font-bold text-[color:var(--on-accent)] transition-colors duration-[180ms] hover:bg-[color:var(--accent-hover)] sm:w-auto"
        >
          Accueil
        </a>
      </div>
    </main>
  );
}
