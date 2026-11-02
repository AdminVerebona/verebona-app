'use client';

import Link from 'next/link';
import { publicSiteUrl } from '@/lib/external-urls';
import type { LegalDocumentKey, LegalLinks } from '@/lib/legal/public-legal';
import { useLegalLinks } from '@/hooks/useLegalLinks';
import { LegalLink } from '@/components/legal/LegalLink';

/**
 * Liens du pied de page.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * QUATRE LIENS RENVOYAIENT 404
 *
 * `/legal`, `/politique-confidentialite`, `/contact` et `/aide` désignent des
 * pages de la VITRINE (verebona.fr). Écrits en relatif, ils pointaient vers
 * l'application (app.verebona.fr), où ces pages n'existent pas.
 *
 * Next préchargeant les liens au survol, les 404 apparaissaient dans la
 * console avant même qu'on ne clique.
 *
 * `external: true` marque ceux qui doivent traverser vers la vitrine. Lot
 * 102B : les contenus légaux (dont les CGUV) sont TOUS sur le site public,
 * source juridique unique ; seule la rétractation reste servie ici.
 * ══════════════════════════════════════════════════════════════════════════
 */
// Lot 102B : liens légaux par CONTENU (`legalKey`), résolus par
// `useLegalLinks` — adresses actuelles du site tant qu'il n'a pas livré,
// /legal/… ensuite. Jamais de 404.
type FooterLink = { href: string; label: string; external?: boolean; legalKey?: LegalDocumentKey };
const LINKS: FooterLink[] = [
  { href: 'legal:mentionsLegales', legalKey: 'mentionsLegales', label: 'Mentions légales' },
  { href: 'legal:cguv',            legalKey: 'cguv',            label: 'CGUV' },
  { href: 'legal:confidentialite', legalKey: 'confidentialite', label: 'Confidentialité' },
  { href: '/contact',                   label: 'Contact', external: true },
  { href: '/aide',                      label: "Centre d'aide", external: true },
  // CDC rétractation §6.1 : libellé imposé mot pour mot.
  { href: '/retractation',              label: 'Renoncer au contrat ici' },
];

/** Cible réelle d'un lien : contenu légal, vitrine ou application. */
function resolveHref(link: FooterLink, legal: LegalLinks): string {
  if (link.legalKey) return legal[link.legalKey];
  return link.external ? publicSiteUrl(link.href) : link.href;
}

export function Footer() {
  const legal = useLegalLinks();
  return (
    <footer className="border-t border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] mt-auto">
      <div className="container mx-auto px-4 md:px-6 py-4 md:py-6">

        {/* Desktop : une seule ligne */}
        <div className="hidden md:flex items-center justify-between gap-4">
          <span className="text-sm text-[color:var(--text-muted)]">© 2025 Verebona</span>
          <div className="flex items-center gap-6 text-sm">
            {LINKS.map(l => l.legalKey ? (
              // Lot 103A : texte juridique — navigateur externe dans l'app, même onglet sur le Web (inchangé).
              <LegalLink key={l.href} href={resolveHref(l, legal)} className="text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] transition-colors">
                {l.label}
              </LegalLink>
            ) : (
              <Link key={l.href} href={resolveHref(l, legal)} className="text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] transition-colors">
                {l.label}
              </Link>
            ))}
          </div>
        </div>

        {/* Mobile : grille 2×2 compacte + copyright en dessous */}
        <div className="md:hidden space-y-3">
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            {LINKS.map(l => l.legalKey ? (
              <LegalLink
                key={l.href}
                href={resolveHref(l, legal)}
                className="text-xs text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] transition-colors py-1"
              >
                {l.label}
              </LegalLink>
            ) : (
              <Link
                key={l.href}
                href={resolveHref(l, legal)}
                className="text-xs text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] transition-colors py-1"
              >
                {l.label}
              </Link>
            ))}
          </div>
          <p className="text-[11px] text-[color:var(--text-muted)]/50 text-center border-t border-[color:var(--border-subtle)] pt-3">
            © 2025 Verebona
          </p>
        </div>

      </div>
    </footer>
  );
}