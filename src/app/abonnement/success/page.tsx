'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Loader2, Sparkles, CheckCircle2, AlertCircle } from 'lucide-react';
import { ENTITLEMENTS_REFRESH_EVENT } from '@/hooks/useEntitlements';

/**
 * Retour de Stripe Checkout après paiement.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA PAGE APPLIQUE LE PAIEMENT, PUIS RECHARGE L'APPLICATION
 *
 * Trois défauts corrigés :
 *
 *   · « Activé » se décidait sur `plan_type !== 'STANDARD'`. Un compte en
 *     essai porte déjà l'offre choisie à l'inscription (souvent PREMIUM) :
 *     il était déclaré « activé » sans rien vérifier, et un abonnement
 *     Standard payé ne l'était jamais. Seul le statut ACTIVE (ou la
 *     synchronisation confirmée par le serveur) fait foi.
 *
 *   · La redirection finale restait dans l'application déjà chargée : les
 *     droits, la session et les bandeaux d'essai gardaient leur ancienne
 *     valeur. Le retour se fait maintenant par un rechargement complet.
 *
 *   · En cas d'échec, l'utilisateur n'avait ni explication ni moyen d'agir.
 * ══════════════════════════════════════════════════════════════════════════
 */

const PLAN_LABELS: Record<string, string> = {
  STANDARD: 'Standard',
  PREMIUM: 'Premium',
  PREMIUM_DUO: 'Premium Duo',
  PREMIUM_PRO: 'Premium Pro',
};

/** Attentes successives : ~40 s au total, le temps que Stripe confirme. */
const DELAIS_MS = [0, 2000, 2000, 3000, 3000, 5000, 5000, 5000, 5000, 5000, 5000];

type Etat = 'verification' | 'active' | 'en_attente';

interface BillingMe {
  plan_type?: string;
  subscription_status?: string;
  checkout_sync?: string;
  billing_period?: 'monthly' | 'yearly' | null;
  renewal_at?: string | null;
}

function AbonnementSuccessContent() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get('session_id');
  const [etat, setEtat] = useState<Etat>('verification');
  const [infos, setInfos] = useState<BillingMe | null>(null);
  const arrete = useRef(false);

  const allerALAccueil = useCallback(() => {
    // Rechargement complet : droits, session et bandeaux repartent à neuf.
    window.location.href = '/accueil';
  }, []);

  const verifier = useCallback(async (): Promise<boolean> => {
    const url = sessionId
      ? `/api/billing/me?session_id=${encodeURIComponent(sessionId)}`
      : '/api/billing/me';
    const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
    if (!res.ok) return false;
    const data = (await res.json()) as BillingMe;
    const statut = data.subscription_status?.toUpperCase();
    return data.checkout_sync === 'synced' || statut === 'ACTIVE'
      ? (setInfos(data), true)
      : false;
  }, [sessionId]);

  const lancer = useCallback(async () => {
    arrete.current = false;
    setEtat('verification');
    for (const delai of DELAIS_MS) {
      if (arrete.current) return;
      if (delai) await new Promise((r) => setTimeout(r, delai));
      try {
        if (await verifier()) {
          try { localStorage.removeItem('pending_checkout_plan'); } catch { /* sans effet */ }
          // Jeton de session réémis avec la nouvelle offre.
          await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' }).catch(() => null);
          window.dispatchEvent(new Event(ENTITLEMENTS_REFRESH_EVENT));
          setEtat('active');
          setTimeout(allerALAccueil, 2000);
          return;
        }
      } catch {
        /* réseau : on réessaie */
      }
    }
    setEtat('en_attente');
  }, [verifier, allerALAccueil]);

  useEffect(() => {
    void lancer();
    return () => { arrete.current = true; };
  }, [lancer]);

  const plan = PLAN_LABELS[infos?.plan_type?.toUpperCase() ?? ''] ?? '';
  const periodicite = infos?.billing_period === 'monthly' ? 'mensuel' : infos?.billing_period === 'yearly' ? 'annuel' : null;
  const renouvellement = infos?.renewal_at
    ? new Date(infos.renewal_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })
    : null;

  return (
    <div className="min-h-screen flex items-center justify-center bg-[color:var(--bg-page)] p-4">
      <div className="w-full max-w-md space-y-4 text-center">
        {etat === 'verification' && (
          <div className="space-y-4">
            <Loader2 className="w-12 h-12 text-blue-400 animate-spin mx-auto" />
            <p className="text-[color:var(--text-primary)] font-medium">Paiement reçu</p>
            <p className="text-[color:var(--text-muted)] text-sm">Activation de votre abonnement…</p>
          </div>
        )}

        {etat === 'active' && (
          <div className="space-y-4 animate-in fade-in duration-300">
            <CheckCircle2 className="w-14 h-14 text-green-400 mx-auto" />
            <p className="text-lg font-semibold text-[color:var(--text-primary)] flex items-center justify-center gap-2">
              <Sparkles className="w-5 h-5 text-blue-400" />
              Abonnement {plan} activé
            </p>
            {(periodicite || renouvellement) && (
              <p className="text-sm text-[color:var(--text-muted)]">
                {periodicite && <>Formule {periodicite}</>}
                {periodicite && renouvellement && ' · '}
                {renouvellement && <>renouvellement le {renouvellement}</>}
              </p>
            )}
            <p className="text-sm text-[color:var(--text-muted)]">Retour à l&apos;application…</p>
            <Button onClick={allerALAccueil} className="w-full">Accéder à Verebona</Button>
          </div>
        )}

        {etat === 'en_attente' && (
          <div className="space-y-4">
            <div className="w-full bg-amber-950/50 border border-amber-500/30 rounded-lg px-4 py-3 flex items-start gap-3 text-left">
              <AlertCircle className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
              <p className="text-sm text-[color:var(--text-warning-soft)]">
                Votre paiement est bien enregistré par notre prestataire, mais l&apos;activation
                prend plus de temps que prévu. Elle se fera automatiquement : vous pouvez
                continuer, ou réessayer dans un instant.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Button onClick={() => void lancer()} className="w-full">Réessayer</Button>
              <Button variant="outline" onClick={allerALAccueil} className="w-full">
                Continuer vers l&apos;application
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function AbonnementSuccessPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-10 h-10 animate-spin text-blue-400" />
      </div>
    }>
      <AbonnementSuccessContent />
    </Suspense>
  );
}
