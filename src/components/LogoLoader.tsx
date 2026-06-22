'use client';

interface LogoLoaderProps {
  size?: number;
}

/**
 * Loader Verebona — le carré bleu orbite autour de la grille 3×3
 */
export function LogoLoader({ size = 48 }: LogoLoaderProps) {
  const unit = size / 3.5;
  const gap = unit * 0.25;
  const r = unit * 0.17;
  const gridTotal = unit * 3 + gap * 2;

  // Centre de la grille
  const cx = gridTotal / 2;
  const cy = gridTotal / 2;

  // Rayon de l'orbite : distance du centre au coin supérieur droit + demi-carré
  const orbitR = Math.sqrt(cx * cx + cy * cy) * 0.92;

  return (
    <div className="flex flex-col items-center justify-center gap-4">
      <svg
        width={gridTotal + orbitR * 2}
        height={gridTotal + orbitR * 2}
        viewBox={`${-orbitR} ${-orbitR} ${gridTotal + orbitR * 2} ${gridTotal + orbitR * 2}`}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ overflow: 'visible' }}
      >
        {/* Grille 3×3 — carrés gris/blanc selon le thème */}
        {/* Rangée 1 */}
        <rect x={0}          y={0}          width={unit} height={unit} rx={r} className="fill-[color:var(--text-muted)] opacity-20" />
        <rect x={unit + gap} y={0}          width={unit} height={unit} rx={r} className="fill-[color:var(--text-muted)] opacity-20" />
        {/* Rangée 2 */}
        <rect x={0}                y={unit + gap} width={unit} height={unit} rx={r} className="fill-[color:var(--text-muted)] opacity-20" />
        <rect x={unit + gap}       y={unit + gap} width={unit} height={unit} rx={r} className="fill-[color:var(--text-muted)] opacity-20" />
        <rect x={(unit + gap) * 2} y={unit + gap} width={unit} height={unit} rx={r} className="fill-[color:var(--text-muted)] opacity-20" />
        {/* Rangée 3 */}
        <rect x={0}                y={(unit + gap) * 2} width={unit} height={unit} rx={r} className="fill-[color:var(--text-muted)] opacity-20" />
        <rect x={unit + gap}       y={(unit + gap) * 2} width={unit} height={unit} rx={r} className="fill-[color:var(--text-muted)] opacity-20" />
        <rect x={(unit + gap) * 2} y={(unit + gap) * 2} width={unit} height={unit} rx={r} className="fill-[color:var(--text-muted)] opacity-20" />

        {/* Carré bleu en orbite */}
        <g style={{ transformOrigin: `${cx}px ${cy}px`, animation: 'verebona-orbit 1.4s linear infinite' }}>
          {/* Positionné au "12h" de l'orbite, décalé du centre */}
          <rect
            x={cx - unit / 2}
            y={cy - orbitR - unit / 2}
            width={unit}
            height={unit}
            rx={r}
            fill="#3B82F6"
            style={{ transformOrigin: `${cx}px ${cy - orbitR}px`, animation: 'verebona-square-spin 1.4s linear infinite' }}
          />
        </g>

        <style>{`
          @keyframes verebona-orbit {
            from { transform: rotate(0deg); }
            to   { transform: rotate(360deg); }
          }
          @keyframes verebona-square-spin {
            from { transform: rotate(18deg); }
            to   { transform: rotate(378deg); }
          }
        `}</style>
      </svg>
    </div>
  );
}
