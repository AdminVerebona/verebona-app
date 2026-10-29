/**
 * Interrupteurs serveur des fonctions mobiles vus par l'app — lot 95 (CDC 12
 * API-08, OBS-05 ; `MOBILE_FEATURES_OFF` / `GET /api/mobile/config`, lot 97).
 *
 * Renseignés par l'hôte natif à chaque lecture de la configuration ; tant
 * qu'elle n'est pas lue, une fonction est active (défaut serveur). Une coupure
 * serveur s'applique dès la lecture suivante, sans nouvelle version de l'app.
 */
let features: Record<string, boolean> | null = null;

export function setNativeFeatures(f: Record<string, boolean> | null): void {
  features = f;
}

export function nativeFeatureOn(name: string): boolean {
  return features ? features[name] !== false : true;
}

/** Forme du retour Google / Apple annoncée par le serveur (`auth.appOAuthReturn`). */
let oauthReturn: 'https' | 'scheme' | null = null;

export function setNativeOAuthReturn(kind: unknown): void {
  oauthReturn = kind === 'https' || kind === 'scheme' ? kind : null;
}

export function nativeOAuthReturn(): 'https' | 'scheme' | null {
  return oauthReturn;
}
