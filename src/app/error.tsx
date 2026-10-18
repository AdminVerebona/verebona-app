'use client';

import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import {
  handleChunkError,
  isChunkLoadError,
  manualReload,
  recoveryMessage,
  type RecoveryDecision,
} from '@/lib/pwa/chunk-recovery';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const pathname = usePathname();
  const timestamp = new Date().toISOString();
  const shortRef = error.digest?.slice(0, 8) ?? btoa(error.message).slice(0, 8).toUpperCase();
  const handled = useRef(false);
  const [recovery, setRecovery] = useState<RecoveryDecision | null>(null);

  // Erreur de chunk (version retirée par un déploiement, réseau coupé) :
  // règle unique de reprise (APP-PERF-10) — au plus un rechargement
  // automatique par incident, mémorisé au-delà du rechargement ; sinon
  // reprise explicite. Plus de purge des caches de l'origine.
  const isChunkError = isChunkLoadError(error);

  useEffect(() => {
    if (isChunkError) {
      if (!handled.current) {
        handled.current = true;
        setRecovery(handleChunkError({ inline: true }));
      }
      return;
    }
    console.error('[Error Boundary]', {
      message: error.message,
      name: error.name,
      digest: error.digest,
      path: pathname,
      time: timestamp,
    });
  }, [error]);

  const isDev = process.env.NODE_ENV === 'development';

  // Pour les erreurs de chunk : rechargement en cours, ou reprise explicite
  if (isChunkError) {
    const msg = recovery ? recoveryMessage(recovery) : null;
    if (msg && recovery?.action !== 'reload') {
      return (
        <div role="alert" style={PAGE}>
          <h1 style={{ ...TITLE, fontSize: '18px' }}>{msg.title}</h1>
          <p style={{ ...MUTED, maxWidth: '420px' }}>{msg.detail}</p>
          <div style={{ display: 'flex', gap: '12px', marginTop: '4px', flexWrap: 'wrap', justifyContent: 'center' }}>
            {msg.button && (
              <button onClick={manualReload} style={PRIMARY}>
                {msg.button}
              </button>
            )}
            <a href="/accueil" style={SECONDARY}>
              Tableau de bord
            </a>
          </div>
        </div>
      );
    }
    return (
      <div style={{ ...PAGE, gap: '12px' }}>
        <div style={{
          width: '32px', height: '32px', border: '3px solid var(--border)',
          borderTop: '3px solid var(--accent)', borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
        }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        <p style={MUTED}>
          Mise à jour détectée, rechargement…
        </p>
      </div>
    );
  }

  return (
    <div style={PAGE}>
      {/* Pictogramme d'attention (charte : pas d'emoji) — l'état est écrit dans le titre. */}
      <span aria-hidden style={{
        width: '48px', height: '48px', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--attention-soft)', color: 'var(--attention-on-soft)',
      }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </svg>
      </span>
      <h1 style={TITLE}>
        Une erreur est survenue
      </h1>
      <p style={{ ...MUTED, maxWidth: '400px' }}>
        {error.message || 'Erreur inattendue. Réessayez ou revenez au tableau de bord.'}
      </p>

      {/* Diagnostic block */}
      <div
        style={{
          marginTop: '4px',
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: '12px',
          padding: '12px 16px',
          textAlign: 'left',
          fontFamily: 'var(--vb-font-mono)',
          fontSize: '11px',
          color: 'var(--text-muted)',
          maxWidth: '520px',
          width: '100%',
        }}
      >
        <div style={{ color: 'var(--text-muted)', marginBottom: '6px', fontWeight: 700, letterSpacing: '0.05em' }}>
          DIAGNOSTIC
        </div>
        <div><span style={KEY}>ref</span>     <span style={VAL}>{shortRef}</span></div>
        <div><span style={KEY}>type</span>    <span style={VAL}>{error.name ?? 'Error'}</span></div>
        <div><span style={KEY}>path</span>    <span style={VAL}>{pathname ?? '—'}</span></div>
        <div><span style={KEY}>time</span>    <span style={VAL}>{timestamp}</span></div>
        {error.digest && (
          <div><span style={KEY}>digest</span>  <span style={VAL}>{error.digest}</span></div>
        )}
        <div><span style={KEY}>env</span>     <span style={VAL}>{process.env.NODE_ENV}</span></div>

        {/* Stack trace in dev only */}
        {isDev && error.stack && (
          <details style={{ marginTop: '8px' }}>
            <summary style={{ cursor: 'pointer', color: 'var(--text-muted)', userSelect: 'none' }}>
              stack trace
            </summary>
            <pre
              style={{
                marginTop: '6px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                color: 'var(--text-muted)',
                fontSize: '10px',
                maxHeight: '200px',
                overflowY: 'auto',
              }}
            >
              {error.stack}
            </pre>
          </details>
        )}
      </div>

      <div style={{ display: 'flex', gap: '12px', marginTop: '4px', flexWrap: 'wrap', justifyContent: 'center' }}>
        <button onClick={reset} style={PRIMARY}>
          Réessayer
        </button>
        <a href="/accueil" style={SECONDARY}>
          Tableau de bord
        </a>
      </div>
    </div>
  );
}

/*
 * Charte « Sérénité » 2026 (lot 66B1) : la page d'erreur est rendue DANS le
 * layout racine — les jetons du thème (clair / sombre) y sont disponibles.
 * Plus aucune couleur écrite en dur ; boutons primaire (pétrole) et
 * secondaire (contour) de la charte, rayon 12.
 */
const PAGE: React.CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--bg-page)',
  color: 'var(--text-primary)',
  fontFamily: 'var(--vb-font)',
  gap: '16px',
  padding: '24px 16px',
  textAlign: 'center',
};
const TITLE: React.CSSProperties = { fontSize: '20px', fontWeight: 700, letterSpacing: '-.01em', margin: 0, color: 'var(--text-primary)' };
const MUTED: React.CSSProperties = { fontSize: '14px', color: 'var(--text-muted)', margin: 0 };
const KEY: React.CSSProperties = { color: 'var(--attention)' };
const VAL: React.CSSProperties = { color: 'var(--text-primary)' };
const BUTTON: React.CSSProperties = {
  padding: '10px 20px', borderRadius: '12px', fontSize: '14px', fontWeight: 700, cursor: 'pointer', textDecoration: 'none',
  fontFamily: 'inherit', lineHeight: 1.2,
};
const PRIMARY: React.CSSProperties = { ...BUTTON, background: 'var(--accent)', color: 'var(--on-accent)', border: '1px solid transparent' };
const SECONDARY: React.CSSProperties = { ...BUTTON, fontWeight: 600, background: 'var(--bg-card)', color: 'var(--accent)', border: '1px solid var(--accent)' };
