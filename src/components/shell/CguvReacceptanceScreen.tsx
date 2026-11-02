"use client"

/**
 * Réacceptation des CGUV — écran dédié (lot 102B).
 *
 * Une version SUBSTANTIELLE des CGUV est en vigueur et l'utilisateur ne l'a
 * pas encore acceptée : l'usage normal s'arrête jusqu'à son acceptation
 * explicite (case non pré-cochée + bouton). Restent possibles : lire le texte
 * (permalien PUBLIC de la version, site public = source unique), exporter ses
 * données (export RGPD existant), se déconnecter. Même composant sur
 * ordinateur, mobile et vue de l'application (WebView).
 *
 * Le serveur enregistre la version AFFICHÉE ici (§18) ; si une autre version
 * est entrée en vigueur entre-temps, il la renvoie et l'écran se met à jour.
 */
import { useState } from 'react';
import { ExternalLink, Loader2, LogOut, ScrollText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { LogoWithBaseline } from '@/components/Logo';
import { MyDataCard } from '@/app/(dashboard)/mon-compte/mes-donnees/MyDataCard';
import { CGUV_FULL_LABEL } from '@/lib/legal/public-legal';
import type { ReacceptanceState } from '@/lib/legal/reacceptance-gate';

const cadre = 'min-h-screen flex items-start md:items-center justify-center bg-[color:var(--bg-page)] p-4 md:p-6 pt-[max(16px,env(safe-area-inset-top))]';
const carte = 'w-full max-w-lg space-y-5 rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-5 md:p-6 shadow-relief-md';

function dateFr(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function CguvReacceptanceScreen({
  state,
  firstName,
  onAccepted,
  onLogout,
}: {
  state: ReacceptanceState;
  firstName?: string | null;
  onAccepted: (versionCode: string) => void;
  onLogout: () => void;
}) {
  const [shown, setShown] = useState<ReacceptanceState>(state);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showExport, setShowExport] = useState(false);

  const accepter = async () => {
    if (!checked || !shown.versionCode) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/me/legal/cguv/accept', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ versionCode: shown.versionCode }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.accepted) { onAccepted(shown.versionCode); return; }
      if (res.status === 409 && data?.current?.versionCode) {
        // Nouvelle version entrée en vigueur : on la présente, nouvelle case à cocher.
        setShown({ ...shown, versionCode: data.current.versionCode, permalinkUrl: data.current.permalinkUrl, changeSummary: null });
        setChecked(false);
      }
      setError(typeof data?.message === 'string' ? data.message : 'L’acceptation n’a pas pu être enregistrée. Réessayez.');
    } catch {
      setError('Connexion impossible. Vérifiez votre réseau puis réessayez.');
    }
    setBusy(false);
  };

  const effet = dateFr(shown.effectiveAt);

  return (
    <div className={cadre} data-testid="cguv-reacceptance-screen">
      <div className={carte}>
        <div className="flex justify-center"><LogoWithBaseline size={36} /></div>
        <div className="space-y-2 text-center">
          <ScrollText className="mx-auto h-8 w-8 text-[color:var(--accent)]" aria-hidden />
          <h1 className="vb-app-title">Les CGUV évoluent</h1>
          <p className="text-sm text-[color:var(--text-muted)]">
            {firstName ? `${firstName}, une` : 'Une'} nouvelle version des {CGUV_FULL_LABEL} (CGUV) est en vigueur
            {effet ? ` depuis le ${effet}` : ''}. Pour continuer à utiliser Verebona, lisez-la puis acceptez-la.
          </p>
        </div>

        {shown.changeSummary && (
          <div className="rounded-xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-page)] p-3 text-sm text-[color:var(--text-primary)]">
            <p className="font-semibold mb-1">Ce qui change</p>
            <p className="text-[color:var(--text-muted)] whitespace-pre-line">{shown.changeSummary}</p>
          </div>
        )}

        <Button variant="outline" className="w-full min-h-11" asChild>
          <a href={shown.permalinkUrl ?? '#'} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="mr-1.5 h-4 w-4" />
            Lire les CGUV{shown.versionCode ? ` (version ${shown.versionCode})` : ''}
          </a>
        </Button>

        <div className="flex items-start gap-3">
          <Checkbox id="cguv-reaccept" checked={checked} onCheckedChange={(v) => setChecked(v === true)} disabled={busy} className="mt-0.5" />
          <Label htmlFor="cguv-reaccept" className="text-sm leading-relaxed font-normal cursor-pointer">
            J’ai lu et j’accepte les CGUV{shown.versionCode ? ` (version ${shown.versionCode})` : ''}.
          </Label>
        </div>

        {error && <p className="text-sm text-[color:var(--danger)]" role="alert">{error}</p>}

        <Button className="w-full min-h-11" onClick={accepter} disabled={!checked || busy || !shown.versionCode}>
          {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          Accepter et continuer
        </Button>

        <div className="flex flex-col gap-2 border-t border-[color:var(--border-subtle)] pt-4 sm:flex-row sm:justify-between">
          <Button variant="ghost" size="sm" onClick={() => setShowExport((v) => !v)}>
            {showExport ? 'Masquer l’export de mes données' : 'Exporter mes données'}
          </Button>
          <Button variant="ghost" size="sm" onClick={onLogout}>
            <LogOut className="mr-1.5 h-4 w-4" />
            Se déconnecter
          </Button>
        </div>
        {showExport && <MyDataCard defaultOpen />}
      </div>
    </div>
  );
}
