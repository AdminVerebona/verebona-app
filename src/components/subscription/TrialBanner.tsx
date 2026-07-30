'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Clock, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Bandeau d'essai (CDC §9.2).
 *
 *  - essai actif   : « Essai Premium — X jours restants » + acces aux offres ;
 *  - J-2 / J-1     : bandeau plus visible (ton d'alerte) ;
 *  - essai expire  : message de fin d'essai et invitation a choisir une offre.
 *
 * Toutes les valeurs viennent du serveur (/api/billing/trial-status) :
 * le composant n'effectue aucun calcul de droits.
 */

interface TrialStatus {
  trial: {
    status: 'none' | 'active' | 'expired' | 'converted';
    daysRemaining: number;
    endsAt: string | null;
    isUrgent: boolean;
  };
  isRestricted: boolean;
}

export function TrialBanner() {
  const router = useRouter();
  const [data, setData] = useState<TrialStatus | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch('/api/billing/trial-status', {
      credentials: 'include',
        });
        if (!res.ok) return;
        const json = (await res.json()) as TrialStatus;
        if (!cancelled) setData(json);
      } catch {
        // silencieux : le bandeau ne doit jamais casser la page
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!data) return null;

  const { trial, isRestricted } = data;

  // Essai expire sans souscription → mode restreint
  if (trial.status === 'expired' || isRestricted) {
    return (
      <div className="flex flex-wrap items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-3">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
        <p className="flex-1 text-sm text-[color:var(--text-primary)]">
          <span className="font-medium">Votre essai gratuit est terminé.</span>{' '}
          <span className="text-[color:var(--text-muted)]">
            Aucun prélèvement n&apos;a été effectué et vos données sont conservées.
          </span>
        </p>
        <Button size="sm" onClick={() => router.push('/abonnement/essai-termine')}>
          Choisir mon abonnement
        </Button>
      </div>
    );
  }

  // Essai en cours
  if (trial.status === 'active') {
    const urgent = trial.isUrgent;
    const jours = trial.daysRemaining > 1 ? 'jours restants' : 'jour restant';

    return (
      <div
        className={
          urgent
            ? 'flex flex-wrap items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-3'
            : 'flex flex-wrap items-center gap-3 border-b border-[color:var(--border)] bg-[color:var(--bg-subtle)] px-4 py-2.5'
        }
      >
        <Clock className={urgent ? 'h-4 w-4 shrink-0 text-amber-500' : 'h-4 w-4 shrink-0 text-[color:var(--text-muted)]'} />
        <p className="flex-1 text-sm text-[color:var(--text-primary)]">
          <span className="font-medium">
            Essai Premium — {trial.daysRemaining} {jours}
          </span>
          {urgent && (
            <span className="text-[color:var(--text-muted)]">
              {' '}
              · choisissez une offre pour ne pas perdre l&apos;accès.
            </span>
          )}
        </p>
        <Button
          size="sm"
          variant={urgent ? 'default' : 'outline'}
          onClick={() => router.push('/mon-compte/offres')}
        >
          {urgent ? 'Choisir mon abonnement' : 'Voir les offres'}
        </Button>
      </div>
    );
  }

  // Aucun essai en cours (abonne, ou essai deja converti) → pas de bandeau
  return null;
}
