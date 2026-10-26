"use client";

/**
 * Sélecteur d'espace — lot 72D (ticket P0 « Premium Duo — compte partagé »,
 * décisions PO Q6 et Q7).
 *
 * Un utilisateur peut appartenir à plusieurs comptes (son espace personnel et
 * un Premium Duo, par exemple). Le sélecteur n'apparaît qu'à partir de DEUX
 * espaces ; il liste les espaces actifs (nom non modifiable, rôle « Titulaire »
 * / « Membre » dans le libellé d'offre). Choisir un espace demande au serveur
 * de rouvrir la session sur ce compte (`POST /api/auth/switch-account`,
 * adhésion vérifiée côté serveur), puis recharge l'application : identité,
 * offre, droits et caches repartent de ce compte. Le dernier espace choisi
 * est rouvert à la connexion suivante.
 *
 * MÊME composant sur ordinateur (menu de l'avatar, `variant="menu"`) et sur
 * mobile (panneau du compte, `variant="panel"`) — l'application mobile est la
 * même WebView : aucun code natif.
 */
import { useEffect, useState } from 'react';
import { Check, Loader2, Repeat } from 'lucide-react';
import { DropdownMenuItem, DropdownMenuLabel } from '@/components/ui/dropdown-menu';

interface UserSpace {
  id: number;
  name: string;
  role: 'owner' | 'admin' | 'member';
  plan: string;
  current: boolean;
}

/** Ouvre la session sur `accountId` (serveur seul juge), puis recharge sur l'accueil. */
export async function switchToAccount(accountId: number, target = '/accueil'): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await fetch('/api/auth/switch-account', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, message: (data as { message?: string }).message ?? 'Cet espace n’est pas accessible.' };
    }
    window.location.assign(target);
    return { ok: true };
  } catch {
    return { ok: false, message: 'Connexion impossible. Réessayez.' };
  }
}

function useUserSpaces(enabled: boolean) {
  const [spaces, setSpaces] = useState<UserSpace[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let annule = false;
    fetch('/api/accounts', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { accounts?: UserSpace[] } | null) => { if (!annule) setSpaces(d?.accounts ?? []); })
      .catch(() => { if (!annule) setSpaces([]); });
    return () => { annule = true; };
  }, [enabled]);
  return spaces;
}

export function AccountSwitcher({ accountsCount, variant, onBeforeSwitch }: {
  /** Nombre d'espaces servi par `/api/users/me` : rien à choisir en dessous de 2. */
  accountsCount: number | null | undefined;
  variant: 'menu' | 'panel';
  onBeforeSwitch?: () => void;
}) {
  const visible = (accountsCount ?? 1) >= 2;
  const spaces = useUserSpaces(visible);
  const [pending, setPending] = useState<number | null>(null);
  const [error, setError] = useState('');
  if (!visible || !spaces || spaces.length < 2) return null;

  const choisir = async (s: UserSpace) => {
    if (s.current || pending) return;
    setError('');
    setPending(s.id);
    onBeforeSwitch?.();
    const r = await switchToAccount(s.id);
    if (!r.ok) {
      setPending(null);
      setError(r.message ?? '');
    }
  };

  const ligne = (s: UserSpace) => (
    <>
      {pending === s.id
        ? <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin" aria-hidden />
        : s.current
          ? <Check className="h-4 w-4 flex-shrink-0 text-[color:var(--accent)]" aria-hidden />
          : <Repeat className="h-4 w-4 flex-shrink-0 text-[color:var(--text-muted)]" aria-hidden />}
      <span className="min-w-0 flex-1 text-left">
        <span className={`block truncate text-sm ${s.current ? 'font-semibold text-[color:var(--accent)]' : 'font-medium text-[color:var(--text-primary)]'}`}>{s.name}</span>
        <span className="block truncate text-xs text-[color:var(--text-muted)]">{s.plan}</span>
      </span>
    </>
  );

  if (variant === 'menu') {
    return (
      <div data-testid="account-switcher" role="group" aria-label="Changer d’espace">
        <DropdownMenuLabel className="vb-app-label">Espace</DropdownMenuLabel>
        {spaces.map((s) => (
          <DropdownMenuItem
            key={s.id}
            onSelect={(e) => { if (s.current) e.preventDefault(); void choisir(s); }}
            aria-current={s.current ? 'true' : undefined}
            className="flex cursor-pointer items-center gap-2"
          >
            {ligne(s)}
          </DropdownMenuItem>
        ))}
        {error && <p role="alert" className="px-2 pb-1 text-xs text-destructive">{error}</p>}
      </div>
    );
  }

  return (
    <div data-testid="account-switcher" className="mx-4 mt-3 space-y-1" role="group" aria-label="Changer d’espace">
      <p className="vb-app-label px-1">Espace</p>
      {spaces.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => void choisir(s)}
          aria-current={s.current ? 'true' : undefined}
          disabled={!!pending}
          className={`flex min-h-12 w-full items-center gap-3 rounded-[12px] border px-3 transition-colors duration-[180ms] hover:bg-[color:var(--accent-soft)] ${s.current ? 'border-[color:var(--accent)] bg-[color:var(--accent-soft)]' : 'border-[color:var(--border)] bg-[color:var(--bg-card)]'}`}
        >
          {ligne(s)}
        </button>
      ))}
      {error && <p role="alert" className="px-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}
