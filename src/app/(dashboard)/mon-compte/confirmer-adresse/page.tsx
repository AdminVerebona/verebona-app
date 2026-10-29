'use client';

/**
 * « Confirmer ma nouvelle adresse » — lot 96A (CDC 18 §11.3, Q8).
 *
 * Ouverte par le lien reçu à la NOUVELLE adresse. Page protégée : sans
 * session, la connexion est demandée puis la page revient ici (lien
 * conservé). La confirmation est un BOUTON — un robot de messagerie qui
 * suit le lien ne change rien. Après succès : adresse basculée, autres
 * appareils déconnectés, cette session continue (jetons réémis).
 * Ordinateur et mobile : carte unique, boutons pleine largeur sous 640 px.
 */
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { CheckCircle, AlertCircle, Loader2, MailCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useBreadcrumb } from '@/contexts/BreadcrumbContext';
import { apiClient, ApiClientError } from '@/lib/api-client';

type State = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; message: string; email: string } | { kind: 'error'; message: string };

function ConfirmContent() {
  const token = useSearchParams().get('token') ?? '';
  const [state, setState] = useState<State>({ kind: 'idle' });

  const confirm = async () => {
    setState({ kind: 'busy' });
    try {
      const r = await apiClient.post<{ message: string; email: string }>('/api/users/me/email-change/confirm', { token });
      setState({ kind: 'done', message: r.message, email: r.email });
    } catch (e) {
      setState({ kind: 'error', message: e instanceof ApiClientError && e.serverMessage ? e.serverMessage : 'La confirmation n’a pas pu être enregistrée. Réessayez.' });
    }
  };

  if (!token) {
    return <Result icon="error" title="Lien incomplet" text="Ce lien ne contient pas de code de confirmation. Copiez-le entièrement depuis l’e-mail, ou refaites la demande depuis Mon compte › Sécurité." />;
  }
  if (state.kind === 'done') {
    return <Result icon="ok" title="Adresse confirmée" text={state.message} detail={`Adresse du compte : ${state.email}`} />;
  }
  if (state.kind === 'error') {
    return <Result icon="error" title="Confirmation impossible" text={state.message} />;
  }
  return (
    <Card className="w-full max-w-lg bg-[color:var(--bg-card)] border-[color:var(--border-subtle)]">
      <CardHeader className="space-y-3">
        <div className="flex justify-center"><MailCheck className="w-12 h-12 text-[color:var(--accent)]" /></div>
        <CardTitle role="heading" aria-level={1} className="text-center text-xl font-bold text-[color:var(--text-primary)]">Confirmer ma nouvelle adresse</CardTitle>
        <CardDescription className="text-center text-[color:var(--text-muted)]">
          Cette adresse deviendra celle de votre compte : pour vous connecter et pour recevoir nos messages. Vos autres
          appareils seront déconnectés ; vous restez connecté ici. Un message de sécurité sera envoyé à l’ancienne et à la
          nouvelle adresse.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 sm:flex-row sm:justify-center">
        <Button className="w-full min-h-11 sm:w-auto" onClick={() => void confirm()} disabled={state.kind === 'busy'} data-testid="confirm-email-change">
          {state.kind === 'busy' ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Confirmation…</> : 'Confirmer cette adresse'}
        </Button>
        <Button asChild variant="ghost" className="w-full min-h-11 sm:w-auto"><Link href="/mon-compte#securite">Plus tard</Link></Button>
      </CardContent>
    </Card>
  );
}

function Result({ icon, title, text, detail }: { icon: 'ok' | 'error'; title: string; text: string; detail?: string }) {
  return (
    <Card className="w-full max-w-lg bg-[color:var(--bg-card)] border-[color:var(--border-subtle)]">
      <CardHeader className="space-y-3">
        <div className="flex justify-center">
          {icon === 'ok'
            ? <CheckCircle className="w-12 h-12 text-[color:var(--text-success)]" />
            : <AlertCircle className="w-12 h-12 text-[color:var(--attention-on-soft)]" />}
        </div>
        <CardTitle role="heading" aria-level={1} className="text-center text-xl font-bold text-[color:var(--text-primary)]">{title}</CardTitle>
        <CardDescription className="text-center text-[color:var(--text-muted)]">{text}</CardDescription>
        {detail && <p className="text-center text-sm font-medium text-[color:var(--text-primary)] break-words">{detail}</p>}
      </CardHeader>
      <CardContent className="flex justify-center">
        <Button asChild className="w-full min-h-11 sm:w-auto"><Link href="/mon-compte#securite">Retour à Mon compte</Link></Button>
      </CardContent>
    </Card>
  );
}

export default function ConfirmEmailChangePage() {
  const { setBreadcrumbs } = useBreadcrumb();
  useEffect(() => {
    setBreadcrumbs([{ label: 'Mon compte', href: '/mon-compte' }, { label: 'Confirmer ma nouvelle adresse' }]);
  }, [setBreadcrumbs]);
  return (
    <div className="flex w-full justify-center px-0 py-6 sm:py-10">
      <Suspense fallback={<Loader2 className="w-8 h-8 animate-spin text-[color:var(--text-muted)]" />}>
        <ConfirmContent />
      </Suspense>
    </div>
  );
}
