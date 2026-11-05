'use client';

/**
 * Affichage UNIQUE des 10 codes de récupération (lot 110B, ticket §2, §5) :
 * copier, télécharger, confirmation explicite de leur conservation, risque
 * de perte définitive dit dès la remise. Les codes ne sont jamais stockés
 * côté navigateur ni renvoyés au serveur.
 */
import { useState } from 'react';
import { Check, Copy, Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

export const RECOVERY_RISK_TEXT =
  'Conservez ces codes en lieu sûr (gestionnaire de mots de passe, papier rangé). Chaque code ne sert qu’une fois. '
  + 'Si vous perdez à la fois vos méthodes de sécurité et ces codes, l’accès à votre compte sera définitivement perdu : '
  + 'l’assistance Verebona ne peut pas réinitialiser votre double authentification.';

export function RecoveryCodesView({ codes, onConfirm, confirmLabel = 'Continuer' }: {
  codes: string[]; onConfirm: () => Promise<void> | void; confirmLabel?: string;
}) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const text = codes.join('\n');

  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* presse-papiers refusé */ }
  };
  const download = () => {
    const blob = new Blob([`Verebona — codes de récupération\n\n${text}\n\nChaque code ne sert qu’une fois.\n`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'verebona-codes-de-recuperation.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="space-y-4" data-testid="mfa-recovery-codes">
      <p className="text-sm text-[color:var(--text-muted)]">{RECOVERY_RISK_TEXT}</p>
      <ol className="grid grid-cols-1 sm:grid-cols-2 gap-2 rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--bg-subtle)] p-3 font-mono text-sm select-all">
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
          {copied ? <Check className="w-4 h-4 mr-1" /> : <Copy className="w-4 h-4 mr-1" />}{copied ? 'Copiés' : 'Copier'}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={download}><Download className="w-4 h-4 mr-1" />Télécharger</Button>
      </div>
      <div className="flex items-start gap-2">
        <Checkbox id="mfa-codes-saved" checked={saved} onCheckedChange={(v) => setSaved(v === true)} />
        <Label htmlFor="mfa-codes-saved" className="text-sm leading-snug">J’ai conservé mes codes de récupération en lieu sûr.</Label>
      </div>
      <Button type="button" className="w-full" disabled={!saved || busy} onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } }}>
        {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}{confirmLabel}
      </Button>
    </div>
  );
}
