'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ShieldCheck, Database, CreditCard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client';
import { toast } from 'sonner';

/**
 * Ecran de fin d'essai (CDC tarification §9.3).
 *
 * Affiche a l'utilisateur dont l'essai a expire sans souscription :
 *   - la confirmation qu'aucun prelevement n'a ete effectue ;
 *   - les trois offres, avec choix de la periodicite ;
 *   - le rappel que ses donnees sont conservees.
 */

type BillingPeriod = 'monthly' | 'yearly';

interface Offer {
  code: 'standard' | 'premium' | 'premium_duo';
  name: string;
  tagline: string;
  monthly: string;
  yearly: string;
  featured?: boolean;
  features: string[];
}

const OFFERS: Offer[] = [
  {
    code: 'standard',
    name: 'Standard',
    tagline: "L'essentiel pour organiser vos biens et vos documents.",
    monthly: '2,90 €',
    yearly: '29 €',
    features: [
      '2 biens · 30 documents',
      '1 utilisateur',
      'Analyse et organisation automatiques',
      'Échéances et incohérences détectées',
      'Agenda Verebona',
      'Export ZIP complet et transmission',
    ],
  },
  {
    code: 'premium',
    name: 'Premium',
    tagline: 'Toute la puissance de Verebona.',
    monthly: '5,90 €',
    yearly: '59 €',
    featured: true,
    features: [
      'Tout Standard, avec en plus :',
      '10 biens · 150 documents',
      'Posez vos questions à Verebona',
      'Synchronisation avec votre agenda personnel',
      'Dossiers prêts à utiliser',
    ],
  },
  {
    code: 'premium_duo',
    name: 'Premium Duo',
    tagline: 'Toute la puissance de Verebona, à deux.',
    monthly: '8,90 €',
    yearly: '89 €',
    features: [
      'Tout Premium, avec en plus :',
      '15 biens · 225 documents',
      '2 utilisateurs',
      'Compte entièrement partagé',
    ],
  },
];

