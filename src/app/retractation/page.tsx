'use client';

/**
 * Page publique de rétractation — CDC 6 §6.1, §6.3 et §7.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TROIS EXIGENCES DE VOCABULAIRE, LITTÉRALES
 *
 * Le CDC impose des libellés exacts, et ce n'est pas une coquetterie :
 *
 *   · §6.1 — le lien s'intitule « Renoncer au contrat ici » ;
 *   · §7.3 — le bouton final porte « Confirmer la rétractation », et
 *     « aucun bouton de confirmation ambigu, tel que Continuer, Valider ou
 *     Envoyer, ne doit être utilisé seul » ;
 *   · §7.1 — la page explique qu'il s'agit d'une rétractation et NON d'une
 *     résiliation, et « aucun motif de rétractation ne doit être exigé ».
 *
 * Un consommateur doit comprendre sans ambiguïté quel acte il accomplit. Un
 * bouton « Valider » sur un écran de rétractation ne le lui dit pas.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Accessible sans session (§6.1). L'authentification sert seulement à
 * préremplir : elle n'est jamais la seule voie d'accès.
 */

import { useCallback, useEffect, useState, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LogoWithBaseline } from '@/components/Logo';
import { ForceTheme } from '@/components/ForceTheme';
import { AlertTriangle, CheckCircle, Loader2, MailCheck, ShieldAlert } from 'lucide-react';

interface Summary {
  firstName: string;
  lastName: string;
  email: string;
  offerLabel: string;
  billingPeriodLabel: string;
  contractConcludedAt: string | null;
  withdrawalDeadlineAt: string | null;
  deadlineDeferred: boolean;
  deadlineDeferralReason: string | null;
  amountLabel: string;
  dataDeletionAt: string;
}

type Step = 'presentation' | 'identify' | 'sent' | 'review' | 'done' | 'blocked';

function parisDate(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', dateStyle: 'long',
  }).format(new Date(iso));
}

function parisDateTime(iso: string): string {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', dateStyle: 'long', timeStyle: 'short',
  }).format(new Date(iso));
}

