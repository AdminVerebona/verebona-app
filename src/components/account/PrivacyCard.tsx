'use client';

/**
 * Mon compte — carte « Confidentialité » (lot 102D) : opposition à
 * l'utilisation des données du compte pour l'amélioration de Verebona.
 *
 * Même écran dans le navigateur et dans l'application mobile (vue Web de
 * l'app) ; le canal est enregistré dans la preuve (`web` / `mobile`).
 * Libellés factuels issus de `improvement-opt-out-rules.ts` ; le texte
 * juridique est sur la page publique « Confidentialité ».
 */
import { useCallback, useEffect, useState } from 'react';
import { Lock, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { Switch } from '@/components/ui/switch';
import { apiClient, ApiClientError } from '@/lib/api-client';
import { isNativeApp } from '@/lib/native/bridge';
import { IMPROVEMENT_OPT_OUT_TEXT as T } from '@/services/privacy/improvement-opt-out-rules';
import { useLegalLinks } from '@/hooks/useLegalLinks';

interface DataUseState {
  preference: { optOut: boolean; optedOutAt: string | null; withdrawnAt: string | null };
  canWithdraw: boolean;
}

function parisDate(iso: string): string {
  return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'long' }).format(new Date(iso));
}

export function PrivacyCard() {
  const legalLinks = useLegalLinks();
  const [state, setState] = useState<DataUseState | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      setState(await apiClient.get<DataUseState>('/api/users/me/data-use'));
    } catch {
      setLoadError(true);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const change = async (optOut: boolean) => {
    if (saving) return;
    setSaving(true);
    try {
      await apiClient.put('/api/users/me/data-use', { optOut, channel: isNativeApp() ? 'mobile' : 'web' });
      toast.success(optOut ? 'Opposition enregistrée.' : 'Opposition retirée.');
      await load();
    } catch (e) {
      toast.error((e instanceof ApiClientError && e.serverMessage) || 'Le réglage n’a pas pu être enregistré. Réessayez.');
    } finally {
      setSaving(false);
    }
  };

  const optOut = state?.preference.optOut ?? false;
  const locked = optOut && state ? !state.canWithdraw : false;

  return (
    <CollapsibleCard
      icon={<Lock className="w-5 h-5" />}
      title="Confidentialité"
      description={T.title}
    >
      <div className="space-y-3" data-testid="privacy-card">
        <p className="text-sm text-muted-foreground">{T.description}</p>
        {loadError ? (
          <p className="text-sm text-[color:var(--text-danger)]">
            Impossible de lire ce réglage.{' '}
            <button type="button" className="underline" onClick={() => load()}>Réessayer</button>
          </p>
        ) : !state ? (
          <p className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Chargement…</p>
        ) : (
          <>
            <div className="flex items-start justify-between gap-3 rounded-lg border border-[color:var(--border-subtle)] p-3">
              <label htmlFor="improvement-opt-out" className="text-sm font-medium leading-snug cursor-pointer">{T.switchLabel}</label>
              <Switch
                id="improvement-opt-out"
                checked={optOut}
                disabled={saving || locked}
                onCheckedChange={(v) => void change(v === true)}
                aria-describedby="improvement-opt-out-effect"
              />
            </div>
            {optOut && state.preference.optedOutAt && (
              <p className="text-xs text-muted-foreground">{T.optedOutSince(parisDate(state.preference.optedOutAt))}</p>
            )}
            {locked && <p className="text-xs text-muted-foreground">{T.memberCannotWithdraw}</p>}
            <p id="improvement-opt-out-effect" className="text-xs text-muted-foreground">{T.effect}</p>
          </>
        )}
        <a href={legalLinks.confidentialite} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">
          {T.privacyLinkLabel}
        </a>
      </div>
    </CollapsibleCard>
  );
}
