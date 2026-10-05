"use client"

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FileText } from 'lucide-react';
import { AbortError, LruCache, Semaphore, SharedTasks } from './pdf-render-pool';

interface PdfThumbnailProps {
  fileId: string;
  className?: string;
  /**
   * Rendu à la place de l'icône quand la page ne peut pas être lue (PDF
   * protégé, fichier absent). « Mes documents » y met sa mini-page, pour
   * qu'un échec ne se voie pas comme un trou sombre dans une feuille blanche.
   */
  fallback?: ReactNode;
}

/**
 * Aperçu de la première page d'un PDF.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * MINIATURE SERVEUR D'ABORD, RENDU NAVIGATEUR BORNÉ EN REPLI
 *
 * 1. Miniature persistée (APP-PERF-27) : `/api/files/:id/thumbnail`, générée
 *    une fois par version côté serveur et partagée par tous les appareils.
 *    Image légère, cache navigateur privé.
 * 2. Si elle n'existe pas encore (génération en file) ou si les miniatures
 *    sont désactivées : rendu PDF.js dans le navigateur, À L'APPROCHE DE
 *    L'ÉCRAN (IntersectionObserver, marge de 200 px). Si le serveur dit le
 *    PDF illisible (protégé, corrompu) : repli immédiat, sans rendu inutile.
 *
 * RESSOURCES DU RENDU NAVIGATEUR (APP-PERF-07)
 *   · chaque chargement PDF.js est détruit (`loadingTask.destroy()`) en
 *     succès, erreur ET annulation ; la tâche de rendu est annulée ; le
 *     canvas est libéré (dimensions à 0) — dans un `finally` ;
 *   · démontage, ou vignette sortie avant son tour : annulation propagée ;
 *   · au plus 2 rendus simultanés (`Semaphore`) ; un même fichier n'est
 *     rendu qu'une fois même s'il est affiché plusieurs fois (`SharedTasks`) ;
 *   · cache des images borné en nombre et en volume (`LruCache`), purgé au
 *     changement de session (`purgePdfThumbnailCache`) ;
 *   · échec mémorisé (borné) : un PDF protégé/corrompu affiche son repli
 *     sans boucle de nouvelles tentatives.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Images rendues dans le navigateur (data URL JPEG), par fichier. */
const rendus = new LruCache<string>(60, 12 * 1024 * 1024, (v) => v.length);
/** Fichiers dont le rendu a échoué : repli direct, sans nouvel essai. */
const echecs = new LruCache<true>(500, 500, () => 1);
const limiteRendus = new Semaphore(2);
const rendusEnCours = new SharedTasks<string>();

/**
 * Purge les caches et annule les rendus en cours (changement de compte ou de
 * session) : aucune vignette d'un ancien contexte ne doit réapparaître.
 */
export function purgePdfThumbnailCache(): void {
  rendus.clear();
  echecs.clear();
  rendusEnCours.abortAll();
}

if (typeof window !== 'undefined') {
  window.addEventListener('verebona:session-changed', purgePdfThumbnailCache);
  // Connexion / déconnexion dans un autre onglet.
  window.addEventListener('storage', (e) => { if (e.key === 'user' || e.key === null) purgePdfThumbnailCache(); });
}

// ══════════════════════════════════════════════════════════════════════════
// LE LOGO PDF À LA PLACE DE L'APERÇU
//
// Le worker servi (`/pdf.worker.min.mjs`) était une copie manuelle d'une
// autre version que la bibliothèque installée : pdf.js rejette alors tout
// document (« API version … does not match Worker version … ») et chaque
// vignette finissait sur l'icône. Trois protections :
//   · le worker public est recopié depuis pdfjs-dist avant dev/build
//     (scripts/sync-pdf-worker.mjs) ;
//   · son URL porte la version de la bibliothèque (pas de worker périmé en
//     cache navigateur) ;
//   · en cas d'échec du worker, un second essai charge le worker du paquet
//     lui-même (même version, garantie) avant de renoncer.
// Le document est lu par le proxy authentifié de même origine si l'URL
// signée ne peut pas être lue (CORS du stockage, lien expiré).
// ══════════════════════════════════════════════════════════════════════════
type PdfJs = typeof import('pdfjs-dist');
type LoadingTask = ReturnType<PdfJs['getDocument']>;
let workerDePaquet: Promise<void> | null = null;

