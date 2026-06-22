"use client";

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Logo } from '@/components/Logo';
import { Button } from '@/components/ui/button';
import { Menu, X } from 'lucide-react';

const NAV_LINKS = [
  { href: '/pourquoi-verebona', label: 'Pourquoi Verebona ?' },
  { href: '/comment-ca-marche', label: 'Comment ça marche ?' },
  { href: '/#features',         label: 'Fonctionnalités' },
  { href: '/#pricing',          label: 'Tarifs' },
  { href: '/#faq',              label: 'FAQ' },
];

export function Header() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const pathname = usePathname();
  const isLanding = pathname === '/';

  const linkClass = "hover:text-[color:var(--text-primary)] transition-colors relative after:absolute after:left-0 after:bottom-[-2px] after:w-0 after:h-[2px] after:bg-gradient-to-r after:from-[#3b82f6] after:to-[#22c55e] after:rounded-full after:transition-all hover:after:w-full";

  return (
    <header className="fixed md:sticky top-0 left-0 right-0 z-40 pt-[env(safe-area-inset-top)]">
      <div className="container mx-auto px-4 md:px-6">
        <div className="flex items-center justify-between py-4 gap-4">
          <Link href="/" className="flex items-center flex-shrink-0">
            <Logo size={32} withText={true} withBaseline={false} />
          </Link>

          <nav className="hidden md:flex items-center gap-6 text-sm text-[color:var(--text-muted)]">
            {NAV_LINKS.map(({ href, label }) => {
              const isAnchor = href.startsWith('/#');
              const resolvedHref = isAnchor && !isLanding ? `/${href.slice(1)}` : href;
              return isAnchor ? (
                <a key={href} href={resolvedHref} className={linkClass}>{label}</a>
              ) : (
                <Link key={href} href={resolvedHref} className={linkClass}>{label}</Link>
              );
            })}
          </nav>

          <div className="flex items-center gap-2 md:gap-3 flex-shrink-0">
            <Link href="/login" className="hidden sm:inline-block">
              <Button variant="outline" className="text-xs md:text-sm px-3 md:px-4">
                Se connecter
              </Button>
            </Link>
            <Link href="/#pricing" className="hidden sm:inline-block">
              <Button className="rounded-full bg-gradient-to-br from-[#3b82f6] to-[#1d4ed8] hover:shadow-[0_18px_40px_rgba(37,99,235,0.45)] transition-all hover:translate-y-[-1px] text-xs md:text-sm px-3 md:px-4">
                Créer votre compte
              </Button>
            </Link>

            <Button
              variant="ghost"
              size="icon"
              className="md:hidden rounded-full border border-[rgba(31,41,55,0.8)] bg-[rgba(15,23,42,0.8)]"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            >
              {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </Button>
          </div>
        </div>

        {/* Mobile Menu */}
        {mobileMenuOpen && (
          <div className="md:hidden pb-4 border-t border-[rgba(31,41,55,0.5)] mt-4 pt-4 bg-[#020b1a] rounded-b-xl">
            <nav className="flex flex-col gap-4">
              {NAV_LINKS.map(({ href, label }) => {
                const isAnchor = href.startsWith('/#');
                const resolvedHref = isAnchor && !isLanding ? `/${href.slice(1)}` : href;
                return isAnchor ? (
                  <a key={href} href={resolvedHref} className="text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] transition-colors py-2" onClick={() => setMobileMenuOpen(false)}>{label}</a>
                ) : (
                  <Link key={href} href={resolvedHref} className="text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] transition-colors py-2" onClick={() => setMobileMenuOpen(false)}>{label}</Link>
                );
              })}
              <div className="flex flex-col gap-2 pt-4 border-t border-[rgba(31,41,55,0.5)]">
                <Link href="/login" onClick={() => setMobileMenuOpen(false)}>
                  <Button variant="outline" className="w-full">Se connecter</Button>
                </Link>
                <Link href="/#pricing" onClick={() => setMobileMenuOpen(false)}>
                  <Button className="w-full rounded-full bg-gradient-to-br from-[#3b82f6] to-[#1d4ed8] hover:shadow-[0_18px_40px_rgba(37,99,235,0.45)] transition-all hover:translate-y-[-1px]">
                    Créer votre compte
                  </Button>
                </Link>
              </div>
            </nav>
          </div>
        )}
      </div>
    </header>
  );
}
