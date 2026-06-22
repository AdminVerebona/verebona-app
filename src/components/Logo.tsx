import React from 'react';

interface LogoProps {
  size?: number;
  withText?: boolean;
  withBaseline?: boolean;
  className?: string;
}

/**
 * Logo Verebona — fidèle au SVG officiel /public/brand/verebona-logo.svg
 * Grille 3x3 de carrés anthracite (avec trou en haut à droite)
 * + carré bleu légèrement relevé avec rotation +18°
 */
export function Logo({
  size = 40,
  withText = true,
  withBaseline = false,
  className = '',
}: LogoProps) {
  const unit = size / 3.5;     // taille d'un carré
  const gap = unit * 0.25;     // espace entre carrés
  const r = unit * 0.17;       // border-radius relatif
  const gridTotal = unit * 3 + gap * 2;

  const textSize = size * 0.9;
  const baselineSize = size * 0.35;

  // Offset du carré bleu : légèrement relevé (vers le haut) et à la même colonne 3
  const blueX = (unit + gap) * 2;
  const blueY = -(unit * 0.17);   // légèrement au-dessus de la rangée 1
  const cx = blueX + unit / 2;
  const cy = blueY + unit / 2;

  return (
    <div className={`flex items-center gap-3 ${className}`}>
      {/* Symbole SVG */}
      <svg
        width={gridTotal}
        height={gridTotal}
        viewBox={`0 0 ${gridTotal} ${gridTotal}`}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ overflow: 'visible', flexShrink: 0 }}
      >
        {/* Rangée 1 — col 1 & 2 (col 3 = trou pour le carré bleu) */}
        <rect x={0}           y={0}           width={unit} height={unit} rx={r} className="fill-white [.theme-beige_&]:fill-[#2F3941] [.public-page_&]:fill-white" />
        <rect x={unit + gap}  y={0}           width={unit} height={unit} rx={r} className="fill-white [.theme-beige_&]:fill-[#2F3941] [.public-page_&]:fill-white" />

        {/* Rangée 2 — toutes les colonnes */}
        <rect x={0}                   y={unit + gap} width={unit} height={unit} rx={r} className="fill-white [.theme-beige_&]:fill-[#2F3941] [.public-page_&]:fill-white" />
        <rect x={unit + gap}          y={unit + gap} width={unit} height={unit} rx={r} className="fill-white [.theme-beige_&]:fill-[#2F3941] [.public-page_&]:fill-white" />
        <rect x={(unit + gap) * 2}    y={unit + gap} width={unit} height={unit} rx={r} className="fill-white [.theme-beige_&]:fill-[#2F3941] [.public-page_&]:fill-white" />

        {/* Rangée 3 — toutes les colonnes */}
        <rect x={0}                   y={(unit + gap) * 2} width={unit} height={unit} rx={r} className="fill-white [.theme-beige_&]:fill-[#2F3941] [.public-page_&]:fill-white" />
        <rect x={unit + gap}          y={(unit + gap) * 2} width={unit} height={unit} rx={r} className="fill-white [.theme-beige_&]:fill-[#2F3941] [.public-page_&]:fill-white" />
        <rect x={(unit + gap) * 2}    y={(unit + gap) * 2} width={unit} height={unit} rx={r} className="fill-white [.theme-beige_&]:fill-[#2F3941] [.public-page_&]:fill-white" />

        {/* Carré bleu — légèrement relevé, rotation +18° autour de son centre */}
        <rect
          x={blueX}
          y={blueY}
          width={unit}
          height={unit}
          rx={r}
          fill="#3B82F6"
          transform={`rotate(18, ${cx}, ${cy})`}
        />
      </svg>

      {/* Texte */}
      <div
        className={`flex flex-col transition-all duration-700 ease-in-out ${
          withText ? 'opacity-100 translate-x-0' : 'opacity-0 -translate-x-8 w-0 pointer-events-none'
        }`}
      >
        <span
          className="font-semibold text-white [.theme-beige_&]:text-[#2F3941] [.public-page_&]:text-white leading-none whitespace-nowrap"
          style={{ fontSize: `${textSize}px` }}
        >
          Verebona
        </span>
        {withBaseline && (
          <span
            className="text-[#9CA3AF] [.theme-beige_&]:text-[#4B5563] [.public-page_&]:text-[#9CA3AF] mt-1 whitespace-nowrap"
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