function WithdrawalContent() {
  const params = useSearchParams();
  const token = params.get('token');

  const [step, setStep] = useState<Step>('presentation');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [blockedMessage, setBlockedMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', contractReference: '' });
  const [result, setResult] = useState<{ publicReference: string; requestedAt: string; dataExportDeadlineAt: string } | null>(null);

  // Clé d'idempotence tirée une fois pour toute la page : un double clic, ou
  // un rechargement pendant l'envoi, ne crée pas deux déclarations (§7.4).
  const [idempotencyKey] = useState(
    () => `wd-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  );

  /** Arrivée par le lien reçu par courriel, ou session existante. */
  const loadContext = useCallback(async () => {
    setBusy(true);
    try {
      {
        const r = await fetch(`/api/withdrawal/public/verify`, { credentials: 'include' });
        const data = await r.json();
        if (!r.ok) { setError(data.error); setStep('presentation'); return; }
        if (data.reason) { setBlockedMessage(data.message); setStep('blocked'); return; }
        setSummary(data.summary);
        setStep('review');
        return;
      }
      // Sans jeton : on tente la session, qui permet de sauter la vérification.
      const r = await fetch('/api/withdrawal/prepare', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (r.ok) {
        const data = await r.json();
        if (data.eligible === false) { setBlockedMessage(data.message); setStep('blocked'); return; }
        setSummary(data.summary);
        setStep('review');
      }
      // Non connecté : on reste sur la présentation, le parcours public prend
      // le relais. C'est le cas nominal, pas une erreur.
    } finally {
      setBusy(false);
    }
  }, [token]);

  useEffect(() => { loadContext(); }, [loadContext]);

  const startPublic = async () => {
    setBusy(true); setError(null);
    try {
      const r = await fetch('/api/withdrawal/public/start', {
      credentials: 'include',
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await r.json();
      if (!r.ok) { setError(data.error); return; }
      setStep('sent');
    } finally { setBusy(false); }
  };

  const confirm = async () => {
    setBusy(true); setError(null);
    try {
      const r = await fetch('/api/withdrawal/confirm', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: token ?? undefined,
          firstName: summary?.firstName,
          lastName: summary?.lastName,
          receiptEmail: summary?.email,
          idempotencyKey,
        }),
      });
      const data = await r.json();
      if (!r.ok) { setError(data.error); return; }
      setResult(data);
      setStep('done');
    } finally { setBusy(false); }
  };

  return (
    <Shell>
      {step === 'presentation' && (
        <>
          <CardHeader>
            <CardTitle>Renoncer au contrat</CardTitle>
            <CardDescription>
              Exercer votre droit de rétractation sur un abonnement Verebona payant.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* §7.1 : distinguer explicitement rétractation et résiliation. */}
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
              <p className="font-medium mb-1">Rétractation, et non résiliation</p>
              <p className="text-muted-foreground">
                La rétractation annule le contrat comme s&apos;il n&apos;avait jamais existé et
                donne lieu à un remboursement intégral. La résiliation, elle, met fin
                à l&apos;abonnement à son échéance, sans remboursement.
              </p>
            </div>

            <div className="text-sm space-y-2">
              <p className="font-medium">Ce qui se passera</p>
              <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
                <li>Le contrat sera annulé immédiatement.</li>
                <li>Le remboursement sera <strong>intégral</strong>, sans retenue ni frais.</li>
                <li>L&apos;accès aux fonctions payantes sera suspendu.</li>
                <li>Vos données resteront exportables pendant <strong>30 jours</strong>.</li>
                <li>Passé ce délai, et sans nouvelle souscription, elles seront supprimées.</li>
              </ul>
            </div>

            {/* §7.1 : « aucun motif de rétractation ne doit être exigé ». */}
            <p className="text-sm text-muted-foreground">
              Vous n&apos;avez aucun motif à fournir : ce droit s&apos;exerce librement.
            </p>

            {error && <ErrorBox message={error} />}

            <Button className="w-full" onClick={() => setStep('identify')} disabled={busy}>
              Commencer ma demande
            </Button>
          </CardContent>
        </>
      )}

      {step === 'identify' && (
        <>
          <CardHeader>
            <CardTitle>Retrouver votre contrat</CardTitle>
            <CardDescription>
              Nous vous enverrons un lien de vérification à l&apos;adresse de votre compte.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field id="firstName" label="Prénom" value={form.firstName}
                     onChange={(v) => setForm({ ...form, firstName: v })} />
              <Field id="lastName" label="Nom" value={form.lastName}
                     onChange={(v) => setForm({ ...form, lastName: v })} />
            </div>
            <Field id="email" label="Adresse électronique du compte" type="email"
                   value={form.email} onChange={(v) => setForm({ ...form, email: v })} />
            <Field id="contractReference" label="Référence du contrat ou de la facture (facultatif)"
                   value={form.contractReference}
                   onChange={(v) => setForm({ ...form, contractReference: v })} />
            {/* §6.3 : « l'absence de référence contractuelle ne doit pas bloquer
                la démarche si le contrat peut être retrouvé à partir de
                l'adresse électronique et de l'identité ». */}
            <p className="text-xs text-muted-foreground">
              Si vous ne disposez pas de cette référence, laissez le champ vide :
              nous retrouverons votre contrat à partir de votre adresse.
            </p>

            {error && <ErrorBox message={error} />}

            <Button className="w-full" onClick={startPublic}
                    disabled={busy || !form.email || !form.firstName || !form.lastName}>
              {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Recevoir le lien de vérification
            </Button>
          </CardContent>
        </>
      )}

      {step === 'sent' && (
        <>
          <CardHeader className="text-center space-y-3">
            <MailCheck className="w-12 h-12 mx-auto text-blue-400" />
            <CardTitle>Vérifiez votre boîte mail</CardTitle>
            <CardDescription>
              Si un compte Verebona est associé à cette adresse, vous allez recevoir
              un lien vous permettant de poursuivre votre demande. Il est valable
              30 minutes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground text-center">
              Votre demande n&apos;est pas encore enregistrée : elle le sera après
              confirmation depuis ce lien.
            </p>
          </CardContent>
        </>
      )}

      {step === 'review' && summary && (
        <>
          <CardHeader>
            <CardTitle>Récapitulatif avant confirmation</CardTitle>
            <CardDescription>Vérifiez ces informations avant de confirmer.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <dl className="text-sm rounded-lg border border-[color:var(--border-subtle)] divide-y divide-[color:var(--border-subtle)]">
              <Row label="Titulaire" value={`${summary.firstName} ${summary.lastName}`} />
              <Row label="Adresse de réception" value={summary.email} />
              <Row label="Offre" value={`${summary.offerLabel} — facturation ${summary.billingPeriodLabel}`} />
              <Row label="Conclu le" value={parisDate(summary.contractConcludedAt)} />
              <Row
                label="Délai de rétractation jusqu’au"
                value={
                  parisDate(summary.withdrawalDeadlineAt) +
                  (summary.deadlineDeferred && summary.deadlineDeferralReason
                    ? ` (reporté : ${summary.deadlineDeferralReason})`
                    : '')
                }
              />
              <Row label="Remboursement estimé" value={summary.amountLabel} />
              <Row label="Moyen de remboursement" value="Votre moyen de paiement d’origine" />
              <Row label="Suppression des données prévue le" value={parisDate(summary.dataDeletionAt)} />
            </dl>

            <p className="text-xs text-muted-foreground">
              Le montant est une estimation calculée sur les sommes encaissées. Le
              remboursement portera sur les paiements effectivement perçus.
            </p>

            <p className="text-xs text-muted-foreground">
              <Link href="/cgvu" target="_blank" className="text-primary hover:underline">
                Conditions générales
              </Link>
              {' · '}
              <Link href="/confidentialite" target="_blank" className="text-primary hover:underline">
                Politique de confidentialité
              </Link>
            </p>

            {error && <ErrorBox message={error} />}

            {/* §7.3 : libellé exact, aucun « Valider » ou « Envoyer » seul. */}
            <Button className="w-full" onClick={confirm} disabled={busy}>
              {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Confirmer la rétractation
            </Button>
            <p className="text-xs text-muted-foreground text-center">
              Cette action est définitive.
            </p>
          </CardContent>
        </>
      )}

      {step === 'blocked' && (
        <>
          <CardHeader className="text-center space-y-3">
            <ShieldAlert className="w-12 h-12 mx-auto text-amber-500" />
            <CardTitle>Demande impossible en ligne</CardTitle>
            <CardDescription>{blockedMessage}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Vous pouvez nous écrire pour toute question relative à votre
              abonnement — nous examinerons votre situation.
            </p>
            <Button variant="outline" className="w-full" asChild>
              <Link href="/mon-compte">Retour à mon compte</Link>
            </Button>
          </CardContent>
        </>
      )}

      {step === 'done' && result && (
        <>
          <CardHeader className="text-center space-y-3">
            <CheckCircle className="w-12 h-12 mx-auto text-emerald-500" />
            <CardTitle>Rétractation enregistrée</CardTitle>
            <CardDescription>
              Votre déclaration est reçue. Un accusé de réception vient de vous être envoyé.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <dl className="text-sm rounded-lg border border-[color:var(--border-subtle)] divide-y divide-[color:var(--border-subtle)]">
              <Row label="Référence" value={result.publicReference} mono />
              <Row label="Reçue le" value={parisDateTime(result.requestedAt)} />
              <Row label="Données exportables jusqu’au" value={parisDate(result.dataExportDeadlineAt)} />
            </dl>
            <p className="text-sm text-muted-foreground">
              Conservez cette référence. Le remboursement est en cours de traitement
              sur votre moyen de paiement d&apos;origine.
            </p>
            <Button variant="outline" className="w-full" asChild>
              <Link href="/mon-compte">Accéder à mon compte</Link>
            </Button>
          </CardContent>
        </>
      )}
    </Shell>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4 px-3 py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`text-right ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
}

function Field({ id, label, value, onChange, type = 'text' }: {
  id: string; label: string; value: string; onChange: (v: string) => void; type?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded-md bg-destructive/10 text-destructive text-sm p-3 flex items-start gap-2">
      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="public-page min-h-screen flex flex-col bg-[color:var(--bg-page)]">
      <ForceTheme theme="blue" />
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-lg space-y-6">
          <div className="flex justify-center">
            <LogoWithBaseline size={50} />
          </div>
          <Card className="bg-[color:var(--bg-card)] border-[color:var(--border-subtle)] shadow-xl">
            {children}
          </Card>
        </div>
      </div>
    </div>
  );
}

export default function WithdrawalPage() {
  return (
    <Suspense
      fallback={
        <Shell>
          <CardHeader className="text-center">
            <Loader2 className="w-8 h-8 mx-auto animate-spin text-muted-foreground" />
          </CardHeader>
        </Shell>
      }
    >
      <WithdrawalContent />
    </Suspense>
  );
}
