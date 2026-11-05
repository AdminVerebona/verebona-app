'use client';

/**
 * Configuration de l'application d'authentification (lot 110B, ticket §2) :
 * QR code + clé copiable, puis PREMIER code vérifié par le serveur avant
 * activation. Le secret n'est jamais conservé par le navigateur.
 */
import { useEffect, useState } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface TotpStart { otpauthUri: string; secret: string; qrSvg: string }

export function TotpSetup({ start, confirm, onCancel }: {
  start: () => Promise<TotpStart>;
  /** Rend `null` si accepté, sinon le message d'erreur. */
  confirm: (code: string) => Promise<string | null>;
  onCancel?: () => void;
}) {
  const [data, setData] = useState<TotpStart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    start().then((d) => { if (!cancelled) setData(d); }).catch((e) => { if (!cancelled) setError((e as Error)?.message || 'Configuration impossible pour le moment.'); });
    return () => { cancelled = true; };
  }, [start]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const err = await confirm(code.replace(/\s+/g, ''));
    setBusy(false);
    if (err) setError(err);
  };

  // Secret groupé par 4 pour la saisie manuelle.
  const grouped = data?.secret.match(/.{1,4}/g)?.join(' ') ?? '';

  return (
    <form onSubmit={submit} className="space-y-4" data-testid="mfa-totp-setup">
      <ol className="list-decimal pl-5 space-y-1 text-sm text-[color:var(--text-muted)]">
        <li>Ouvrez votre application d’authentification (par exemple Google Authenticator, Microsoft Authenticator, 1Password ou Bitwarden).</li>
        <li>Scannez ce QR code, ou saisissez la clé ci-dessous.</li>
        <li>Saisissez le code à 6 chiffres affiché par l’application.</li>
      </ol>
      {!data && !error && <div className="flex justify-center py-6"><Loader2 className="w-6 h-6 animate-spin text-[color:var(--text-muted)]" /></div>}
      {data && (
        <>
          <div className="mx-auto w-48 h-48 rounded-lg bg-[color:var(--bg-card)] p-2 border border-[color:var(--border-subtle)] [&_svg]:w-full [&_svg]:h-full"
            role="img" aria-label="QR code de configuration de l’application d’authentification"
            dangerouslySetInnerHTML={{ __html: data.qrSvg }} />
          <div className="space-y-1">
            <Label>Clé de configuration</Label>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded border border-[color:var(--border-subtle)] px-2 py-1.5 text-sm select-all">{grouped}</code>
              <Button type="button" variant="outline" size="sm" aria-label="Copier la clé"
                onClick={async () => { try { await navigator.clipboard.writeText(data.secret); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* refusé */ } }}>
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              </Button>
            </div>
            <a href={data.otpauthUri} className="text-xs text-primary hover:underline">Ouvrir dans une application de cet appareil</a>
          </div>
          <div className="space-y-1">
            <Label htmlFor="mfa-totp-code">Code à 6 chiffres</Label>
            <Input id="mfa-totp-code" name="one-time-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7}
              value={code} onChange={(e) => setCode(e.target.value)} disabled={busy} autoFocus />
          </div>
        </>
      )}
      {error && <p className="text-sm text-[color:var(--danger)]" role="alert">{error}</p>}
      <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
        {onCancel && <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>Annuler</Button>}
        <Button type="submit" disabled={!data || busy || code.replace(/\s+/g, '').length !== 6}>
          {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}Activer
        </Button>
      </div>
    </form>
  );
}
