'use client';

import { useEffect, useState } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ChevronRight, Package, FileText, CalendarDays, ShieldCheck, Search, FolderOutput, Users } from 'lucide-react';
import type { PlanType } from '@/types/domain';

// ── Storage ───────────────────────────────────────────────────────────────────
const DISMISSED_KEY_PREFIX = 'onboarding_dismissed_';

function getDismissedKey(userId: number) {
  return `${DISMISSED_KEY_PREFIX}${userId}`;
}

// ── Étapes par plan ───────────────────────────────────────────────────────────

interface OnboardingStep {
  icon: React.ReactNode;
  title: string;
  body: React.ReactNode;
}

function getSteps(_plan: PlanType, _duoRole?: 'BILLING_OWNER' | 'MEMBER'): OnboardingStep[] {
  const stepIntro: OnboardingStep = {
    icon: <ShieldCheck className="w-10 h-10 text-blue-500" />,
    title: 'Soyez prêt avant d\'en avoir besoin.',
    body: (
      <p className="text-[color:var(--text-muted)] text-sm leading-relaxed">
        Verebona vous aide à garder au même endroit les informations importantes de vos biens&nbsp;: documents, échéances, garanties, contrats, factures et données utiles.
      </p>
    ),
  };

  const stepBien: OnboardingStep = {
    icon: <Package className="w-10 h-10 text-blue-500" />,
    title: 'Ajoutez votre premier bien',
    body: (
      <p className="text-[color:var(--text-muted)] text-sm leading-relaxed">
        Un bien, c\'est tout ce que vous possédez et souhaitez gérer&nbsp;: appartement, maison, voiture, équipement…
        Cliquez sur le bouton <strong className="text-[color:var(--text-primary)]">Ajouter</strong> dans la barre latérale pour commencer.
      </p>
    ),
  };

  const stepDocument: OnboardingStep = {
    icon: <FileText className="w-10 h-10 text-violet-500" />,
    title: 'Ajoutez vos documents',
    body: (
      <p className="text-[color:var(--text-muted)] text-sm leading-relaxed">
        Ajoutez vos factures, contrats, diagnostics, garanties ou justificatifs.<br />
        Verebona analyse vos documents, en extrait les informations utiles et les associe au bon bien lorsque c\'est possible.
      </p>
    ),
  };

  const stepAgendaNew: OnboardingStep = {
    icon: <CalendarDays className="w-10 h-10 text-emerald-500" />,
    title: 'Agenda',
    body: (
      <p className="text-[color:var(--text-muted)] text-sm leading-relaxed">
        Garanties, contrôles, assurances, entretiens, renouvellements&nbsp;: Verebona fait remonter les dates utiles dans votre agenda pour vous aider à anticiper.
      </p>
    ),
  };

  const stepRetrouve: OnboardingStep = {
    icon: <Search className="w-10 h-10 text-violet-500" />,
    title: 'Retrouvez l\'information sans fouiller.',
    body: (
      <p className="text-[color:var(--text-muted)] text-sm leading-relaxed">
        Besoin d\'une date, d\'un document, d\'une garantie ou d\'une information sur un bien&nbsp;?<br />
        Verebona vous aide à retrouver rapidement ce qui a été organisé dans votre espace.
      </p>
    ),
  };

  const stepDossiers: OnboardingStep = {
    icon: <FolderOutput className="w-10 h-10 text-emerald-500" />,
    title: 'Générez des dossiers prêts à partager.',
    body: (
      <p className="text-[color:var(--text-muted)] text-sm leading-relaxed">
        Vente, location, assurance, entretien ou suivi personnel&nbsp;: Verebona vous aide à créer des exports clairs à partir des informations déjà organisées dans votre espace.
      </p>
    ),
  };

  const stepDuo: OnboardingStep = {
    icon: <Users className="w-10 h-10 text-emerald-500" />,
    title: 'Premium Duo',
    body: (
      <p className="text-[color:var(--text-muted)] text-sm leading-relaxed">
        La maison, la voiture…&nbsp;: gérez-les en duo. Avec Premium Duo, vous partagez un même espace pour organiser ensemble les biens, documents et échéances qui vous concernent tous les deux.
      </p>
    ),
  };

  return [stepIntro, stepBien, stepDocument, stepAgendaNew, stepRetrouve, stepDossiers, stepDuo];
}

