'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import {
  Gift,
  Copy,
  Sparkles,
  Loader2,
  CheckCheck,
  Share2,
  ExternalLink,
} from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { useNativeCommerceHidden } from '@/hooks/useNativeCommerceHidden';
import { canShareNatively, shareContent } from '@/lib/native/share';
import { REFERRAL_TEXT } from '@/services/referral/referral-rules';
import { useLegalLinks } from '@/hooks/useLegalLinks';
import { LegalLink } from '@/components/legal/LegalLink';

/**
 * Lot 100D (décision PO A9) : texte d'invitation partagé — sans prix ni
 * promesse commerciale (identique dans l'app et sur le Web).
 */
export function referralShareText(code: string): string {
  return `Je vous invite à découvrir Verebona, l’espace qui garde en ordre vos biens et leurs documents. Mon code de parrainage : ${code}`;
}

/** Titre de l'invitation (feuille de partage, objet de l'e-mail de repli). */
export const REFERRAL_SHARE_TITLE = 'Invitation Verebona';

/** Invitation complète (texte + lien) : ce qui est copié quand la feuille de partage n'existe pas. */
export function referralInvitationMessage(code: string, url: string): string {
  return `${referralShareText(code)}\n${url}`;
}

/** E-mail préparé (`mailto:`) : dernier repli si le presse-papiers est refusé. */
export function referralInvitationMailto(code: string, url: string): string {
  return `mailto:?subject=${encodeURIComponent(REFERRAL_SHARE_TITLE)}&body=${encodeURIComponent(referralInvitationMessage(code, url))}`;
}

export type ReferralShareResult = 'shared' | 'cancelled' | 'copied' | 'mailto';

/**
 * Lot 111H — « Partager mon invitation » (seul moyen d'inviter depuis que le
 * formulaire « Inviter par email » est retiré, décision PO) :
 *   1. feuille de partage native (app iOS / Android) ou du navigateur
 *      (`navigator.share`) — Mail, Messages, WhatsApp… ; lien joint, aucune
 *      ressaisie ;
 *   2. sinon (navigateur de bureau sans Web Share) : copie de l'invitation
 *      complète (texte + lien) ;
 *   3. sinon (presse-papiers refusé) : e-mail préparé dans la messagerie.
 * Dépendances injectables (tests). Jamais d'exception.
 */
export async function shareReferralInvitation(
  link: { code: string; url: string },
  deps: {
    share: typeof shareContent;
    copy: (text: string) => Promise<void>;
    openMailto: (href: string) => void;
  },
): Promise<ReferralShareResult> {
  const text = referralShareText(link.code);
  const outcome = await deps.share({ title: REFERRAL_SHARE_TITLE, text, url: link.url });
  if (outcome === 'shared' || outcome === 'cancelled') return outcome;
  try {
    await deps.copy(referralInvitationMessage(link.code, link.url));
    return 'copied';
  } catch {
    deps.openMailto(referralInvitationMailto(link.code, link.url));
    return 'mailto';
  }
}

/**
 * Lot 108H (décision PO) : présentation courte — une accroche, le bénéfice
 * (au parrain seul) avec la condition « abonnement annuel », et le lien vers
 * les conditions complètes de la page publique « Légal › Parrainage »
 * (`useLegalLinks().parrainage`, URL de l'environnement). Plus aucune liste
 * de conditions ici : la règle complète est sur le site public, la règle
 * appliquée reste `referral-rules.ts`.
 *
 * Le lien passe par `LegalLink` : nouvel onglet sur le Web ; dans l'app
 * iOS / Android, navigateur SYSTÈME (`lib/native/open-external`, jamais de
 * vue intégrée), Verebona restant ouvert en arrière-plan.
 */
export function ReferralSummary() {
  const legalLinks = useLegalLinks();
  const label = REFERRAL_TEXT.accountTermsLinkLabel;
  const cut = label.lastIndexOf(' ');
  const termsHead = cut > 0 ? label.slice(0, cut) : '';
  const termsTail = cut > 0 ? label.slice(cut + 1) : label;
  return (
    <div className="space-y-1.5" data-testid="referral-summary">
      <p className="text-sm text-muted-foreground">{REFERRAL_TEXT.accountIntro}</p>
      <p className="text-sm text-[color:var(--text-primary)]">{REFERRAL_TEXT.accountReward}</p>
      <LegalLink
        href={legalLinks.parrainage}
        target="_blank"
        className="inline-block min-h-11 py-2.5 text-sm font-medium text-primary underline underline-offset-2 hover:no-underline"
        data-testid="referral-terms-link"
      >
        {/* Dernier mot et icône insécables : l'icône ne passe jamais seule à la ligne. */}
        {termsHead}{termsHead && ' '}
        <span className="whitespace-nowrap">
          {termsTail}
          <ExternalLink className="ml-1 inline h-3.5 w-3.5 align-[-2px]" aria-hidden />
        </span>
      </LegalLink>
    </div>
  );
}

// ─── Composant principal ─────────────────────────────────────────────────────

