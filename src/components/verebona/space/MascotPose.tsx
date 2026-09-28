'use client';
/**
 * Mascotte posée — Direction D v2 §12bis.
 *
 * Immobile ; l'animation d'arrivée est jouée au premier affichage, puis
 * rejouée une seule fois à chaque changement de pose (alternance de deux
 * keyframes identiques). Mouvement réduit : aucune animation.
 */
import { useRef } from 'react';
import { mascotSrc, nextPoseMotion, poseAnimation, type PoseMotionState } from '@/lib/verebona/mascot-motion';
import { useReducedMotion } from '@/hooks/useMediaQuery';

interface MascotPoseProps {
  pose: string;
  size: number;
  /** Texte alternatif ; vide quand la mascotte est décorative. */
  alt?: string;
  className?: string;
  style?: React.CSSProperties;
  /** Signature statique (24–26 px devant un titre) : jamais animée. */
  still?: boolean;
  priority?: boolean;
}

export function MascotPose({ pose, size, alt = '', className, style, still = false, priority = false }: MascotPoseProps) {
  const reduced = useReducedMotion();
  const motion = useRef<PoseMotionState | null>(null);
  motion.current = nextPoseMotion(motion.current, pose);
  const animation = still ? 'none' : poseAnimation(motion.current, reduced);
  return (
    // eslint-disable-next-line @next/next/no-img-element -- rendu WebP pré-dimensionné, animation CSS sur l'élément
    <img
      src={mascotSrc(pose)}
      alt={alt}
      aria-hidden={alt ? undefined : true}
      width={size}
      height={size}
      draggable={false}
      loading={priority ? 'eager' : 'lazy'}
      decoding="async"
      className={className}
      style={{ width: size, height: size, objectFit: 'contain', flexShrink: 0, userSelect: 'none', animation, ...style }}
    />
  );
}
