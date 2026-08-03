"use client"

import { useState } from 'react';
import { Check, Clock } from 'lucide-react';
import { toast } from 'sonner';

interface PlansSectionProps {
  /** Plan courant normalisé : STANDARD | PREMIUM | PREMIUM_DUO (ou null en essai). */
  currentPlan: string | null;
  /** Lance le checkout Stripe — brancher sur l'API billing existante. */
  onChoose?: (planCode: 'standard' | 'premium' | 'premium_duo', yearly: boolean) => void;
}

const PLANS = [
  { code: 'standard' as const, apiCode: 'STANDARD', name: 'Standard', monthly: 2.9, yearly: 29, desc: 'Pour commencer à centraliser vos premiers biens.', features: ['2 biens', '30 documents', '1 utilisateur', 'Agenda et rappels'] },
  { code: 'premium' as const, apiCode: 'PREMIUM', name: 'Premium', monthly: 5.9, yearly: 59, featured: true, desc: 'Pour organiser tout ce que vous possédez.', features: ['10 biens', '150 documents', 'Analyse et organisation automatiques', 'Dossiers prêts à utiliser', 'Réponses à vos questions'] },
  { code: 'premium_duo' as const, apiCode: 'PREMIUM_DUO', name: 'Premium Duo', monthly: 8.9, yearly: 89, desc: 'Pour gérer vos biens à deux, dans un espace commun.', features: ['15 biens', '225 documents', '2 utilisateurs', 'Tout Premium inclus'] },
];

const fmt = (v: number) =>
  v.toLocaleString('fr-FR', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 }) + '\u00A0€';

/** « Toutes les offres » — à rendre dans Mon compte › Mon offre, sous la carte d'abonnement. */
export function PlansSection({ currentPlan, onChoose }: PlansSectionProps) {
  const [yearly, setYearly] = useState(false);

  const choose = (p: typeof PLANS[number]) => {
    if (onChoose) onChoose(p.code, yearly);
    else toast('Redirection vers le paiement sécurisé — offre ' + p.name);
  };

  return (
    <div>
      <div className="flex items-center mb-3">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">Toutes les offres</p>
        <div className="ml-auto flex rounded-[10px] border border-[color:var(--border-subtle)] overflow-hidden">
          {(['Mensuel', 'Annuel'] as const).map((label, i) => {
            const active = (i === 1) === yearly;
            return (
              <button
                key={label}
                onClick={() => setYearly(i === 1)}
                className={`px-3.5 py-1.5 text-xs font-medium transition-colors ${i > 0 ? 'border-l border-[color:var(--border-subtle)]' : ''} ${active ? 'bg-[color:var(--accent)] text-white' : 'text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]'}`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
        {PLANS.map((p) => {
          const isCurrent = currentPlan === p.apiCode;
          const price = yearly ? p.yearly : p.monthly;
          const equiv = yearly
            ? `soit ${fmt(Math.round((p.yearly / 12) * 100) / 100)}/mois · économie de ${fmt(Math.round((p.monthly * 12 - p.yearly) * 100) / 100)}/an`
            : '\u00A0';
          return (
            <div
              key={p.code}
              className={`relative flex flex-col p-4.5 rounded-2xl bg-[color:var(--bg-card)] border ${isCurrent ? 'border-emerald-500/40' : p.featured ? 'border-blue-500/45 shadow-[0_0_0_1px_rgba(59,130,246,.2)]' : 'border-[color:var(--border-subtle)]'}`}
            >
              {isCurrent ? (
                <span className="absolute top-3.5 right-3.5 text-[10px] font-semibold px-2.5 py-1 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-400">Votre offre</span>
              ) : p.featured ? (
                <span className="absolute top-3.5 right-3.5 text-[10px] font-semibold px-2.5 py-1 rounded-full bg-blue-500/20 border border-blue-400/50 text-blue-300">Recommandé</span>
              ) : null}
              <p className="text-[15px] font-semibold text-[color:var(--text-primary)] mb-1">{p.name}</p>
              <p className="text-[11.5px] text-[color:var(--text-muted)] leading-relaxed mb-3 min-h-[34px]">{p.desc}</p>
              <div className="flex items-baseline gap-1">
                <span className="text-2xl font-bold tracking-tight text-[color:var(--text-primary)]">{fmt(price)}</span>
                <span className="text-xs text-[color:var(--text-muted)]">{yearly ? '/an' : '/mois'}</span>
              </div>
              <p className="min-h-4 text-[10.5px] text-[color:var(--text-muted)] mb-3">{equiv}</p>
              <div className="flex flex-col gap-2 mb-4">
                {p.features.map((f) => (
                  <span key={f} className="flex items-start gap-2 text-xs leading-relaxed text-[color:var(--text-primary)]">
                    <Check className="w-3.5 h-3.5 text-[color:var(--accent)] flex-shrink-0 mt-0.5" strokeWidth={2.5} />{f}
                  </span>
                ))}
              </div>
              <div className="mt-auto">
                {isCurrent ? (
                  <div className="w-full h-9 flex items-center justify-center rounded-full border border-[color:var(--border-subtle)] text-xs font-semibold text-[color:var(--text-muted)]">Votre offre actuelle</div>
                ) : (
                  <button
                    onClick={() => choose(p)}
                    className={`w-full h-9 rounded-full text-xs font-semibold transition-all hover:-translate-y-px ${p.featured ? 'bg-gradient-to-br from-[#3b82f6] to-[#1d4ed8] text-white' : 'border border-[color:var(--border-subtle)] text-[color:var(--text-primary)]'}`}
                  >
                    Choisir {p.name}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-3 mt-3 px-4 py-3 rounded-[14px] bg-[color:var(--bg-page)] border border-[color:var(--border-subtle)] opacity-80">
        <span className="text-[10px] font-semibold px-2.5 py-1 rounded-full bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] text-[color:var(--text-muted)]">Bientôt</span>
        <p className="text-xs text-[color:var(--text-muted)] min-w-0">
          <span className="font-semibold text-[color:var(--text-primary)]">Pro</span> — pour la gestion du matériel, des véhicules ou de l'immobilier professionnel.
        </p>
        <Clock className="w-3.5 h-3.5 text-[color:var(--text-muted)] ml-auto flex-shrink-0" />
      </div>
    </div>
  );
}
