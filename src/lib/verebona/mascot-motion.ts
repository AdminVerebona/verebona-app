/**
 * Animation de la mascotte — Direction D v2 §12bis.
 *
 * La mascotte ne bouge que lorsqu'il se passe quelque chose : à son arrivée,
 * puis une seule fois à chaque CHANGEMENT de pose. Deux keyframes identiques
 * (`vb-pose-a`, `vb-pose-b`) alternent : changer le nom de l'animation suffit
 * à la rejouer sans recréer l'élément. Si la pose ne change pas, rien ne bouge.
 *
 * Mouvement réduit : aucune animation, la pose change instantanément.
 */

export interface PoseMotionState {
  pose: string;
  flip: boolean;
}

/** État suivant : l'alternance ne bascule que si la pose change. */
export function nextPoseMotion(prev: PoseMotionState | null, pose: string): PoseMotionState {
  if (!prev) return { pose, flip: false };
  if (prev.pose === pose) return prev;
  return { pose, flip: !prev.flip };
}

export const POSE_EASING = 'cubic-bezier(.16,1,.3,1)';
export const POSE_DURATION_S = 0.55;

/** Valeur CSS `animation` à appliquer (ou `none` en mouvement réduit). */
export function poseAnimation(state: PoseMotionState, reducedMotion: boolean): string {
  if (reducedMotion) return 'none';
  return `${state.flip ? 'vb-pose-b' : 'vb-pose-a'} ${POSE_DURATION_S}s ${POSE_EASING} both`;
}

/** Chemin public d'une pose. */
export function mascotSrc(pose: string): string {
  return `/mascot/${pose}.webp`;
}

/**
 * Filtre CSS de la mascotte — charte « Sérénité » 2026 §4 (lot 66).
 *
 * Recoloration cyan PROVISOIRE (`--vb-mascotte-filtre`, globals.css) en
 * attendant les fichiers recolorés à la source. Un filtre de l'appelant est
 * ajouté APRÈS, jamais à la place : aucune occurrence n'échappe à la teinte.
 */
export const MASCOT_FILTER_VAR = 'var(--vb-mascotte-filtre)';

export function mascotFilter(extra?: string | number | null): string {
  const e = extra == null ? '' : String(extra).trim();
  return e && e !== 'none' ? `${MASCOT_FILTER_VAR} ${e}` : MASCOT_FILTER_VAR;
}
