'use client';

/**
 * Lot 100G — désinscription des communications commerciales, SANS connexion
 * (lien {{unsubscribeUrl}} des relances après l'essai). Confirmation par un
 * bouton (POST) : un lecteur de liens de messagerie qui ouvre la page ne
 * désinscrit personne. Idempotente. Charte « Sérénité », desktop et mobile.
 */
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { FollowTheme } from '@/components/FollowTheme';
import { LogoWithBaseline } from '@/components/Logo';
import { CheckCircle2, Loader2, MailX } from 'lucide-react';

function UnsubscribeContent() {
  const sp = useSearchParams();
  const token = sp.get('t');
  const preview = sp.get('apercu') === '1';
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const confirm = async () => {
    setState('loading');
    try {
      const res = await fetch('/api/public/marketing/unsubscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t: token }),
      });
      const data = await res.json().catch(() => ({}));
      setMessage(data.message ?? '');
      setState(res.ok ? 'done' : 'error');
    } catch {
      setMessage('Désinscription momentanément indisponible. Réessayez plus tard.');
      setState('error');
    }
  };

  return (
    <div className="public-page min-h-screen flex flex-col bg-[color:var(--bg-page)] text-[color:var(--text-primary)]">
      <FollowTheme />
      <header className="flex items-center justify-center py-8 px-4">
        <LogoWithBaseline size={48} />
      </header>
      <main className="flex-1 flex items-start sm:items-center justify-center px-4 pb-10">
        <div className="w-full max-w-md bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] rounded-2xl shadow-lg overflow-hidden" data-testid="desinscription">
          <div className="h-1.5 w-full bg-[color:var(--accent)]" />
          <div className="p-6 sm:p-8 space-y-5">
            {state === 'done' ? (
              <div className="space-y-3 text-center" role="status">
                <CheckCircle2 className="w-10 h-10 mx-auto text-[color:var(--text-success)]" aria-hidden />
                <h1 className="vb-app-title">Désinscription enregistrée</h1>
                <p className="text-sm text-[color:var(--text-secondary)]">{message}</p>
              </div>
            ) : (
              <>
                <div className="space-y-2 text-center">
                  <MailX className="w-10 h-10 mx-auto text-[color:var(--accent)]" aria-hidden />
                  <h1 className="vb-app-title">Ne plus recevoir nos communications commerciales</h1>
                  <p className="text-sm text-[color:var(--text-secondary)]">
                    Vous ne recevrez plus de relances ni d’offres de Verebona par e-mail. Les messages liés à votre compte (sécurité, facturation, service) continuent.
                  </p>
                </div>
                {preview || !token ? (
                  <p className="text-sm text-center text-[color:var(--text-muted)]">
                    {preview ? 'Aperçu : ce lien est remplacé par un lien personnel dans l’e-mail envoyé.' : 'Ouvrez le lien reçu dans l’e-mail pour vous désinscrire.'}
                  </p>
                ) : (
                  <button
                    type="button" onClick={confirm} disabled={state === 'loading'} data-testid="desinscription-confirmer"
                    className="w-full min-h-[44px] flex items-center justify-center gap-2 px-4 bg-[color:var(--accent)] hover:bg-[color:var(--accent-hover)] text-[color:var(--on-accent)] font-semibold rounded-[12px] transition-colors disabled:opacity-50"
                  >
                    {state === 'loading' && <Loader2 className="w-4 h-4 animate-spin" aria-hidden />}
                    Confirmer ma désinscription
                  </button>
                )}
                {state === 'error' && (
                  <p className="text-sm text-[color:var(--text-danger)] text-center" role="alert">{message}</p>
                )}
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

export default function UnsubscribePage() {
  return (
    <Suspense fallback={<div className="public-page min-h-screen bg-[color:var(--bg-page)]" />}>
      <UnsubscribeContent />
    </Suspense>
  );
}
