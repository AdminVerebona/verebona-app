import Link from 'next/link';
import { Logo } from './Logo';

const COLUMNS = [
  {
    title: 'Produit',
    links: [
      { href: '/pourquoi-verebona', label: 'Pourquoi Verebona ?' },
      { href: '/comment-ca-marche', label: 'Comment ça marche ?' },
      { href: '/#pricing',          label: 'Tarifs' },
    ],
  },
  {
    title: 'Support',
    links: [
      { href: '/#faq',   label: 'FAQ' },
      { href: '/aide',   label: "Centre d'aide" },
      { href: '/contact', label: 'Contact' },
    ],
  },
  {
    title: 'Légal',
    links: [
      { href: '/legal',                     label: 'Mentions légales' },
      { href: '/cgsu',                      label: 'CGSU' },
      { href: '/politique-confidentialite', label: 'Confidentialité' },
    ],
  },
];

export function AuthFooter() {
  return (
    <footer className="py-4 px-6 text-center">
      <p className="text-xs text-white/30">
        © {new Date().getFullYear()} Verebona. Tous droits réservés.
        {' · '}
        <Link href="/legal" className="hover:text-white/60 transition-colors">Mentions légales</Link>
        {' · '}
        <Link href="/politique-confidentialite" className="hover:text-white/60 transition-colors">Confidentialité</Link>
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
            <Link href="/">
              <Logo size={42} withText={true} withBaseline={true} />
            </Link>
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
                      href={link.href}
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
