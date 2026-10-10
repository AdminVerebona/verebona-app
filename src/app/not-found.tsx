'use client';
/**
 * Page 404 (lot 34, point 9) — mise en scène avec la mascotte, dans le
 * design existant (jetons `--bg-page`, `--text-primary`, `--accent`…) :
 * elle suit le thème choisi, clair (beige) ou sombre.
 *
 * Plus de bloc « DIAGNOSTIC » (code, chemin, heure, environnement) visible
 * par l'utilisateur : ces éléments partent en console pour le support.
 */
import Link from 'next/link';
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
      <div className="flex w-full max-w-[420px] flex-col items-center gap-5 rounded-[24px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] px-6 pb-7 pt-8 shadow-[var(--shadow-lg)] md:px-8">
        <span className="relative flex items-center justify-center">
          <span
            className="absolute h-[124px] w-[124px] rounded-full"
            style={{ background: 'radial-gradient(circle, color-mix(in srgb, var(--accent) 22%, transparent), transparent 70%)' }}
            aria-hidden
          />
          <MascotPose pose="questioning" size={112} priority className="relative" style={{ filter: 'drop-shadow(0 10px 16px rgba(4,10,26,.35))' }} />
        </span>
        <div className="flex flex-col items-center gap-2">
          <span className="font-display text-[44px] font-semibold leading-none tracking-[-.03em] text-[color:var(--accent)]">404</span>
          <h1 className="m-0 font-display text-[20px] font-semibold tracking-[-.02em] text-[color:var(--text-primary)]">Page introuvable</h1>
          <p className="m-0 max-w-[320px] text-[14px] leading-normal text-[color:var(--muted-foreground)]">
            J’ai cherché partout : cette page n’existe pas ou a été déplacée.
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:gap-2.5">
          <a
            href="/accueil"
            className="inline-flex h-10 items-center justify-center rounded-full bg-[color:var(--accent)] px-5 text-[13.5px] font-semibold text-white transition-colors hover:bg-[#2563EB] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg-card)]"
          >
            Tableau de bord
          </a>
          <Link
            href="/"
            className="inline-flex h-10 items-center justify-center rounded-full border border-[color:var(--border)] px-5 text-[13.5px] font-medium text-[color:var(--text-primary)] transition-colors hover:border-[color:var(--accent)] hover:bg-[color:var(--accent-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]"
          >
            Accueil
          </Link>
        </div>
      </div>
    </main>
  );
}
