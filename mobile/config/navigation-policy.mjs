/**
 * Politique de navigation de la WebView — lot 108G (décision PO du 03/11/2026 :
 * interface distante = cible V1 iOS / Android).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE ORIGINE A ACCÈS AU PONT NATIF
 *
 * La vue de l'application charge l'interface depuis le serveur de
 * l'environnement (origine figée au build, `environments.mjs`). Ce module
 * PUR décrit ce que la vue a le droit d'ouvrir ; il est appliqué en natif par
 *   · iOS     : `mobile/ios/App/App/VerebonaNavigationGuard.swift` (plugin local,
 *               consulté par Capacitor AVANT sa propre règle — `shouldOverrideLoad`) ;
 *   · Android : `mobile/android/app/src/main/java/fr/verebona/app/VerebonaNavigationGuardPlugin.java`
 *               (même crochet `shouldOverrideLoad`).
 * Les deux implémentations reprennent CE tableau ; `test/l108g-mode-distant.test.mjs`
 * vérifie la politique et la présence des mêmes règles dans le code natif.
 *
 * Pourquoi un garde en plus de Capacitor :
 *   · iOS : la règle de Capacitor compare un PRÉFIXE de chaîne
 *     (`https://app.verebona.fr` accepte aussi `https://app.verebona.fr.exemple.com`)
 *     et laisse charger tout cadre (iframe) tiers — or le gestionnaire de
 *     messages du pont est joignable depuis n'importe quel cadre ;
 *   · Android : l'origine doit être EXACTE (schéma + hôte + port) ;
 *   · schémas dangereux (`javascript:`, `file:`, `intent:`, `content:`…) refusés.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Schémas remis au système (application Téléphone, Mail, SMS, Plans) dans la vue principale. */
export const SYSTEM_SCHEMES = Object.freeze(['mailto', 'tel', 'sms', 'geo', 'maps']);

/** Schémas internes au moteur web, admis dans un cadre secondaire (aperçu PDF `blob:` de l'origine). */
export const INTERNAL_FRAME_SCHEMES = Object.freeze(['about', 'blob', 'data']);

/**
 * @typedef {'allow' | 'external' | 'system' | 'block'} NavigationDecision
 *   allow    : chargée dans la vue (origine de l'environnement ou page locale de secours) ;
 *   external : ouverte dans le NAVIGATEUR du téléphone (Safari / Chrome), hors de l'app ;
 *   system   : remise au système (mailto:, tel:…) ;
 *   block    : refusée, rien ne s'ouvre.
 */

function originOf(u) {
  // `URL.origin` vaut "null" pour les schémas non hiérarchiques.
  return `${u.protocol}//${u.host}`;
}

/**
 * Décision pour une navigation (pure, testée).
 *
 * @param {string} raw         adresse demandée
 * @param {{ appOrigin: string, localOrigins?: readonly string[], mainFrame: boolean }} ctx
 *   appOrigin    : origine https de l'environnement (ex. https://app.verebona.fr)
 *   localOrigins : origines de la coque locale (capacitor://localhost, https://localhost)
 *   mainFrame    : navigation de la vue principale (sinon : cadre / iframe)
 * @returns {NavigationDecision}
 */
export function decideNavigation(raw, ctx) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return 'block';
  }
  const scheme = u.protocol.replace(/:$/, '').toLowerCase();
  const app = new URL(ctx.appOrigin);

  if (scheme === 'https' || scheme === 'http') {
    if (u.username || u.password) return 'block';
    if (scheme === 'https' && originOf(u) === originOf(app)) return 'allow';
    if ((ctx.localOrigins ?? []).includes(originOf(u))) return 'allow';
    // Domaine tiers : jamais dans la vue (ni page, ni cadre).
    return ctx.mainFrame ? 'external' : 'block';
  }
  // Coque locale iOS (`capacitor://localhost`) : page « Connexion Internet indisponible ».
  if (u.host && (ctx.localOrigins ?? []).includes(originOf(u))) return 'allow';
  if (!ctx.mainFrame && INTERNAL_FRAME_SCHEMES.includes(scheme)) return 'allow';
  if (ctx.mainFrame && scheme === 'about') return 'allow';
  if (ctx.mainFrame && scheme === 'blob') return 'allow'; // téléchargement généré par la page elle-même
  if (ctx.mainFrame && SYSTEM_SCHEMES.includes(scheme)) return 'system';
  return 'block';
}
