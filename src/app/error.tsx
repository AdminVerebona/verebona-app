'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

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
  const autoRetried = useRef(false);

  // ChunkLoadError = chunk JS obsolète après déploiement → reload automatique
  const isChunkError = error.name === 'ChunkLoadError'
    || error.message?.includes('Failed to load chunk')
    || error.message?.includes('Loading chunk')
    || error.message?.includes('dynamically imported module');

  useEffect(() => {
    if (isChunkError && !autoRetried.current) {
      autoRetried.current = true;
      // Vider le cache SW si présent, puis recharger
      if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_CACHE' });
        setTimeout(() => window.location.reload(), 300);
      } else {
        window.location.reload();
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

  // Pour les erreurs de chunk : afficher un écran de rechargement propre
  if (isChunkError) {
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