async function chargerPdfJs(forcerWorkerDuPaquet: boolean): Promise<PdfJs> {
  const pdfjsLib = await import('pdfjs-dist');
  if (forcerWorkerDuPaquet) {
    // Enregistre `globalThis.pdfjsWorker` : pdf.js l'utilise à la place d'un
    // worker séparé — même version que la bibliothèque, par construction.
    workerDePaquet ??= import('pdfjs-dist/build/pdf.worker.min.mjs').then(() => undefined);
    await workerDePaquet;
  } else {
    pdfjsLib.GlobalWorkerOptions.workerSrc = `/pdf.worker.min.mjs?v=${pdfjsLib.version}`;
  }
  return pdfjsLib;
}

const estErreurWorker = (e: unknown) => /worker|version/i.test(String((e as Error)?.message ?? e));

/**
 * Rend la 1re page en data URL. Toutes les ressources ouvertes sont libérées
 * en sortie, quel que soit le chemin (succès, erreur, annulation).
 */
async function rendrePremierePage(fileId: string, largeurPx: number, signal: AbortSignal, forcerWorkerDuPaquet: boolean): Promise<string> {
  const pdfjsLib = await chargerPdfJs(forcerWorkerDuPaquet);
  if (signal.aborted) throw new AbortError();

  const sources: string[] = [];
  const res = await fetch(`/api/files/${fileId}/view`, { credentials: 'include', signal }).catch(() => {
    if (signal.aborted) throw new AbortError();
    return null;
  });
  if (res?.ok) {
    const { viewUrl } = await res.json().catch(() => ({ viewUrl: null }));
    if (viewUrl) sources.push(viewUrl);
  }
  sources.push(`/api/files/${fileId}/proxy`);

  let derniere: unknown = null;
  for (const url of sources) {
    if (signal.aborted) throw new AbortError();
    let loadingTask: LoadingTask | null = null;
    let renderTask: { cancel: () => void; promise: Promise<void> } | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let page: { cleanup: () => void } | null = null;
    const onAbort = () => {
      try { renderTask?.cancel(); } catch { /* déjà terminé */ }
      void loadingTask?.destroy().catch(() => undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      loadingTask = pdfjsLib.getDocument({ url, disableStream: true, withCredentials: url.startsWith('/') });
      const pdf = await loadingTask.promise;
      if (signal.aborted) throw new AbortError();
      const p = await pdf.getPage(1);
      page = p;
      if (signal.aborted) throw new AbortError();

      const base = p.getViewport({ scale: 1 });
      const viewport = p.getViewport({ scale: largeurPx / base.width });
      canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas indisponible');

      renderTask = p.render({ canvasContext: ctx as never, canvas, viewport });
      await renderTask.promise;
      if (signal.aborted) throw new AbortError();
      return canvas.toDataURL('image/jpeg', 0.82);
    } catch (e) {
      if (signal.aborted || (e as Error)?.name === 'RenderingCancelledException') throw new AbortError();
      derniere = e;
      // Erreur de worker : changer d'URL n'y changerait rien.
      if (estErreurWorker(e)) throw e;
    } finally {
      signal.removeEventListener('abort', onAbort);
      try { page?.cleanup(); } catch { /* sans effet */ }
      // Détruit le document ET le chargement, quel que soit le chemin.
      if (loadingTask) await loadingTask.destroy().catch(() => undefined);
      if (canvas) { canvas.width = 0; canvas.height = 0; }
    }
  }
  throw derniere ?? new Error('PDF illisible');
}

/** Rendu partagé et borné ; résultat mis en cache. */
function rendrePartage(fileId: string, largeurPx: number, signal: AbortSignal): Promise<string> {
  return rendusEnCours.run(fileId, async (sharedSignal) => {
    const liberer = await limiteRendus.acquire(sharedSignal);
    try {
      let dataUrl: string;
      try {
        dataUrl = await rendrePremierePage(fileId, largeurPx, sharedSignal, false);
      } catch (e) {
        if (!estErreurWorker(e)) throw e;
        dataUrl = await rendrePremierePage(fileId, largeurPx, sharedSignal, true);
      }
      rendus.set(fileId, dataUrl);
      return dataUrl;
    } catch (e) {
      if (!(e instanceof AbortError)) echecs.set(fileId, true);
      throw e;
    } finally {
      liberer();
    }
  }, signal);
}

type Etat = 'serveur' | 'attente' | 'rendu' | 'done' | 'error';

export function PdfThumbnail({ fileId, className = '', fallback }: PdfThumbnailProps) {
  const conteneurRef = useRef<HTMLDivElement>(null);
  const [image, setImage] = useState<string | null>(() => rendus.get(fileId) ?? null);
  const [etat, setEtat] = useState<Etat>(() => {
    if (rendus.has(fileId)) return 'done';
    if (echecs.has(fileId)) return 'error';
    return 'serveur';
  });
  const [visible, setVisible] = useState(false);

  // Changement de fichier : état réinitialisé.
  useEffect(() => {
    const cached = rendus.get(fileId) ?? null;
    setImage(cached);
    setEtat(cached ? 'done' : echecs.has(fileId) ? 'error' : 'serveur');
    setVisible(false);
  }, [fileId]);

  // Miniature serveur en échec : le serveur dit-il le PDF illisible ?
  const surErreurServeur = () => {
    setEtat('attente');
    fetch(`/api/files/${fileId}/thumbnail?status=1`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : { status: r.status === 401 || r.status === 404 ? 'NO_ACCESS' : 'ERROR' }))
      .then(({ status }: { status?: string }) => {
        if (status === 'UNSUPPORTED' || status === 'FAILED' || status === 'NO_ACCESS') {
          echecs.set(fileId, true);
          setEtat('error');
        } else {
          setEtat('rendu'); // en attente de génération, désactivée, ou erreur : repli navigateur borné
        }
      })
      .catch(() => setEtat('rendu'));
  };

  // Repli navigateur : attendre que la vignette soit (presque) visible.
  useEffect(() => {
    if (etat !== 'rendu' || visible) return;
    const el = conteneurRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [etat, visible]);

  useEffect(() => {
    if (etat !== 'rendu' || !visible) return;
    const controller = new AbortController();
    const largeur = conteneurRef.current?.offsetWidth || 200;
    const densite = Math.min(2, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
    const largeurPx = Math.min(640, Math.ceil(largeur * densite));
    rendrePartage(fileId, largeurPx, controller.signal).then(
      (dataUrl) => { if (!controller.signal.aborted) { setImage(dataUrl); setEtat('done'); } },
      (e) => { if (!controller.signal.aborted && !(e instanceof AbortError)) setEtat('error'); },
    );
    // Démontage / changement : ce demandeur se retire ; le rendu est annulé
    // s'il n'a plus aucun demandeur.
    return () => controller.abort();
  }, [etat, visible, fileId]);

  if (etat === 'error') {
    if (fallback !== undefined) return <div className={`relative overflow-hidden ${className}`}>{fallback}</div>;
    return (
      <div className={`flex items-center justify-center bg-slate-800 ${className}`}>
        <FileText className="w-8 h-8 text-slate-400 opacity-60" aria-hidden />
      </div>
    );
  }

  return (
    <div ref={conteneurRef} className={`relative overflow-hidden bg-slate-800 ${className}`}>
      {etat === 'serveur' ? (
        // eslint-disable-next-line @next/next/no-img-element -- miniature autorisée (redirection signée), pas d'optimisation Next
        <img
          src={`/api/files/${fileId}/thumbnail`}
          alt=""
          loading="lazy"
          decoding="async"
          onError={surErreurServeur}
          className="h-full w-full bg-white object-cover object-top"
        />
      ) : image ? (
        // eslint-disable-next-line @next/next/no-img-element -- image locale (data URL)
        <img src={image} alt="" className="h-full w-full object-cover object-top" />
      ) : (
        <div className="absolute inset-0 animate-pulse bg-slate-800" />
      )}
    </div>
  );
}
