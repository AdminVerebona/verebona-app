import React from 'react';

interface LogoProps {
  size?: number;
  withText?: boolean;
  withBaseline?: boolean;
  className?: string;
}

/**
 * Logo Verebona — charte « Sérénité » 2026 §3 (lot 66).
 *
 * Géométrie du header public (`viewBox 0 0 32 32`, cases 9,14, rayon 1,6, pas
 * 11,43) : grille 3 × 3 de 8 cases fixes + la case d'accent, cuivre doux
 * `#D66B53`, tournée de 18° en haut à droite. Cases et mot-symbole pétrole
 * `#17474D` sur fond clair, ivoire `#F8F6F1` / `#F3F1EB` sur fond sombre :
 * la couleur suit le thème par les jetons `--vb-logo-cells` et
 * `--vb-logo-text` (globals.css), y compris sur les pages publiques
 * (`.public-page`, qui suivent le thème depuis le lot 67). Mot-symbole
 * Figtree 700, −0,02 em.
 *
 * Même rendu que `assets/logo-petrole.svg` / `logo-ivoire.svg` du design
 * system. Taille : 24 px dans l'application, 34 px sur le site.
 */
const CELLS: Array<[number, number]> = [
  [0, 0], [11.43, 0],
  [0, 11.43], [11.43, 11.43], [22.86, 11.43],
  [0, 22.86], [11.43, 22.86], [22.86, 22.86],
];

const LOGO_CUBE_COLOR = '#D66B53';

export function Logo({
  size = 40,
  withText = true,
  withBaseline = false,
  className = '',
}: LogoProps) {
  const textSize = Math.round(size * 0.8 * 10) / 10;
  const baselineSize = size * 0.35;

  return (
    <div className={`flex items-center ${className}`} style={{ gap: Math.round(size * 0.42) }} data-logo="verebona">
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ overflow: 'visible', flexShrink: 0 }}
        aria-hidden="true"
      >
        {CELLS.map(([x, y]) => (
          <rect key={`${x}-${y}`} x={x} y={y} width="9.14" height="9.14" rx="1.6" style={{ fill: 'var(--vb-logo-cells, #17474D)' }} />
        ))}
        {/* Case d'accent : cuivre doux, tournée de 18° (jamais animée). */}
        <rect x="22.86" y="-1.55" width="9.14" height="9.14" rx="1.6" fill={LOGO_CUBE_COLOR} transform="rotate(18 27.43 3.02)" />
      </svg>

      <div
        className={`flex flex-col transition-opacity duration-[180ms] ${
          withText ? 'opacity-100' : 'opacity-0 w-0 pointer-events-none'
        }`}
      >
        <span
          className="leading-none whitespace-nowrap"
          style={{ fontSize: `${textSize}px`, fontWeight: 700, letterSpacing: '-.02em', color: 'var(--vb-logo-text, #17474D)' }}
        >
          Verebona
        </span>
        {withBaseline && (
          <span
            className="mt-1 whitespace-nowrap text-[color:var(--text-muted)]"
            style={{ fontSize: `${baselineSize}px` }}
          >
            One place. Higher value.
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Variante avec baseline pour landing et pages auth
 */
export function LogoWithBaseline({ size = 50, className = '' }: { size?: number; className?: string }) {
  return <Logo size={size} withText={true} withBaseline={true} className={className} />;
}