/**
 * @param withHeading titre « Parrainage » interne. `false` dans `ReferralCard`
 *   (lot 26), dont l'en-tête de carte porte déjà ce titre et l'icône.
 */
export function ReferralBlock({ withHeading = true }: { withHeading?: boolean } = {}) {
  const [data, setData] = useState<{
    eligible: boolean;
    link: { code: string; url: string; id: number } | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [creatingLink, setCreatingLink] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [stats, setStats] = useState<{ validatedCount: number; monthsEarned: number } | null>(null);
  // Lot 100D (A9) : le parrainage reste dans l'application (code visible,
  // copiable, partageable) ; seules les mentions qui poussent à souscrire
  // sont remplacées par un texte neutre.
  const inApp = useNativeCommerceHidden();
  const [canShare, setCanShare] = useState(false);
  useEffect(() => { setCanShare(canShareNatively()); }, []);

  useEffect(() => {
    loadReferralData();
  }, []);

  const loadReferralData = async () => {
    try {
      setLoading(true);
      const result = await apiClient.get<any>('/api/referral/me');
      setData({
        eligible: result.eligible,
        link: result.link ? { code: result.link.code, url: result.link.url, id: result.link.id } : null,
      });
      if (result.stats) {
        setStats({
          validatedCount: result.stats.validatedCount || 0,
          monthsEarned: result.stats.monthsEarned || 0,
        });
      }
    } catch (err) {
      console.error('[ReferralBlock] load error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateLink = async () => {
    try {
      setCreatingLink(true);
      await apiClient.post('/api/referral/me', {});
      toast.success('Votre lien de parrainage a été créé !');
      await loadReferralData();
    } catch (err) {
      console.error('[ReferralBlock] create error:', err);
      toast.error('Impossible de créer votre lien de parrainage.');
    } finally {
      setCreatingLink(false);
    }
  };

  const handleCopyCode = async () => {
    if (!data?.link?.code) return;
    try {
      await navigator.clipboard.writeText(data.link.code);
      setCodeCopied(true);
      toast.success('Code copié');
      setTimeout(() => setCodeCopied(false), 2000);
    } catch {
      toast.error('Impossible de copier le code');
    }
  };

  const handleCopyLink = async () => {
    if (!data?.link?.url) return;
    try {
      await navigator.clipboard.writeText(data.link.url);
      setLinkCopied(true);
      toast.success('Lien copié');
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      toast.error('Impossible de copier le lien');
    }
  };

  /** Lot 111H : partage natif / navigateur ; sinon copie ; sinon e-mail préparé. */
  const handleShare = async () => {
    if (!data?.link) return;
    const r = await shareReferralInvitation(data.link, {
      share: shareContent,
      copy: (t) => navigator.clipboard.writeText(t),
      openMailto: (href) => { window.location.href = href; },
    });
    if (r === 'copied') toast.success('Invitation copiée : collez-la dans le message de votre choix.');
  };

  // ── Loading ──
  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }

  // ── État 1 : non éligible ──
  if (!data?.eligible) {
    return (
      <div className="border border-dashed border-[color:var(--border-subtle)] rounded-lg p-4 space-y-2">
        {withHeading && (
        <h4 className="vb-app-subsection flex items-center gap-2">
          <Gift className="w-4 h-4 text-muted-foreground" />
          Parrainage
        </h4>
        )}
        {inApp ? (
          <p className="text-xs text-muted-foreground" data-testid="referral-not-yet">
            Le parrainage n’est pas encore disponible pour votre compte.
          </p>
        ) : (
          <>
            {/* Lot 102D : « offres Premium ou Premium Duo annuelles » contredisait
                l'API et l'aide. Règle centrale : titulaire d'un abonnement payant. */}
            <ReferralSummary />
            <p className="text-xs text-muted-foreground">{REFERRAL_TEXT.notEligible}</p>
          </>
        )}
      </div>
    );
  }

  // ── État 2 : éligible, pas encore de lien ──
  if (!data.link) {
    return (
      <div className="space-y-3">
        {withHeading && (
        <h4 className="vb-app-subsection flex items-center gap-2">
          <Gift className="w-4 h-4 text-primary" />
          Parrainage
        </h4>
        )}
        {/* GAP-07 : le parrainage = 1 mois offert AU PARRAIN SEUL (voir
            referral-reward.service.ts). Lot 108H : texte court + lien. */}
        <ReferralSummary />
        <Button onClick={handleCreateLink} disabled={creatingLink} size="sm" className="h-auto min-h-9 w-full whitespace-normal py-2 sm:w-auto">
          {creatingLink ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Gift className="w-4 h-4 mr-2" />
          )}
          Créer mon lien de parrainage
        </Button>
      </div>
    );
  }

  // ── État 3 : lien créé — Wireframe CDC §6.4 ──
  return (
    <div className="space-y-4">
      {/* Titre + message récompense — lot 108H : empilés sur petit écran
          (le badge ne comprime plus le texte). */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          {withHeading && (
          <h4 className="vb-app-subsection flex items-center gap-2">
            <Gift className="w-4 h-4 text-primary" />
            Parrainage
          </h4>
          )}
          {/* Lot 108H : accroche, bénéfice (abonnement annuel) et lien vers les
              conditions complètes — plus de liste de conditions dans le bloc. */}
          <ReferralSummary />
        </div>
        {(stats?.validatedCount ?? 0) > 0 && (
          <Badge variant="secondary" className="self-start flex-shrink-0 text-xs gap-1">
            <Sparkles className="w-3 h-3" />
            {stats!.monthsEarned} mois offert{stats!.monthsEarned > 1 ? 's' : ''}
          </Badge>
        )}
      </div>

      {/* Stats */}
      {stats && stats.validatedCount > 0 && (
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg border bg-muted/30 px-3 py-2 text-center">
            <div className="text-lg font-bold text-foreground">{stats.validatedCount}</div>
            <div className="text-xs text-muted-foreground">parrainage{stats.validatedCount > 1 ? 's' : ''} validé{stats.validatedCount > 1 ? 's' : ''}</div>
          </div>
          <div className="rounded-lg border bg-muted/30 px-3 py-2 text-center">
            {/* La récompense n'est plus un lot d'analyses mais un mois
                d'abonnement. Le compteur affichait encore `validatedCount * 10`,
                soit une unité qui n'existe plus. */}
            <div className="text-lg font-bold text-primary">{stats.monthsEarned}</div>
            <div className="text-xs text-muted-foreground">
              mois offert{stats.monthsEarned > 1 ? 's' : ''}
            </div>
          </div>
        </div>
      )}

      <ReferralLinkActions
        code={data.link.code}
        url={data.link.url}
        canShare={canShare}
        codeCopied={codeCopied}
        linkCopied={linkCopied}
        onCopyCode={handleCopyCode}
        onCopyLink={handleCopyLink}
        onShare={handleShare}
      />
    </div>
  );
}

/**
 * Code, lien et actions (CDC §6.4). Lot 111H (décision PO) : le formulaire
 * « Inviter par email » (titre, champ, bouton, séparateur) est retiré — il
 * faisait doublon avec « Partager mon invitation ». Le partage est la
 * DERNIÈRE ligne de la section : ni séparateur ni espace résiduel en bas.
 */
export function ReferralLinkActions(p: {
  code: string;
  url: string;
  canShare: boolean;
  codeCopied: boolean;
  linkCopied: boolean;
  onCopyCode: () => void;
  onCopyLink: () => void;
  onShare: () => void;
}) {
  return (
    <>
      {/* Votre code — CDC §6.4 */}
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-[color:var(--text-secondary)]">Votre code</p>
        {/* Lot 108H : empilés sous 640 px (le bouton ne déborde plus de la carte). */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <code className="flex-1 min-w-0 break-all text-sm font-mono font-semibold text-primary bg-muted/50 rounded-md px-3 py-2 select-all">
            {p.code}
          </code>
          <Button
            variant="outline"
            size="sm"
            onClick={p.onCopyCode}
            className="w-full sm:w-auto flex-shrink-0 gap-1.5"
            data-testid="referral-copy-code"
          >
            {p.codeCopied ? (
              <CheckCheck className="w-3.5 h-3.5 text-[color:var(--text-success)]" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
            {p.codeCopied ? 'Copié' : 'Copier le code'}
          </Button>
        </div>
      </div>

      {/* Votre lien — CDC §6.4 */}
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-[color:var(--text-secondary)]">Votre lien</p>
        {/* Lot 108H : sous 640 px, champ et bouton empilés (lien lisible en entier). */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {/* Lot 108H : adresse affichée en entier (retour à la ligne), sélectionnable
              d'un geste — un champ de saisie la coupait sur mobile. */}
          <code
            className="flex-1 min-w-0 break-all font-mono text-xs text-[color:var(--text-primary)] bg-muted/50 rounded-md border px-3 py-2 select-all"
            data-testid="referral-link-url"
          >
            {p.url}
          </code>
          <Button
            variant="outline"
            size="sm"
            onClick={p.onCopyLink}
            className="w-full sm:w-auto flex-shrink-0 gap-1.5"
            data-testid="referral-copy-link"
          >
            {p.linkCopied ? (
              <CheckCheck className="w-3.5 h-3.5 text-[color:var(--text-success)]" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
            {p.linkCopied ? 'Copié' : 'Copier le lien'}
          </Button>
        </div>
      </div>

      {/* Lot 100D (A9) : partager l'invitation — feuille de partage native dans
          l'app, celle du navigateur si elle existe, sinon copie de l'invitation
          complète (lot 111H : puis e-mail préparé si la copie est refusée). */}
      <Button
        variant="outline"
        size="sm"
        onClick={p.onShare}
        className="w-full sm:w-auto gap-1.5"
        data-testid="referral-share"
      >
        {p.canShare ? <Share2 className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
        {p.canShare ? 'Partager mon invitation' : 'Copier mon invitation'}
      </Button>
    </>
  );
}
