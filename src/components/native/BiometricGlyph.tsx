/**
 * Symboles biométriques de la proposition d'activation — lot 111G.
 *
 * Dessins propres à Verebona (traits arrondis, couleur de la charte via
 * `currentColor`), dans l'esprit des symboles système (cadre de visée,
 * empreinte) sans reprendre un logo ni une image d'un tiers. Décoratifs :
 * le titre de la modale nomme toujours la biométrie proposée.
 */
import type { BiometricOfferKind } from '@/lib/native/biometric-offer-presentation';

const FRAME = 'M3.5 8V6a2.5 2.5 0 0 1 2.5-2.5h2M16 3.5h2A2.5 2.5 0 0 1 20.5 6v2M20.5 16v2a2.5 2.5 0 0 1-2.5 2.5h-2M8 20.5H6A2.5 2.5 0 0 1 3.5 18v-2';

const FINGERPRINT = [
  'M12 4.5a7.5 7.5 0 0 1 7.5 7.5v1.2',
  'M4.5 14.8V12a7.5 7.5 0 0 1 3.3-6.2',
  'M7.6 18.6c.8-1.7 1.2-3.6 1.2-5.6V12a3.2 3.2 0 0 1 6.4 0v1.4',
  'M12 12v1.2c0 2.9-.7 5.5-2.1 7.6',
  'M15.1 16.6c-.2 1.3-.6 2.6-1.2 3.8',
  'M18.7 16.4c-.2.9-.5 1.8-.8 2.6',
];

interface Props {
  kind: BiometricOfferKind;
  className?: string;
}

export function BiometricGlyph({ kind, className }: Props) {
  const common = {
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
    strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
    className, 'aria-hidden': true, focusable: false, 'data-glyph': kind,
  };
  if (kind === 'touch-id' || kind === 'fingerprint') {
    return <svg {...common}>{FINGERPRINT.map((d) => <path key={d} d={d} />)}</svg>;
  }
  if (kind === 'face-id' || kind === 'face') {
    return (
      <svg {...common}>
        <path d={FRAME} />
        <circle cx="9.2" cy="10.2" r="0.9" fill="currentColor" stroke="none" />
        <circle cx="14.8" cy="10.2" r="0.9" fill="currentColor" stroke="none" />
        <path d="M9 14.6c1.7 1.5 4.3 1.5 6 0" />
      </svg>
    );
  }
  if (kind === 'iris') {
    return (
      <svg {...common}>
        <path d={FRAME} />
        <path d="M6.5 12s2-3.6 5.5-3.6 5.5 3.6 5.5 3.6-2 3.6-5.5 3.6S6.5 12 6.5 12z" />
        <circle cx="12" cy="12" r="1.7" />
      </svg>
    );
  }
  // Générique « biométrie » : cadre de visée + petite empreinte.
  return (
    <svg {...common}>
      <path d={FRAME} />
      <g transform="translate(6.6 6.6) scale(0.45)">
        {FINGERPRINT.map((d) => <path key={d} d={d} strokeWidth={3.4} />)}
      </g>
    </svg>
  );
}
