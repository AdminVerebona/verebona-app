import Link from 'next/link';
import { publicSiteUrl } from '@/lib/external-urls';

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
 * `external: true` marque ceux qui doivent traverser vers la vitrine. Les
 * autres — CGVU et rétractation — sont bien servis par l'application, et le
 * §12 du CDC CGVU exige d'ailleurs qu'ils y restent accessibles sans session.
 * ══════════════════════════════════════════════════════════════════════════
 */
const LINKS: Array<{ href: string; label: string; external?: boolean }> = [
  { href: '/mentions-legales',          label: 'Mentions légales', external: true },
  { href: '/cgvu',                      label: 'CGVU' },
  { href: '/confidentialite',           label: 'Confidentialité', external: true },
  { href: '/contact',                   label: 'Contact', external: true },
  { href: '/aide',                      label: "Centre d'aide", external: true },
  // CDC rétractation §6.1 : libellé imposé mot pour mot.
  { href: '/retractation',              label: 'Renoncer au contrat ici' },
];

/** Cible réelle d'un lien : vitrine ou application. */
function resolveHref(link: { href: string; external?: boolean }): string {
  return link.external ? publicSiteUrl(link.href) : link.href;
}

export function Footer() {
  return (
    <footer className="border-t border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] mt-auto">
      <div className="container mx-auto px-4 md:px-6 py-4 md:py-6">

        {/* Desktop : une seule ligne */}
        <div className="hidden md:flex items-center justify-between gap-4">
          <span className="text-sm text-[color:var(--text-muted)]">© 2025 Verebona</span>
          <div className="flex items-center gap-6 text-sm">
            {LINKS.map(l => (
              <Link key={l.href} href={resolveHref(l)} className="text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] transition-colors">
                {l.label}
              </Link>
            ))}
          </div>
        </div>

        {/* Mobile : grille 2×2 compacte + copyright en dessous */}
        <div className="md:hidden space-y-3">
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            {LINKS.map(l => (
              <Link
                key={l.href}
                href={resolveHref(l)}
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