// ── Composant ─────────────────────────────────────────────────────────────────

interface WelcomeOnboardingModalProps {
  userId: number;
  plan: PlanType;
  duoRole?: 'BILLING_OWNER' | 'MEMBER';
  /** Forcer l\'ouverture (relance manuelle depuis "Besoin d\'aide ?") */
  forceOpen?: boolean;
  onClose?: () => void;
  /** True dès qu\'au moins un bien existe — ferme définitivement l\'auto-ouverture */
  hasItems?: boolean;
}

export function WelcomeOnboardingModal({
  userId,
  plan,
  duoRole,
  forceOpen,
  onClose,
  hasItems = false,
}: WelcomeOnboardingModalProps) {
  const [open, setOpen] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);

  const steps = getSteps(plan, duoRole);
  const currentStep = steps[stepIndex];
  const isLast = stepIndex === steps.length - 1;

  // Ouverture automatique : à chaque connexion tant qu\'aucun bien n\'existe
  useEffect(() => {
    if (forceOpen) return;
    const key = getDismissedKey(userId);
    if (localStorage.getItem(key) === '1') return;
    // Si l\'utilisateur a déjà ajouté un élément, on marque définitivement comme vu
    if (hasItems) {
      localStorage.setItem(key, '1');
      return;
    }
    const timer = setTimeout(() => setOpen(true), 600);
    return () => clearTimeout(timer);
  }, [userId, forceOpen, hasItems]);

  // Relance manuelle
  useEffect(() => {
    if (forceOpen) {
      setStepIndex(0);
      setOpen(true);
    }
  }, [forceOpen]);

  function dismiss(permanent = false) {
    if (permanent) {
      localStorage.setItem(getDismissedKey(userId), '1');
    }
    setOpen(false);
    setStepIndex(0);
    onClose?.();
  }

  function handleNext() {
    if (isLast) {
      dismiss(true);
    } else {
      setStepIndex((i) => i + 1);
    }
  }

  function handleSkipAll() {
    dismiss(true);
  }

  function handleOpenChange(v: boolean) {
    if (!v) dismiss(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md p-0 overflow-hidden gap-0">
        {/* Header */}
        <div className="px-6 pt-5 pb-0">
          <span className="text-xs font-medium text-[color:var(--text-muted)] uppercase tracking-wide">
            Bienvenue sur Verebona
          </span>
        </div>

        {/* Content */}
        <div className="flex flex-col items-center gap-4 px-8 py-6 text-center min-h-[220px] justify-center">
          <div className="p-3 rounded-2xl bg-[color:var(--bg-card)] shadow-sm">
            {currentStep.icon}
          </div>
          <h2 className="text-lg font-semibold text-[color:var(--text-primary)] leading-snug">
            {currentStep.title}
          </h2>
          <div>{currentStep.body}</div>
        </div>

        {/* Progress dots */}
        <div className="flex items-center justify-center gap-1.5 pb-2">
          {steps.map((_, i) => (
            <span
              key={i}
              className={`block rounded-full transition-all duration-300 ${
                i === stepIndex
                  ? 'w-5 h-2 bg-blue-500'
                  : 'w-2 h-2 bg-[color:var(--border-subtle)]'
              }`}
            />
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-6 pb-6 pt-3">
          <button
            onClick={handleSkipAll}
            className="text-xs text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] transition-colors"
          >
            Tout passer
          </button>
          <Button onClick={handleNext} className="gap-1.5">
            {isLast ? 'Commencer' : 'Suivant'}
            {!isLast && <ChevronRight className="w-4 h-4" />}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
