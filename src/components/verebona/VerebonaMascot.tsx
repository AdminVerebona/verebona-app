'use client';
/**
 * Mascotte — CDC §34. Mapping pose → asset. Les visuels définitifs sont un livrable UX ;
 * ce composant fournit un placeholder accessible et le contrat de poses.
 */
export type MascotPose = 'idle' | 'thinking' | 'success' | 'empty' | 'error';

const POSE_LABEL: Record<MascotPose, string> = {
  idle: 'Verebona', thinking: 'Verebona réfléchit', success: 'Verebona a trouvé',
  empty: 'Verebona n’a rien trouvé', error: 'Verebona rencontre un souci',
};

export function VerebonaMascot({ pose = 'idle', size = 28 }: { pose?: MascotPose; size?: number }) {
  // TODO(CDC §34.2) : remplacer par l'asset réel (public/verebona/mascot-<pose>.svg).
  return (
    <span role="img" aria-label={POSE_LABEL[pose]} style={{ fontSize: size }} className="select-none leading-none">
      🦉
    </span>
  );
}
