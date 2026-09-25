"use client"

/**
 * Centre d'aide intégré — /aide. CDC Centre d'aide V1 §1.1, §13, GAP-09,
 * MOB-01 à MOB-03.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CETTE PAGE ÉTAIT UN SECOND CENTRE D'AIDE
 *
 * Elle affichait douze articles rédigés dans l'application
 * (`src/services/help/help-content.ts`), jamais rapprochés du site public :
 * 10 Mo au lieu de 25, « Mes biens », validations disparues… (GAP-01, GAP-03).
 *
 * Elle affiche désormais le Centre d'aide public lui-même, en mode intégré
 * (`?integre=app`) : même contenu, même recherche, sans l'en-tête du site, et
 * « Retour à Verebona » rend la main ici sans ouvrir d'onglet. C'est la
 * « WebView intégrée » du GAP-09 pour l'application mobile, et un accès direct
 * sur ordinateur.
 *
 * `?page=` désigne la page d'aide à ouvrir ; seuls des chemins `/aide…` sont
 * acceptés — jamais une adresse arbitraire dans le cadre.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ChevronLeft, ExternalLink } from 'lucide-react';
import { PUBLIC_SITE_URL } from '@/lib/external-urls';
import { helpPageUrl, isHelpPath, safeReturnPath } from '@/lib/help-center/open';

const LOAD_TIMEOUT_MS = 15_000;
const CLOSE_MESSAGE_TYPE = 'verebona:help:close';

export default function AidePage() {
  // `useSearchParams` exige une frontière Suspense dans l'App Router.
  return (
    <Suspense fallback={null}>
      <IntegratedHelpCenter />
    </Suspense>
  );
}

function IntegratedHelpCenter() {
  const router = useRouter();
  const params = useSearchParams();
  const requested = params.get('page') ?? '/aide';
  const page = isHelpPath(requested) ? requested : '/aide';

  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Destination fixée à l'ouverture (`?retour=`), jamais `router.back()` :
  // l'historique contient aussi les pages lues dans le cadre (MOB-03).
  const returnTo = safeReturnPath(params.get('retour'));
  const frame = useRef<HTMLIFrameElement | null>(null);
  const back = useCallback(() => router.push(returnTo), [router, returnTo]);

  // « Retour à Verebona » cliqué DANS le Centre d'aide (MOB-03). Seul le site
  // public de l'environnement est écouté.
  useEffect(() => {
    const origin = new URL(PUBLIC_SITE_URL).origin;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== origin || e.source !== frame.current?.contentWindow) return;
      if ((e.data as { type?: string } | null)?.type === CLOSE_MESSAGE_TYPE) back();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [back]);

  useEffect(() => {
    setLoaded(false);
    setFailed(false);
    timer.current = setTimeout(() => setFailed(true), LOAD_TIMEOUT_MS);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [page, attempt]);

  return (
    <div className="flex flex-col w-full h-[calc(100dvh-4rem)] md:h-[calc(100dvh-2rem)]">
      <div className="flex items-center justify-between gap-3 pb-3">
        <button
          type="button"
          onClick={back}
          className="inline-flex items-center gap-1 text-sm font-medium text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)]"
        >
          <ChevronLeft className="w-4 h-4" aria-hidden="true" /> Retour à Verebona
        </button>
        <h1 className="text-base font-semibold text-[color:var(--text-primary)]">Centre d’aide</h1>
        <a
          href={helpPageUrl(page, false)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]"
        >
          <span className="hidden sm:inline">Ouvrir dans un onglet</span>
          <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
        </a>
      </div>

      {failed && !loaded ? (
        <div role="alert" className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-6 space-y-3">
          <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">Le Centre d’aide est momentanément indisponible</h2>
          <p className="text-sm text-[color:var(--text-muted)]">
            Réessayez dans quelques instants. Si le problème persiste, vous pouvez contacter le support.
          </p>
          <button
            type="button"
            onClick={() => setAttempt((n) => n + 1)}
            className="rounded-full bg-[color:var(--accent)] px-4 py-2 text-sm font-semibold text-white"
          >
            Réessayer
          </button>
        </div>
      ) : (
        <iframe
          ref={frame}
          key={`${page}#${attempt}`}
          title="Centre d’aide Verebona"
          src={helpPageUrl(page, true)}
          onLoad={() => { setLoaded(true); if (timer.current) clearTimeout(timer.current); }}
          className="flex-1 w-full rounded-xl border border-[color:var(--border-subtle)] bg-white"
          referrerPolicy="strict-origin-when-cross-origin"
        />
      )}
    </div>
  );
}
