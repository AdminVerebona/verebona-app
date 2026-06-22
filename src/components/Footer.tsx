import Link from 'next/link';

const LINKS = [
  { href: '/legal',                    label: 'Mentions légales' },
  { href: '/cgsu',                     label: 'CGSU' },
  { href: '/politique-confidentialite', label: 'Confidentialité' },
  { href: '/contact',                  label: 'Contact' },
  { href: '/aide',                     label: 'Centre d\'aide' },
];

export function Footer() {
  return (
    <footer className="border-t border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] mt-auto">
      <div className="container mx-auto px-4 md:px-6 py-4 md:py-6">

        {/* Desktop : une seule ligne */}
        <div className="hidden md:flex items-center justify-between gap-4">
          <span className="text-sm text-[color:var(--text-muted)]">© 2025 Verebona</span>
          <div className="flex items-center gap-6 text-sm">
            {LINKS.map(l => (
              <Link key={l.href} href={l.href} className="text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] transition-colors">
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
                href={l.href}
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