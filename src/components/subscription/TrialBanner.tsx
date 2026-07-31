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
    /** L'adresse a déjà consommé son essai (§3.4) — pas une panne. */
    dejaConsomme?: boolean;
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

  // ══════════════════════════════════════════════════════════════════════
  // « TERMINÉ » ET « JAMAIS COMMENCÉ » NE SONT PAS LA MÊME CHOSE
  //
  // Ce bandeau annonçait « Votre essai gratuit est terminé » dès que
  // `isRestricted` valait vrai — y compris sur un compte créé la minute
  // précédente, dont l'essai n'avait pas pu être attribué.
  //
  // Le message était alors FAUX et alarmant : l'utilisateur venait de
  // s'inscrire pour un essai de sept jours et apprenait qu'il était fini.
  //
  // `isRestricted` couvre trois situations distinctes :
  //   · essai expiré sans souscription — le message d'origine convient ;
  //   · abonnement suspendu ou résilié — autre message ;
  //   · AUCUN abonnement, donc aucun essai jamais ouvert — le cas d'un
  //     compte neuf dont l'attribution a échoué.
  //
  // Le troisième ne doit pas emprunter le vocabulaire du premier.
  // ══════════════════════════════════════════════════════════════════════

  // Essai déjà consommé par cette adresse (§3.4). Ce n'est pas une panne :
  // recréer un compte ne redonne pas un essai, et le dire évite de laisser
  // croire à un incident.
  if (trial.status === 'none' && trial.dejaConsomme && isRestricted) {
    return (
      <div className="flex flex-wrap items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-3">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" aria-hidden />
        <p className="flex-1 text-sm text-[color:var(--text-primary)]">
          <span className="font-medium">
            L&apos;essai gratuit a déjà été utilisé avec cette adresse.
          </span>{' '}
          <span className="text-[color:var(--text-muted)]">
            Il est réservé à une première inscription. Choisissez une offre pour
            continuer.
          </span>
        </p>
        <Button size="sm" onClick={() => router.push('/mon-compte/offres')}>
          Voir les offres
        </Button>
      </div>
    );
  }

  // Essai jamais ouvert sans trace d'usage : anomalie d'attribution.
  if (trial.status === 'none' && isRestricted) {
    return (
      <div className="flex flex-wrap items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-3">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
        <p className="flex-1 text-sm text-[color:var(--text-primary)]">
          <span className="font-medium">Votre essai gratuit n&apos;a pas pu être activé.</span>{' '}
          <span className="text-[color:var(--text-muted)]">
            Vos données sont conservées. Contactez-nous ou choisissez une offre pour
            continuer.
          </span>
        </p>
        <Button size="sm" onClick={() => router.push('/mon-compte/offres')}>
          Voir les offres
        </Button>
      </div>
    );
  }

  // Essai expiré sans souscription → mode restreint
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
