"use client"

import { useEffect, useRef, useState } from 'react';
import { FileText } from 'lucide-react';

interface PdfThumbnailProps {
  fileId: string;
  className?: string;
}

/**
 * Aperçu de la première page d'un PDF.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RENDU À LA DEMANDE, ET UNE SEULE FOIS PAR DOCUMENT
 *
 * Chaque vignette demandait une URL signée, téléchargeait le PDF et rendait
 * sa page dès son montage — y compris hors écran, et de nouveau à chaque
 * remontage (repli d'une rubrique, changement de vue). Sur « Mes documents »,
 * qui affiche toutes les vignettes d'un coup, c'était autant de
 * téléchargements simultanés.
 *
 * Désormais :
 *   - le rendu attend que la vignette approche de l'écran
 *     (IntersectionObserver, marge de 200 px) ;
 *   - l'image obtenue est gardée en mémoire (par identifiant de fichier) pour
 *     la session : un remontage l'affiche immédiatement ;
 *   - la résolution tient compte de la densité d'écran, plafonnée à 2×.
 * ══════════════════════════════════════════════════════════════════════════
 */
const rendus = new Map<string, string>();

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

async function ouvrirPdf(fileId: string, forcerWorkerDuPaquet: boolean) {
  const pdfjsLib = await chargerPdfJs(forcerWorkerDuPaquet);
  const sources: string[] = [];
  const res = await fetch(`/api/files/${fileId}/view`, { credentials: 'include' }).catch(() => null);
  if (res?.ok) {
    const { viewUrl } = await res.json().catch(() => ({ viewUrl: null }));
    if (viewUrl) sources.push(viewUrl);
  }
  sources.push(`/api/files/${fileId}/proxy`);
  let derniere: unknown = null;
  for (const url of sources) {
    try {
      return await pdfjsLib.getDocument({ url, disableStream: true, withCredentials: url.startsWith('/') }).promise;
    } catch (e) {
      derniere = e;
      // Erreur de worker : changer d'URL n'y changerait rien.
      if (/worker|version/i.test(String((e as Error)?.message ?? e))) throw e;
    }
  }
  throw derniere ?? new Error('PDF illisible');
}

export function PdfThumbnail({ fileId, className = '' }: PdfThumbnailProps) {
  const conteneurRef = useRef<HTMLDivElement>(null);
  const [image, setImage] = useState<string | null>(() => rendus.get(fileId) ?? null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>(
    () => (rendus.has(fileId) ? 'done' : 'idle'),
  );
  const [visible, setVisible] = useState(false);

  // Attendre que la vignette soit (presque) visible.
  useEffect(() => {
    if (image) return;
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
  }, [image]);

  useEffect(() => {
    if (!visible || image) return;
    let cancelled = false;

    async function render() {
      setStatus('loading');
      try {
        // Import dynamique : pdfjs reste hors du bundle initial.
        let pdf;
        try {
          pdf = await ouvrirPdf(fileId, false);
        } catch (e) {
          if (!/worker|version/i.test(String((e as Error)?.message ?? e))) throw e;
          pdf = await ouvrirPdf(fileId, true);
        }
        if (cancelled) return;
        const page = await pdf.getPage(1);
        if (cancelled) return;

        const largeur = conteneurRef.current?.offsetWidth || 200;
        const densite = Math.min(2, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: (largeur * densite) / base.width });

        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) { setStatus('error'); return; }

        await page.render({ canvasContext: ctx as never, canvas, viewport }).promise;
        if (cancelled) return;

        const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
        rendus.set(fileId, dataUrl);
        setImage(dataUrl);
        setStatus('done');
        void pdf.destroy();
      } catch {
        if (!cancelled) setStatus('error');
      }
    }

    void render();
    return () => { cancelled = true; };
  }, [visible, image, fileId]);

  if (status === 'error') {
    return (
      <div className={`flex items-center justify-center bg-slate-800 ${className}`}>
        <FileText className="w-8 h-8 text-slate-400 opacity-60" aria-hidden />
      </div>
    );
  }

  return (
    <div ref={conteneurRef} className={`relative overflow-hidden bg-slate-800 ${className}`}>
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element -- image locale (data URL)
        <img src={image} alt="" className="h-full w-full object-cover object-top" />
      ) : (
        <div className="absolute inset-0 animate-pulse bg-slate-800" />
      )}
    </div>
  );
}
