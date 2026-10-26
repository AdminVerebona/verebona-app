/**
 * Vignette affichée d'un bien — lot 59, point 2 (module pur, client et
 * serveur).
 *
 * Le serveur fournit `effectiveThumbnailUrl` (vignette choisie, sinon la
 * première photo rattachée au bien — `services/assets/default-asset-photo`).
 * C'est la clé passée à `useThumbnailUrl` : la signature passe toujours par
 * `GET /api/assets/[id]/thumbnail`, qui applique la même règle. Une réponse
 * plus ancienne (sans le champ) retombe sur la vignette choisie.
 */
export function displayThumbnailKey(asset: { thumbnailUrl?: string | null; effectiveThumbnailUrl?: string | null } | null | undefined): string | null {
  if (!asset) return null;
  // La vignette choisie d'abord : une vignette changée sur la fiche (mise à
  // jour locale de `thumbnailUrl`) s'affiche sans attendre la relecture.
  return asset.thumbnailUrl || asset.effectiveThumbnailUrl || null;
}
