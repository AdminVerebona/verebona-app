'use client';
/**
 * Mascotte posée — Direction D v2 §12bis.
 *
 * Immobile ; l'animation d'arrivée est jouée au premier affichage, puis
 * rejouée une seule fois à chaque changement de pose (alternance de deux
 * keyframes identiques). Mouvement réduit : aucune animation.
 *
 * Charte « Sérénité » 2026 §4 (lot 66) : SEUL point de rendu des poses
 * `public/mascot/*.webp`. La recoloration cyan provisoire
 * (`--vb-mascotte-filtre`) est appliquée ici, à toutes les occurrences ; un
 * `filter` passé par l'appelant s'y AJOUTE (il ne la remplace jamais).
 */
import { useRef } from 'react';
import { mascotSrc, nextPoseMotion, poseAnimation, workingAnimation, type PoseMotionState } from '@/lib/verebona/mascot-motion';
import { useReducedMotion } from '@/hooks/useMediaQuery';
import { mascotFilter } from '@/lib/verebona/mascot-motion';

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
  /**
   * Lot 78C : la mascotte est « au travail » (analyse de documents) — léger
   * balancement continu ; aucun en mouvement réduit ni en signature statique.
   */
  working?: boolean;
}

export function MascotPose({ pose, size, alt = '', className, style, still = false, priority = false, working = false }: MascotPoseProps) {
  const reduced = useReducedMotion();
  const motion = useRef<PoseMotionState | null>(null);
  motion.current = nextPoseMotion(motion.current, pose);
  const animation = still ? 'none' : workingAnimation(poseAnimation(motion.current, reduced), working, reduced);
  const { filter: extraFilter, ...restStyle } = style ?? {};
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
      data-mascot-pose={pose}
      data-mascot-working={working && !still ? 'true' : undefined}
      className={['vb-mascotte', className].filter(Boolean).join(' ')}
      style={{
        width: size, height: size, objectFit: 'contain', flexShrink: 0, userSelect: 'none', animation,
        // Balancement « au travail » autour des pieds, pas du centre de l'image.
        ...(working && !still ? { transformOrigin: '50% 88%' } : {}),
        ...restStyle, filter: mascotFilter(extraFilter),
      }}
    />
  );
}
