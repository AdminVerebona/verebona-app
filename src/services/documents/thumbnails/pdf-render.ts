/**
 * Rendu serveur de la 1re page d'un PDF, dans un processus enfant borné
 * (APP-PERF-27).
 *
 * Le rendu PDF.js est synchrone et peut être très long sur un PDF complexe :
 * dans le processus web, il bloquerait la boucle d'événements de toutes les
 * requêtes. Il tourne donc dans `scripts/render-pdf-thumbnail.mjs` :
 *   · durée bornée (`timeoutMs`, SIGKILL) ;
 *   · mémoire bornée (`--max-old-space-size`) ;
 *   · sortie bornée (`maxOutputBytes`) ;
 *   · erreurs typées : PDF protégé, illisible, trop grand, délai dépassé.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

export type PdfRenderErrorCode = 'PDF_PASSWORD' | 'PDF_INVALID' | 'PDF_TOO_LARGE' | 'PDF_TIMEOUT' | 'PDF_RENDER_FAILED';

export class PdfRenderError extends Error {
  constructor(readonly code: PdfRenderErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'PdfRenderError';
  }
  /** Erreur définitive (inutile de réessayer). */
  get permanent(): boolean {
    return this.code === 'PDF_PASSWORD' || this.code === 'PDF_INVALID' || this.code === 'PDF_TOO_LARGE';
  }
}

export interface PdfRenderOptions {
  width: number;
  timeoutMs?: number;
  maxOldSpaceMb?: number;
  maxOutputBytes?: number;
  /** Chemin du script (tests). */
  scriptPath?: string;
}

export function pdfRenderScriptPath(): string {
  return path.join(process.cwd(), 'scripts', 'render-pdf-thumbnail.mjs');
}

/** Rend la 1re page en PNG. Lève `PdfRenderError`. */
export function renderPdfFirstPage(pdf: Buffer, opts: PdfRenderOptions): Promise<Buffer> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxOut = opts.maxOutputBytes ?? 20 * 1024 * 1024;
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [`--max-old-space-size=${opts.maxOldSpaceMb ?? 384}`, opts.scriptPath ?? pdfRenderScriptPath(), `--width=${Math.round(opts.width)}`],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { NODE_ENV: process.env.NODE_ENV ?? 'production', PATH: process.env.PATH ?? '' } },
    );
    const out: Buffer[] = [];
    let outBytes = 0;
    let stderr = '';
    let settled = false;
    const done = (err: PdfRenderError | null, value?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        if (child.exitCode === null) child.kill('SIGKILL');
        reject(err);
      } else {
        resolve(value!);
      }
    };
    const timer = setTimeout(() => done(new PdfRenderError('PDF_TIMEOUT')), timeoutMs);

    child.stdout.on('data', (c: Buffer) => {
      outBytes += c.length;
      if (outBytes > maxOut) { done(new PdfRenderError('PDF_TOO_LARGE', 'sortie trop volumineuse')); return; }
      out.push(c);
    });
    child.stderr.on('data', (c: Buffer) => { if (stderr.length < 2000) stderr += c.toString('utf8'); });
    child.on('error', (e) => done(new PdfRenderError('PDF_RENDER_FAILED', e.message)));
    child.on('close', (code, signal) => {
      if (settled) return;
      if (code === 0 && outBytes > 0) return done(null, Buffer.concat(out));
      if (code === 2) return done(new PdfRenderError('PDF_PASSWORD'));
      if (code === 3) return done(new PdfRenderError('PDF_INVALID'));
      if (code === 4) return done(new PdfRenderError('PDF_TOO_LARGE'));
      done(new PdfRenderError('PDF_RENDER_FAILED', `code ${code ?? signal} ${stderr.slice(0, 300)}`));
    });
    // EPIPE si l'enfant meurt avant d'avoir tout lu : traité par `close`.
    child.stdin.on('error', () => undefined);
    child.stdin.end(pdf);
  });
}
