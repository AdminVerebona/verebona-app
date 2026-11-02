'use client';

import Link from 'next/link';
import { Logo } from './Logo';
import { publicSiteUrl } from '@/lib/external-urls';
import type { LegalDocumentKey, LegalLinks } from '@/lib/legal/public-legal';
import { useLegalLinks } from '@/hooks/useLegalLinks';
import { LegalLink } from '@/components/legal/LegalLink';

/** Lot 102B : `legalKey` = contenu légal résolu par `useLegalLinks` (repli : adresses actuelles du site). */
type FooterLink = { href: string; label: string; external?: boolean; legalKey?: LegalDocumentKey };

/**
 * Colonnes du pied de page public.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * HUIT LIENS SUR DIX MÈNENT À LA VITRINE
 *
 * Ce pied de page est affiché par l'APPLICATION, mais la plupart de ses liens
 * désignent des pages de la vitrine. Écrits en relatif, ils pointaient vers
 * app.verebona.fr, où aucune n'existe : six 404 apparaissaient dans la
 * console au seul survol, Next préchargeant les liens.
 *
 * Seul `/retractation` est servi par l'application (§6.1 du CDC rétractation).
 * Lot 102B : tous les contenus légaux, CGUV comprises, sont sur le site public
 * (source juridique unique, URL directe par contenu).
 * ══════════════════════════════════════════════════════════════════════════
 */
const COLUMNS: Array<{
  title: string;
  links: FooterLink[];
}> = [
  {
    title: 'Produit',
    links: [
      // Lot 72 : l'ancien lien vers la page « pourquoi » de la vitrine est
      // retiré (page supprimée, sans équivalent) ; « Comment ça marche ? » vise la section de
      // l'accueil (`HowItWorksSection`, id="how"). Destinations contrôlées
      // contre l'inventaire de la vitrine (`lib/public-site/link-inventory`).
      { href: '/#how',     label: 'Comment ça marche ?', external: true },
      { href: '/#pricing', label: 'Tarifs', external: true },
    ],
  },
  {
    title: 'Support',
    links: [
      { href: '/#faq',    label: 'FAQ', external: true },
      { href: '/aide',    label: "Centre d'aide", external: true },
      { href: '/contact', label: 'Contact', external: true },
    ],
  },
  {
    title: 'Légal',
    links: [
      { href: 'legal:mentionsLegales', legalKey: 'mentionsLegales', label: 'Mentions légales' },
      { href: 'legal:cguv',            legalKey: 'cguv',            label: 'CGUV' },
      // CDC rétractation §6.1 : libellé imposé mot pour mot.
      { href: '/retractation',      label: 'Renoncer au contrat ici' },
      { href: 'legal:confidentialite', legalKey: 'confidentialite', label: 'Confidentialité' },
      { href: 'legal:sousTraitants',   legalKey: 'sousTraitants',   label: 'Sous-traitants et prestataires' },
      // « Parrainage » : onglet du site public, volontairement absent d'ici —
      // ce pied de page est aussi celui de l'inscription d'un invité Premium
      // Duo, sans aucune mention de parrainage (lot 57A). Lien dans Mon compte.
    ],
  },
];

/** Cible réelle d'un lien : contenu légal, vitrine ou application. */
function resolveHref(link: FooterLink, legal: LegalLinks): string {
  if (link.legalKey) return legal[link.legalKey];
  return link.external ? publicSiteUrl(link.href) : link.href;
}

export function AuthFooter() {
  const legal = useLegalLinks();
  return (
    <footer className="py-4 px-6 text-center">
      <p className="text-xs text-[color:var(--text-muted)]">
        © {new Date().getFullYear()} Verebona. Tous droits réservés.
        {' · '}
        <LegalLink href={legal.mentionsLegales} className="hover:text-[color:var(--text-primary)] transition-colors">Mentions légales</LegalLink>
        {' · '}
        <LegalLink href={legal.cguv} className="hover:text-[color:var(--text-primary)] transition-colors">CGUV</LegalLink>
        {' · '}
        <LegalLink href={legal.confidentialite} className="hover:text-[color:var(--text-primary)] transition-colors">Confidentialité</LegalLink>
      </p>
    </footer>
  );
}

export function LandingFooter() {
  const legal = useLegalLinks();
  // Charte « Sérénité » : pied des pages publiques sur le fond du menu du
  // thème courant (`.public-page` suit le thème depuis le lot 67, comme les
  // pages d'authentification), filet du thème, textes aux jetons.
  return (
    <footer className="public-page bg-[color:var(--sidebar)] border-t border-[color:var(--border-subtle)]">
      <div className="container mx-auto px-6 md:px-10 py-7">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-[2fr_1fr_1fr_1fr] md:gap-x-0 md:gap-y-0 items-stretch">

          {/* Colonne logo + baseline */}
          <div className="col-span-2 md:col-span-1 flex flex-col gap-3">
            <a href={publicSiteUrl("/")}>
              <Logo size={42} withText={true} withBaseline={true} />
            </a>
            <p className="text-xs text-[color:var(--text-muted)] mt-auto pt-4">
              © {new Date().getFullYear()} Verebona. Tous droits réservés.
            </p>
          </div>

          {/* Colonnes liens */}
          {COLUMNS.map((col) => (
            <div key={col.title} className="md:pl-8">
              <p className="text-[13px] font-bold text-[color:var(--text-primary)] mb-3">
                {col.title}
              </p>
              <ul className="space-y-1.5">
                {col.links.map((link) => (
                  <li key={link.href}>
                    {link.legalKey ? (
                      // Lot 103A : texte juridique — navigateur externe dans l'app ; Web inchangé.
                      <LegalLink
                        href={resolveHref(link, legal)}
                        className="text-sm text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)] transition-colors"
                      >
                        {link.label}
                      </LegalLink>
                    ) : (
                      <Link
                        href={resolveHref(link, legal)}
                        className="text-sm text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)] transition-colors"
                      >
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}

        </div>
      </div>
    </footer>
  );
}
