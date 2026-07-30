import Link from 'next/link';
import { Logo } from './Logo';
import { publicSiteUrl } from '@/lib/external-urls';

/**
 * Colonnes du pied de page public.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * HUIT LIENS SUR ONZE MÈNENT À LA VITRINE
 *
 * Ce pied de page est affiché par l'APPLICATION, mais la plupart de ses liens
 * désignent des pages de la vitrine. Écrits en relatif, ils pointaient vers
 * app.verebona.fr, où aucune n'existe : six 404 apparaissaient dans la
 * console au seul survol, Next préchargeant les liens.
 *
 * Seuls `/cgvu` et `/retractation` sont servis par l'application, et c'est
 * délibéré : le §12 du CDC CGVU exige que les conditions restent accessibles
 * sans session, et le §6.1 du CDC rétractation impose le même parcours partout.
 * ══════════════════════════════════════════════════════════════════════════
 */
const COLUMNS: Array<{
  title: string;
  links: Array<{ href: string; label: string; external?: boolean }>;
}> = [
  {
    title: 'Produit',
    links: [
      { href: '/pourquoi-verebona', label: 'Pourquoi Verebona ?', external: true },
      { href: '/comment-ca-marche', label: 'Comment ça marche ?', external: true },
      { href: '/#pricing',          label: 'Tarifs', external: true },
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
      { href: '/mentions-legales',  label: 'Mentions légales', external: true },
      { href: '/cgvu',              label: 'CGVU' },
      // CDC rétractation §6.1 : libellé imposé mot pour mot.
      { href: '/retractation',      label: 'Renoncer au contrat ici' },
      { href: '/confidentialite',   label: 'Confidentialité', external: true },
    ],
  },
];

/** Cible réelle d'un lien : vitrine ou application. */
function resolveHref(link: { href: string; external?: boolean }): string {
  return link.external ? publicSiteUrl(link.href) : link.href;
}

export function AuthFooter() {
  return (
    <footer className="py-4 px-6 text-center">
      <p className="text-xs text-white/30">
        © {new Date().getFullYear()} Verebona. Tous droits réservés.
        {' · '}
        <a href={publicSiteUrl('/mentions-legales')} className="hover:text-white/60 transition-colors">Mentions légales</a>
        {' · '}
        <a href={publicSiteUrl('/confidentialite')} className="hover:text-white/60 transition-colors">Confidentialité</a>
      </p>
    </footer>
  );
}

export function LandingFooter() {
  return (
    <footer className="bg-[#0f172a] border-t border-white/10">
      <div className="container mx-auto px-6 md:px-10 py-7">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-[2fr_1fr_1fr_1fr] md:gap-x-0 md:gap-y-0 items-stretch">

          {/* Colonne logo + baseline */}
          <div className="public-page col-span-2 md:col-span-1 flex flex-col gap-3">
            <a href={publicSiteUrl("/")}>
              <Logo size={42} withText={true} withBaseline={true} />
            </a>
            <p className="text-xs text-white/30 mt-auto pt-4">
              © {new Date().getFullYear()} Verebona. Tous droits réservés.
            </p>
          </div>

          {/* Colonnes liens */}
          {COLUMNS.map((col) => (
            <div key={col.title} className="md:pl-8">
              <p className="text-xs font-bold tracking-widest uppercase text-white mb-3">
                {col.title}
              </p>
              <ul className="space-y-1.5">
                {col.links.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={resolveHref(link)}
                      className="text-sm text-white/55 hover:text-white transition-colors"
                    >
                      {link.label}
                    </Link>
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
