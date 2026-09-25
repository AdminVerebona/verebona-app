'use client';

/**
 * Refus d'écriture — fenêtre partagée. CDC 1 §8.3, §9.2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX SITUATIONS, DEUX DISCOURS
 *
 * Cette fenêtre vivait dans `assets/page.tsx`, en 73 lignes de JSX, avec un
 * corps figé : « Passez à Premium pour gérer jusqu'à 10 biens et 150
 * documents ».
 *
 * C'est le bon message pour un abonné Standard qui bute sur son quota. Ce
 * n'est pas celui d'un essai terminé : cette personne n'a AUCUNE offre, et
 * lui proposer Premium revient à lui faire sauter une étape — elle doit
 * d'abord choisir, pas monter en gamme.
 *
 * L'en-tête était déjà juste, parce qu'il venait du serveur via
 * `writeBlockedTitle` et du message de `entitlements.service`. Seul le corps
 * ignorait la distinction.
 *
 * ── POURQUOI LA SORTIR DE LA PAGE ─────────────────────────────────────────
 *
 * Une douzaine d'actions doivent la déclencher : ajout de bien, de document,
 * d'échéance, d'équipement, de pièce, exports, modification des fiches,
 * envoi à l'assistant. Recopier 73 lignes autant de fois garantissait la
 * divergence — ce projet en a déjà fait les frais avec deux pages d'offres
 * et deux écrans de fin d'essai.
 * ══════════════════════════════════════════════════════════════════════════
 */

import Link from 'next/link';
import { Crown, Check, ArrowRight, Sparkles } from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  writeBlockedTitle,
  OFFERS_PATH,
  type WriteBlockedInfo,
} from '@/lib/write-blocked';

interface WriteBlockedDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Refus renvoyé par le serveur. `null` : message générique. */
  info: WriteBlockedInfo | null;
}

/**
 * Un essai terminé n'est pas un quota atteint.
 *
 * Le premier n'a pas d'offre et doit en choisir une ; le second en a une et
 * peut en changer. Proposer « Passer à Premium » au premier lui fait sauter
 * l'étape du choix.
 */
function estFinEssai(code: string | undefined): boolean {
  return code === 'TRIAL_EXPIRED' || code === 'SUBSCRIPTION_REQUIRED';
}

export function WriteBlockedDialog({ open, onOpenChange, info }: WriteBlockedDialogProps) {
  const finEssai = estFinEssai(info?.code);
  // Fonctionnalité réservée (dossiers prêts à l'usage…) : les deux offres
  // qui la débloquent sont nommées, pas seulement Premium.
  const premiumRequis = info?.code === 'PREMIUM_REQUIRED';
  const fermer = () => onOpenChange(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="p-0 overflow-hidden sm:max-w-md border-0">
        {/* En-tête — inchangé : il était déjà juste. */}
        <div
          className="relative px-6 pt-8 pb-6 text-center"
          style={{ background: 'linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #1e3a5f 100%)' }}
        >
          <div
            className="absolute inset-0 opacity-20"
            style={{ backgroundImage: 'radial-gradient(circle at 30% 20%, #6366f1 0%, transparent 50%), radial-gradient(circle at 70% 80%, #3b82f6 0%, transparent 50%)' }}
          />
          <div className="relative z-10">
            <div
              className="w-14 h-14 rounded-2xl mx-auto mb-4 flex items-center justify-center"
              style={{ background: 'linear-gradient(135deg, #6366f1, #3b82f6)' }}
            >
              {finEssai ? (
                <Sparkles className="w-7 h-7 text-white" />
              ) : (
                <Crown className="w-7 h-7 text-white" />
              )}
            </div>
            <h2 className="text-xl font-bold text-white mb-1">
              {info ? writeBlockedTitle(info.code) : 'Limite atteinte'}
            </h2>
            <p className="text-sm text-white/70">
              {/* Le message vient du serveur : il connaît l'offre, le quota
                  et l'état de l'essai. */}
              {info ? info.message : 'Vous avez atteint la limite de votre offre.'}
            </p>
          </div>
        </div>

        <div className="px-6 py-5 space-y-4 bg-[color:var(--bg-card)]">
          {finEssai ? (
            <>
              <p className="text-sm text-muted-foreground text-center">
                Choisissez l&apos;offre qui vous convient pour reprendre l&apos;ajout et la
                modification de vos biens et documents.
              </p>

              {/* Ce qui reste possible sans offre. Dit explicitement : sans
                  cela, « terminé » laisse craindre une perte de données. */}
              <div className="space-y-2.5">
                {[
                  'Vos données sont conservées',
                  'Vos biens et documents restent consultables',
                  'Aucun prélèvement n\u2019a été effectué',
                ].map((texte) => (
                  <div key={texte} className="flex items-center gap-3 text-sm">
                    <div className="w-6 h-6 rounded-full bg-blue-500/10 flex items-center justify-center flex-shrink-0">
                      <Check className="w-3.5 h-3.5 text-blue-500" />
                    </div>
                    <span className="text-foreground/80">{texte}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              {premiumRequis ? (
                <p className="text-sm text-muted-foreground text-center">
                  Passez à <strong className="text-foreground">Premium</strong> ou{' '}
                  <strong className="text-foreground">Premium Duo</strong> pour accéder à
                  cette fonctionnalité et à toutes les fonctionnalités Premium.
                </p>
              ) : (
                <p className="text-sm text-muted-foreground text-center">
                  Passez à <strong className="text-foreground">Premium</strong> pour gérer
                  jusqu&apos;à 10 biens et 150 documents, et débloquer toutes les
                  fonctionnalités.
                </p>
              )}

              <div className="space-y-2.5">
                {[
                  'Tout Standard +',
                  'Jusqu\u2019à 10 biens et 150 documents',
                  'Interrogez Verebona sur vos biens et documents',
                  'Dossiers prêts à l\u2019emploi',
                ].map((texte) => (
                  <div key={texte} className="flex items-center gap-3 text-sm">
                    <div className="w-6 h-6 rounded-full bg-blue-500/10 flex items-center justify-center flex-shrink-0">
                      <Check className="w-3.5 h-3.5 text-blue-500" />
                    </div>
                    <span className="text-foreground/80">{texte}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="pt-1 space-y-2">
            <Link
              href={OFFERS_PATH}
              onClick={fermer}
              className="flex items-center justify-center gap-2 w-full py-3 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90 active:scale-[0.98]"
              style={{ background: 'linear-gradient(135deg, #6366f1, #3b82f6)' }}
            >
              {/* « Choisir une offre » plutôt que « Passer à Premium » : sans
                  offre en cours, il n'y a pas de montée en gamme. Même
                  libellé que le bandeau de fin d'essai. */}
              {finEssai ? (
                <>Choisir mon offre</>
              ) : (
                <>
                  <Crown className="w-4 h-4" />
                  {premiumRequis ? 'Passer à Premium ou Premium Duo' : 'Passer à Premium'}
                </>
              )}
              <ArrowRight className="w-4 h-4" />
            </Link>
            <button
              onClick={fermer}
              className="w-full py-2.5 rounded-xl text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Plus tard
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
