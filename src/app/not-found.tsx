'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export default function NotFound() {
  const pathname = usePathname();
  const timestamp = new Date().toISOString();

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
      <p style={{ fontSize: '64px', margin: 0, lineHeight: 1 }}>404</p>
      <h1 style={{ fontSize: '20px', fontWeight: 600, margin: 0 }}>
        Page introuvable
      </h1>
      <p style={{ fontSize: '14px', color: '#94a3b8', margin: 0, maxWidth: '360px' }}>
        Cette page n&apos;existe pas ou a été déplacée.
      </p>

      {/* Diagnostic block */}
      <div
        style={{
          marginTop: '8px',
          background: '#0f172a',
          border: '1px solid #1e293b',
          borderRadius: '8px',
          padding: '12px 16px',
          textAlign: 'left',
          fontFamily: 'monospace',
          fontSize: '11px',
          color: '#64748b',
          maxWidth: '480px',
          width: '100%',
        }}
      >
        <div style={{ color: '#475569', marginBottom: '6px', fontWeight: 600, letterSpacing: '0.05em' }}>
          DIAGNOSTIC
        </div>
        <div><span style={{ color: '#3b82f6' }}>code</span>    <span style={{ color: '#94a3b8' }}>HTTP_404</span></div>
        <div><span style={{ color: '#3b82f6' }}>path</span>    <span style={{ color: '#fbbf24' }}>{pathname ?? '—'}</span></div>
        <div><span style={{ color: '#3b82f6' }}>time</span>    <span style={{ color: '#94a3b8' }}>{timestamp}</span></div>
        <div><span style={{ color: '#3b82f6' }}>env</span>     <span style={{ color: '#94a3b8' }}>{process.env.NODE_ENV}</span></div>
      </div>

      <div style={{ display: 'flex', gap: '12px', marginTop: '8px' }}>
        <a
          href="/accueil"
          style={{
            padding: '10px 20px',
            background: '#3b82f6',
            color: '#fff',
            borderRadius: '8px',
            textDecoration: 'none',
            fontSize: '14px',
            fontWeight: 500,
          }}
        >
          Tableau de bord
        </a>
        <Link
          href="/"
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
          Accueil
        </Link>
      </div>
    </div>
  );
}
