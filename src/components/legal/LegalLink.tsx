'use client';

/**
 * Lien vers un texte juridique — lot 103A (primitive `lib/legal/open-legal-link`).
 *
 * Rendu : une balise `<a>` ordinaire (mêmes attributs qu'avant : `target`,
 * `rel`, classes), pour que le Web reste strictement inchangé (nouvel onglet
 * ou même onglet selon l'appelant, clic du milieu, « ouvrir dans un nouvel
 * onglet », lecteurs d'écran).
 *
 * Au clic :
 *   · application iOS / Android : la navigation de la vue est TOUJOURS
 *     empêchée ; le texte s'ouvre dans le navigateur externe du téléphone ;
 *   · navigateur : la balise fait son travail, sauf si l'adresse n'est pas
 *     une destination juridique autorisée (aucune navigation, message).
 * Échec : message et bouton « Copier le lien » (adresse officielle).
 */
import { useEffect, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { isNativeApp } from '@/lib/native/bridge';
import {
  checkLegalUrl, copyLegalUrl, currentLegalLinkPolicy, legalOpenFailureMessage, openLegalLink, type LegalOpenResult,
} from '@/lib/legal/open-legal-link';
import { preloadLegalLinks } from '@/hooks/useLegalLinks';

type AnchorProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick'>;

export interface LegalLinkProps extends AnchorProps {
  href: string | null | undefined;
  /** Adresse officielle de repli proposée à la copie si `href` est refusée. */
  fallbackHref?: string | null;
  children: ReactNode;
}

/** Message d'échec et copie de l'adresse (toast partagé de l'application). */
export function notifyLegalOpenFailure(r: Extract<LegalOpenResult, { ok: false }>): void {
  const url = r.copyUrl;
  toast.error(legalOpenFailureMessage(r), {
    description: url ?? undefined,
    duration: 15_000,
    ...(url
      ? {
          action: {
            label: 'Copier le lien',
            onClick: () => {
              void copyLegalUrl(url).then((ok) => {
                if (ok) toast.success('Lien copié. Collez-le dans votre navigateur.');
                else toast.message('Copie impossible : sélectionnez l’adresse affichée pour la copier.');
              });
            },
          },
        }
      : {}),
  });
}

/** Ouvre un texte juridique depuis un geste (bouton, menu) : même règle que `LegalLink`. */
export async function openLegalLinkWithFeedback(href: string | null | undefined, fallbackHref?: string | null): Promise<void> {
  const r = await openLegalLink(href, { fallbackUrl: fallbackHref });
  if (!r.ok) notifyLegalOpenFailure(r);
}

export function LegalLink({ href, fallbackHref, children, target, rel, ...rest }: LegalLinkProps) {
  // Origines juridiques déclarées par le serveur (permaliens hors site public).
  useEffect(() => { preloadLegalLinks(); }, []);

  const effective = href || fallbackHref || null;
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (isNativeApp()) {
      // Jamais de chargement dans la vue de l'app : page, tiroir et saisies restent intacts.
      e.preventDefault();
      void openLegalLinkWithFeedback(effective, fallbackHref);
      return;
    }
    const check = checkLegalUrl(effective, currentLegalLinkPolicy());
    if (!check.ok) {
      e.preventDefault();
      void openLegalLinkWithFeedback(effective, fallbackHref);
    }
  };

  return (
    <a
      {...rest}
      href={effective ?? '#'}
      target={target}
      rel={target === '_blank' ? (rel ?? 'noopener noreferrer') : rel}
      onClick={onClick}
    >
      {children}
    </a>
  );
}
