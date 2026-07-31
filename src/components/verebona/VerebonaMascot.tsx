'use client';

/**
 * Mascotte Verebona — CDC §34.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ELLE EST FAITE DE LA GRILLE DU LOGO
 *
 * Le logo est une grille de neuf carrés dont un, bleu, se détache vers le haut
 * avec une inclinaison de 18°. La mascotte reprend ce vocabulaire : corps carré
 * aux mêmes angles arrondis, membres en petits carrés, même bleu `#3B82F6`.
 *
 * Aucun élément étranger — ni bec, ni plumes. Verebona parle de patrimoine, de
 * documents, d'échéances ; un animal y apporterait un registre qui n'est pas
 * le sien, et le hibou provisoire ne venait d'aucune part.
 *
 * ── LE §34.3 EST RESPECTÉ ─────────────────────────────────────────────────
 *
 * · mascotte ENTIÈRE — corps, bras, jambes, jamais une tête isolée ;
 * · pas de doigt pointé vers le texte : les bras restent le long du corps ou
 *   tiennent un objet ;
 * · le texte se place à droite, la mascotte ne l'enjambe pas.
 *
 * ── CE QUI RESTE UN LIVRABLE UX ───────────────────────────────────────────
 *
 * Le §34.1 attend une bibliothèque : masters PNG, variantes WebP, manifest,
 * rapport de transparence. Ceci est une mascotte VECTORIELLE, cohérente et
 * utilisable tout de suite — pas cette bibliothèque.
 *
 * Le contrat de poses est conservé à l'identique : le jour où les visuels
 * définitifs arrivent, seul le rendu change.
 * ══════════════════════════════════════════════════════════════════════════
 */

export type MascotPose = 'idle' | 'thinking' | 'success' | 'empty' | 'error';

const POSE_LABEL: Record<MascotPose, string> = {
  idle: 'Verebona',
  thinking: 'Verebona réfléchit',
  success: 'Verebona a trouvé',
  empty: 'Verebona n’a rien trouvé',
  error: 'Verebona rencontre un souci',
};

const BLEU = '#3B82F6';
const ENCRE = '#0F172A';

/** Posture par pose : inclinaison, regard, accessoire. */
const POSTURES: Record<
  MascotPose,
  { tilt: number; gaze: number; eyes: 'open' | 'squint' | 'flat'; prop: 'none' | 'loupe' | 'check' }
> = {
  idle: { tilt: 6, gaze: 0, eyes: 'open', prop: 'none' },
  // 18° : l'inclinaison exacte du carré bleu dans le logo.
  thinking: { tilt: 18, gaze: 2, eyes: 'open', prop: 'none' },
  success: { tilt: -6, gaze: 0, eyes: 'squint', prop: 'check' },
  empty: { tilt: -14, gaze: -2, eyes: 'open', prop: 'loupe' },
  error: { tilt: -20, gaze: -2, eyes: 'flat', prop: 'none' },
};

function Yeux({ eyes, gaze }: { eyes: 'open' | 'squint' | 'flat'; gaze: number }) {
  if (eyes === 'squint') {
    return (
      <>
        <path d="M14 25 q3.5 -4 7 0" fill="none" stroke={ENCRE} strokeWidth="2.4" strokeLinecap="round" />
        <path d="M27 25 q3.5 -4 7 0" fill="none" stroke={ENCRE} strokeWidth="2.4" strokeLinecap="round" />
      </>
    );
  }
  if (eyes === 'flat') {
    // Perplexité, sans détresse : une erreur informe, elle n'apitoie pas.
    return (
      <>
        <rect x={14 + gaze} y="25" width="7" height="2.6" rx="1.3" fill={ENCRE} />
        <rect x={27 + gaze} y="25" width="7" height="2.6" rx="1.3" fill={ENCRE} />
      </>
    );
  }
  return (
    <>
      <rect x={15 + gaze} y="22" width="6" height="8" rx="2" fill={ENCRE} />
      <rect x={27 + gaze} y="22" width="6" height="8" rx="2" fill={ENCRE} />
    </>
  );
}

export function VerebonaMascot({
  pose = 'idle',
  size = 28,
  className = '',
}: {
  pose?: MascotPose;
  size?: number;
  className?: string;
}) {
  const p = POSTURES[pose];

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 60"
      fill="none"
      role="img"
      aria-label={POSE_LABEL[pose]}
      className={`select-none ${className}`}
    >
      {/* Jambes — mêmes angles arrondis que le corps. */}
      <rect x="14" y="45" width="7" height="10" rx="2.4" fill={BLEU} opacity="0.75" />
      <rect x="27" y="45" width="7" height="10" rx="2.4" fill={BLEU} opacity="0.75" />

      <g transform={`rotate(${p.tilt}, 24, 28)`}>
        {/* Bras le long du corps : le §34.3 exclut le doigt pointé. */}
        <rect x="2" y="26" width="7" height="16" rx="2.4" fill={BLEU} opacity="0.75" />
        <rect x="39" y="26" width="7" height="16" rx="2.4" fill={BLEU} opacity="0.75" />

        {/* Corps — le carré du logo. */}
        <rect x="7" y="10" width="34" height="36" rx="6" fill={BLEU} />

        {/* Les yeux contre-tournent : le corps s'incline, le regard reste
            droit. C'est ce décalage qui fait un être plutôt qu'une forme. */}
        <g transform={`rotate(${-p.tilt}, 24, 26)`}>
          <Yeux eyes={p.eyes} gaze={p.gaze} />
        </g>

        {p.prop === 'loupe' && (
          <g transform="translate(36, 30)">
            <circle cx="0" cy="0" r="6.5" fill="none" stroke={ENCRE} strokeWidth="2.2" />
            <line x1="4.6" y1="4.6" x2="9" y2="9" stroke={ENCRE} strokeWidth="2.2" strokeLinecap="round" />
          </g>
        )}

        {p.prop === 'check' && (
          <path
            d="M33 36 l3.5 3.5 L44 32"
            fill="none"
            stroke={ENCRE}
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </g>
    </svg>
  );
}
