'use client';

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
        <div role="alert" style={{
          minHeight: '100vh', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          background: '#020617', color: '#f8fafc',
          fontFamily: 'system-ui, sans-serif', gap: '12px', padding: '24px', textAlign: 'center',
        }}>
          <h1 style={{ fontSize: '18px', fontWeight: 600, margin: 0 }}>{msg.title}</h1>
          <p style={{ fontSize: '14px', color: '#94a3b8', margin: 0, maxWidth: '420px' }}>{msg.detail}</p>
          <div style={{ display: 'flex', gap: '12px', marginTop: '4px' }}>
            {msg.button && (
              <button
                onClick={manualReload}
                style={{ padding: '10px 20px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '14px', fontWeight: 500, cursor: 'pointer' }}
              >
                {msg.button}
              </button>
            )}
            <a
              href="/accueil"
              style={{ padding: '10px 20px', background: '#1e293b', color: '#cbd5e1', borderRadius: '8px', textDecoration: 'none', fontSize: '14px', fontWeight: 500 }}
            >
              Tableau de bord
            </a>
          </div>
        </div>
      );
    }
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        background: '#020617', color: '#f8fafc',
        fontFamily: 'system-ui, sans-serif', gap: '12px', padding: '24px', textAlign: 'center',
      }}>
        <div style={{
          width: '32px', height: '32px', border: '3px solid #1e293b',
          borderTop: '3px solid #3b82f6', borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
        }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        <p style={{ fontSize: '14px', color: '#94a3b8', margin: 0 }}>
          Mise à jour détectée, rechargement…
        </p>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#020617',
        color: '#f8fafc',
        fontFamily: 'system-ui, sans-serif',
        gap: '16px',
        padding: '24px',
        textAlign: 'center',
      }}
    >
      <p style={{ fontSize: '48px', margin: 0, lineHeight: 1 }}>⚠️</p>
      <h1 style={{ fontSize: '20px', fontWeight: 600, margin: 0 }}>
        Une erreur est survenue
      </h1>
      <p style={{ fontSize: '14px', color: '#94a3b8', margin: 0, maxWidth: '400px' }}>
        {error.message || 'Erreur inattendue. Réessayez ou revenez au tableau de bord.'}
      </p>

      {/* Diagnostic block */}
      <div
        style={{
          marginTop: '4px',
          background: '#0f172a',
          border: '1px solid #1e293b',
          borderRadius: '8px',
          padding: '12px 16px',
          textAlign: 'left',
          fontFamily: 'monospace',
          fontSize: '11px',
          color: '#64748b',
          maxWidth: '520px',
          width: '100%',
        }}
      >
        <div style={{ color: '#475569', marginBottom: '6px', fontWeight: 600, letterSpacing: '0.05em' }}>
          DIAGNOSTIC
        </div>
        <div><span style={{ color: '#ef4444' }}>ref</span>     <span style={{ color: '#fbbf24' }}>{shortRef}</span></div>
        <div><span style={{ color: '#ef4444' }}>type</span>    <span style={{ color: '#94a3b8' }}>{error.name ?? 'Error'}</span></div>
        <div><span style={{ color: '#ef4444' }}>path</span>    <span style={{ color: '#fbbf24' }}>{pathname ?? '—'}</span></div>
        <div><span style={{ color: '#ef4444' }}>time</span>    <span style={{ color: '#94a3b8' }}>{timestamp}</span></div>
        {error.digest && (
          <div><span style={{ color: '#ef4444' }}>digest</span>  <span style={{ color: '#94a3b8' }}>{error.digest}</span></div>
        )}
        <div><span style={{ color: '#ef4444' }}>env</span>     <span style={{ color: '#94a3b8' }}>{process.env.NODE_ENV}</span></div>

        {/* Stack trace in dev only */}
        {isDev && error.stack && (
          <details style={{ marginTop: '8px' }}>
            <summary style={{ cursor: 'pointer', color: '#475569', userSelect: 'none' }}>
              stack trace
            </summary>
            <pre
              style={{
                marginTop: '6px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                color: '#64748b',
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

      <div style={{ display: 'flex', gap: '12px', marginTop: '4px' }}>
        <button
          onClick={reset}
          style={{
            padding: '10px 20px',
            background: '#3b82f6',
            color: '#fff',
            border: 'none',
            borderRadius: '8px',
            fontSize: '14px',
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          Réessayer
        </button>
        <a
          href="/accueil"
          style={{
            padding: '10px 20px',
            background: '#1e293b',
            color: '#cbd5e1',
            borderRadius: '8px',
            textDecoration: 'none',
            fontSize: '14px',
            fontWeight: 500,
          }}
        >
          Tableau de bord
        </a>
      </div>
    </div>
  );
}
