'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Check, Users, Zap, Crown, Gift } from 'lucide-react';

export function PricingSection() {
  const [ref, setRef] = useState<string | null>(null);

  useEffect(() => {
    // Lire depuis l'URL (?ref=CODE) ou depuis le cookie
    const params = new URLSearchParams(window.location.search);
    const refFromUrl = params.get('ref');
    const refFromCookie = document.cookie
      .split('; ')
      .find((r) => r.startsWith('referral_code='))
      ?.split('=')?.[1] ?? null;
    const code = refFromUrl || refFromCookie;
    if (code) setRef(code.toUpperCase());
  }, []);

  const signupUrl = (plan?: string) => {
    const base = plan ? `/signup?plan=${plan}` : '/signup';
    return ref ? `${base}${plan ? '&' : '?'}ref=${ref}` : base;
  };

  return (
    <section id="pricing" className="py-12 md:py-16">
      <div className="container mx-auto px-4 md:px-6 max-w-6xl">
        <div className="mb-6">
          <div className="text-xs uppercase tracking-wider text-[color:var(--text-muted)] mb-2">
            Tarifs
          </div>
          <h2 className="text-3xl font-semibold text-[color:var(--text-primary)] mb-3">
            Verebona automatise l'organisation de votre patrimoine.
          </h2>
          <p className="text-[color:var(--text-muted)] max-w-2xl">
            Ajoutez vos documents. Verebona les analyse, les classe, complète vos informations et fait remonter vos échéances importantes. Choisissez l'offre adaptée à vos besoins, seul ou à deux.
          </p>
        </div>

        {/* Bandeau essai — adapté selon parrainage */}
        {ref ? (
          <div className="flex items-center gap-3 mb-4 px-4 py-3 rounded-xl bg-blue-950/40 border border-blue-500/30">
            <Gift className="w-5 h-5 text-blue-400 flex-shrink-0" />
            <span className="text-sm text-blue-200">
              Code parrainage <span className="font-mono font-semibold">{ref}</span> appliqué —{' '}
              <strong className="text-white">3 mois offerts</strong> au lieu de 2 sur toutes les offres.
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2 mb-2 px-1">
            <span className="text-sm text-[color:var(--text-muted)]">
              <strong className="text-[color:var(--text-primary)]">2 mois offerts</strong> sur toutes les offres — aucun paiement aujourd'hui, carte bancaire requise.
            </span>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 max-w-7xl">
          {/* Standard */}
          <Card className="border border-[rgba(31,41,55,0.95)] bg-[rgba(15,23,42,0.9)] rounded-2xl flex flex-col h-full">
            <CardContent className="p-5 flex flex-col flex-1">
              <div className="flex items-center gap-2 mb-1">
                <Zap className="w-5 h-5 text-slate-400" />
                <h3 className="text-lg font-medium">Standard</h3>
              </div>
              <p className="text-sm text-[color:var(--text-muted)] mb-3">
                Pour découvrir Verebona et centraliser vos premiers biens et documents.
              </p>
              <div className="text-3xl font-semibold mb-1 h-12 flex items-start">
                19 €<span className="text-base font-normal text-[color:var(--text-muted)]"> / an</span>
              </div>
              <Link href={signupUrl()} className="block mb-3">
                <Button variant="outline" className="w-full">
                  Choisir Standard
                </Button>
              </Link>
              <ul className="space-y-2 text-sm text-[color:var(--text-muted)]">
                <li className="flex items-start gap-2"><Check className="w-3 h-3 text-slate-400 mt-1" /><span>Jusqu'à 2 biens actifs</span></li>
                <li className="flex items-start gap-2"><Check className="w-3 h-3 text-slate-400 mt-1" /><span>Analyse automatique de 50 documents par an</span></li>
                <li className="flex items-start gap-2"><Check className="w-3 h-3 text-slate-400 mt-1" /><span>Recherche intelligente</span></li>
                <li className="flex items-start gap-2"><Check className="w-3 h-3 text-slate-400 mt-1" /><span>Agenda de mes biens</span></li>
                <li className="flex items-start gap-2"><Check className="w-3 h-3 text-slate-400 mt-1" /><span>Accès desktop et mobile</span></li>
                <li className="flex items-start gap-2"><Check className="w-3 h-3 text-slate-400 mt-1" /><span>Export ZIP de mes documents</span></li>
              </ul>
            </CardContent>
          </Card>

          {/* Premium */}
          <Card className="border border-[rgba(59,130,246,0.7)] bg-gradient-radial from-[rgba(59,130,246,0.25)] to-[rgba(15,23,42,0.98)] rounded-2xl shadow-[0_18px_40px_rgba(15,23,42,0.6)] relative flex flex-col h-full">
            <div className="absolute top-3 right-3 text-xs px-3 py-1 rounded-full bg-[rgba(15,23,42,0.95)] border border-[rgba(96,165,250,0.9)] text-[#bfdbfe]">
              Recommandé
            </div>
            <CardContent className="p-5 flex flex-col flex-1">
              <div className="flex items-center gap-2 mb-1">
                <Crown className="w-5 h-5 text-blue-400" />
                <h3 className="text-lg font-medium">Premium</h3>
              </div>
              <p className="text-sm text-[color:var(--text-muted)] mb-3">
                Pour ceux qui veulent des dossiers impeccables à présenter à un acheteur ou assureur.
              </p>
              <div className="text-3xl font-semibold mb-1 h-12 flex items-start">
                59 €<span className="text-base font-normal text-[color:var(--text-muted)]"> / an</span>
              </div>
              <Link href={signupUrl('premium')} className="block mb-3">
                <Button className="w-full rounded-full bg-gradient-to-br from-[#3b82f6] to-[#1d4ed8] hover:shadow-[0_18px_40px_rgba(37,99,235,0.45)] transition-all hover:translate-y-[-1px]">
                  Choisir Premium
                </Button>
              </Link>
              <ul className="space-y-2 text-sm text-[color:var(--text-muted)]">
                <li className="flex items-start gap-2"><Check className="w-3 h-3 text-[#3b82f6] mt-1" /><span><strong>Tout Standard +</strong></span></li>
                <li className="flex items-start gap-2"><Check className="w-3 h-3 text-[#3b82f6] mt-1" /><span>10 biens actifs</span></li>
                <li className="flex items-start gap-2"><Check className="w-3 h-3 text-[#3b82f6] mt-1" /><span>200 documents analysés par an</span></li>
                <li className="flex items-start gap-2"><Check className="w-3 h-3 text-[#3b82f6] mt-1" /><span>Synchronisation avec votre agenda personnel</span></li>
                <li className="flex items-start gap-2"><Check className="w-3 h-3 text-[#3b82f6] mt-1" /><span>Exports documentaires prêts à utiliser</span></li>
                <li className="flex items-start gap-2"><Check className="w-3 h-3 text-[#3b82f6] mt-1" /><span>Support prioritaire</span></li>
              </ul>
            </CardContent>
          </Card>

          {/* Duo */}
          <Card className="border border-[rgba(52,211,153,0.4)] bg-gradient-radial from-[rgba(52,211,153,0.12)] to-[rgba(15,23,42,0.98)] rounded-2xl relative flex flex-col h-full">
            <div className="absolute top-3 right-3 text-xs px-3 py-1 rounded-full bg-[rgba(15,23,42,0.95)] border border-[rgba(52,211,153,0.6)] text-[#6ee7b7] flex items-center gap-1">
              <Users className="w-3 h-3" />Nouveau
            </div>
            <CardContent className="p-5 flex flex-col flex-1">
              <div className="flex items-center gap-2 mb-1">
                <Users className="w-5 h-5 text-emerald-400" />
                <h3 className="text-lg font-medium">Premium Duo</h3>
              </div>
              <p className="text-sm text-[color:var(--text-muted)] mb-3">
                Partagez un espace Verebona à deux pour gérer ensemble vos biens, documents et échéances.
              </p>
              <div className="text-3xl font-semibold mb-1 h-12 flex items-start">
                79 €<span className="text-base font-normal text-[color:var(--text-muted)]"> / an</span>
              </div>
              <Link href={signupUrl('premium_duo')} className="block mb-3">
                <Button className="w-full rounded-full bg-gradient-to-br from-[#34d399] to-[#059669] border-emerald-500 hover:shadow-[0_18px_40px_rgba(52,211,153,0.35)] transition-all hover:translate-y-[-1px]">
                  Choisir Premium Duo
                </Button>
              </Link>
              <ul className="space-y-2 text-sm text-[color:var(--text-muted)]">
                <li className="flex items-start gap-2"><Check className="w-3 h-3 text-emerald-400 mt-1" /><span><strong>Tout Premium +</strong></span></li>
                <li className="flex items-start gap-2"><Check className="w-3 h-3 text-emerald-400 mt-1" /><span>2 membres sur un même compte</span></li>
                <li className="flex items-start gap-2"><Check className="w-3 h-3 text-emerald-400 mt-1" /><span>Espace commun : biens, documents, échéances</span></li>
                <li className="flex items-start gap-2"><Check className="w-3 h-3 text-emerald-400 mt-1" /><span>Gestion collaborative</span></li>
              </ul>
            </CardContent>
          </Card>

          {/* Premium Pro — bientôt */}
          <Card className="border border-[rgba(31,41,55,0.6)] bg-[rgba(15,23,42,0.6)] rounded-2xl flex flex-col h-full opacity-60">
            <CardContent className="p-5 flex flex-col flex-1">
              <div className="flex items-center gap-2 mb-1">
                <Crown className="w-5 h-5 text-purple-400" />
                <h3 className="text-lg font-medium">Premium Pro</h3>
              </div>
              <p className="text-sm text-[color:var(--text-muted)] mb-3">
                Pour les professionnels gérant plusieurs portefeuilles.
              </p>
              <div className="text-3xl font-semibold mb-1 h-12 flex items-start text-[color:var(--text-muted)]">
                Bientôt
              </div>
              <Button variant="outline" className="w-full mb-3" disabled>
                Bientôt disponible
              </Button>
              <ul className="space-y-2 text-sm text-[color:var(--text-muted)]">
                <li className="flex items-start gap-2"><Check className="w-3 h-3 text-purple-400/50 mt-1" /><span>Tout Premium +</span></li>
                <li className="flex items-start gap-2"><Check className="w-3 h-3 text-purple-400/50 mt-1" /><span>Gestion matériel professionnel</span></li>
                <li className="flex items-start gap-2"><Check className="w-3 h-3 text-purple-400/50 mt-1" /><span>Plusieurs utilisateurs avec rôles</span></li>
                <li className="flex items-start gap-2"><Check className="w-3 h-3 text-purple-400/50 mt-1" /><span>API et intégrations avancées</span></li>
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}