export default function EssaiTerminePage() {
  const router = useRouter();
  const [period, setPeriod] = useState<BillingPeriod>('yearly');
  const [loading, setLoading] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  // Si l'essai est encore actif ou le compte deja abonne, cette page n'a pas
  // lieu d'etre : on renvoie vers l'application.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/billing/trial-status', { credentials: 'include' });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && !data.isRestricted) router.replace('/accueil');
      } catch {
        // En cas d'echec, on laisse la page s'afficher.
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const subscribe = async (code: Offer['code']) => {
    setLoading(code);
    try {
      const data = await apiClient.post<{ checkout_url?: string; message?: string }>(
        '/api/billing/create-checkout-session',
        { plan: code, billing_period: period, entry_point: 'trial_ended_screen' },
      );
      if (data.checkout_url) window.location.href = data.checkout_url;
      else toast.error(data.message || 'Impossible de démarrer le paiement.');
    } catch {
      toast.error('Une erreur est survenue.');
    } finally {
      setLoading(null);
    }
  };

  if (checking) return null;

  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      {/* En-tête rassurant */}
      <div className="mb-8 text-center">
        <h1 className="mb-3 text-2xl font-semibold text-[color:var(--text-primary)]">
          Votre essai gratuit est terminé
        </h1>
        <p className="mx-auto max-w-2xl text-[color:var(--text-muted)]">
          Choisissez l&apos;offre qui vous convient pour reprendre l&apos;ajout et la modification
          de vos biens et documents.
        </p>
      </div>

      {/* Les trois garanties (CDC §9.3) */}
      <div className="mb-8 grid gap-3 sm:grid-cols-3">
        <div className="flex items-start gap-2.5 rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-subtle)] p-3">
          <CreditCard className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--text-muted)]" />
          <p className="text-sm text-[color:var(--text-primary)]">
            <span className="font-medium">Aucun prélèvement</span> n&apos;a été effectué.
          </p>
        </div>
        <div className="flex items-start gap-2.5 rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-subtle)] p-3">
          <Database className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--text-muted)]" />
          <p className="text-sm text-[color:var(--text-primary)]">
            <span className="font-medium">Vos données sont conservées</span> et restent consultables.
          </p>
        </div>
        <div className="flex items-start gap-2.5 rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-subtle)] p-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--text-muted)]" />
          <p className="text-sm text-[color:var(--text-primary)]">
            <span className="font-medium">Sans engagement</span>, résiliable à tout moment.
          </p>
        </div>
      </div>

      {/* Choix de la périodicité */}
      <div className="mb-6 flex flex-wrap items-center justify-center gap-3">
        <div
          role="group"
          aria-label="Périodicité de facturation"
          className="inline-flex gap-1 rounded-full border border-[color:var(--border)] bg-[color:var(--bg-subtle)] p-1"
        >
          <button
            type="button"
            onClick={() => setPeriod('monthly')}
            className={
              period === 'monthly'
                ? 'rounded-full bg-[color:var(--bg-page)] px-4 py-1.5 text-sm font-medium text-[color:var(--text-primary)] shadow-sm'
                : 'rounded-full px-4 py-1.5 text-sm font-medium text-[color:var(--text-muted)]'
            }
          >
            Mensuel
          </button>
          <button
            type="button"
            onClick={() => setPeriod('yearly')}
            className={
              period === 'yearly'
                ? 'rounded-full bg-[color:var(--bg-page)] px-4 py-1.5 text-sm font-medium text-[color:var(--text-primary)] shadow-sm'
                : 'rounded-full px-4 py-1.5 text-sm font-medium text-[color:var(--text-muted)]'
            }
          >
            Annuel
          </button>
        </div>
        {period === 'yearly' && (
          <span className="text-sm text-[color:var(--text-muted)]">
            En annuel, vous économisez l&apos;équivalent de 2 mois.
          </span>
        )}
      </div>

      {/* Les trois offres */}
      <div className="grid gap-4 md:grid-cols-3">
        {OFFERS.map((offer) => (
          <div
            key={offer.code}
            className={
              offer.featured
                ? 'flex flex-col rounded-xl border-2 border-[color:var(--accent)] bg-[color:var(--bg-page)] p-5'
                : 'flex flex-col rounded-xl border border-[color:var(--border)] bg-[color:var(--bg-page)] p-5'
            }
          >
            {offer.featured && (
              <span className="mb-2 self-start rounded-full bg-[color:var(--accent)]/10 px-2.5 py-0.5 text-xs font-medium text-[color:var(--accent)]">
                Recommandé
              </span>
            )}
            <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">{offer.name}</h2>
            <p className="mb-3 min-h-[2.5rem] text-sm text-[color:var(--text-muted)]">{offer.tagline}</p>

            <p className="mb-4">
              <span className="text-2xl font-bold text-[color:var(--text-primary)]">
                {period === 'yearly' ? offer.yearly : offer.monthly}
              </span>
              <span className="ml-1 text-sm text-[color:var(--text-muted)]">
                {period === 'yearly' ? 'par an' : 'par mois'}
              </span>
            </p>

            <ul className="mb-5 flex-1 space-y-1.5">
              {offer.features.map((f) => (
                <li key={f} className="flex gap-2 text-sm text-[color:var(--text-muted)]">
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[color:var(--accent)]" />
                  {f}
                </li>
              ))}
            </ul>

            <Button
              className="w-full"
              variant={offer.featured ? 'default' : 'outline'}
              onClick={() => subscribe(offer.code)}
              disabled={loading !== null}
            >
              {loading === offer.code ? 'Redirection…' : `Choisir ${offer.name}`}
            </Button>
          </div>
        ))}
      </div>

      <p className="mt-6 text-center text-sm text-[color:var(--text-muted)]">
        Vous pouvez aussi{' '}
        <button
          type="button"
          onClick={() => router.push('/mon-compte/informations')}
          className="underline underline-offset-2 hover:text-[color:var(--text-primary)]"
        >
          consulter votre compte et exporter vos données
        </button>
        .
      </p>
    </div>
  );
}
