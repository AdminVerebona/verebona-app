"use client"

import { useEffect, useRef, useState } from 'react';
import { FileText } from 'lucide-react';

interface PdfThumbnailProps {
  fileId: string;
  className?: string;
}

export function PdfThumbnail({ fileId, className = '' }: PdfThumbnailProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<'loading' | 'done' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;

    async function render() {
      try {
        // Get signed URL for the PDF

        const res = await fetch(`/api/files/${fileId}/view`, {
      credentials: 'include',
        });
        if (!res.ok) { setStatus('error'); return; }
        const { viewUrl } = await res.json();
        if (cancelled) return;

        // Dynamically import pdfjs-dist to keep bundle small
        const pdfjsLib = await import('pdfjs-dist');
        // Use worker from public folder (copied at build time)
        pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

        const loadingTask = pdfjsLib.getDocument({ url: viewUrl, disableStream: true });
        const pdf = await loadingTask.promise;
        if (cancelled) return;

        const page = await pdf.getPage(1);
        if (cancelled) return;

        const canvas = canvasRef.current;
        if (!canvas) { setStatus('error'); return; }

        // Scale to fill the canvas nicely
        const viewport = page.getViewport({ scale: 1 });
        const containerWidth = canvas.offsetWidth || 160;
        const scale = containerWidth / viewport.width;
        const scaledViewport = page.getViewport({ scale });

        canvas.width = scaledViewport.width;
        canvas.height = scaledViewport.height;

        const ctx = canvas.getContext('2d');
        if (!ctx) { setStatus('error'); return; }

        await page.render({ canvasContext: ctx as any, canvas, viewport: scaledViewport }).promise;
        if (cancelled) return;

        setStatus('done');
      } catch {
        if (!cancelled) setStatus('error');
      }
    }

    render();
    return () => { cancelled = true; };
  }, [fileId]);

  if (status === 'error') {
    return (
      <div className={`flex items-center justify-center bg-red-900/30 ${className}`}>
        <FileText className="w-8 h-8 text-red-400 opacity-50" />
      </div>
    );
  }

  return (
    <div className={`relative overflow-hidden ${className}`}>
      {status === 'loading' && (
        <div className="absolute inset-0 bg-slate-800 animate-pulse" />
      )}
      <canvas
        ref={canvasRef}
        className="w-full h-full object-cover"
        style={{ display: status === 'done' ? 'block' : 'none' }}
      />
    </div>
  );
}
