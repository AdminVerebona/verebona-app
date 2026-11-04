/*
 * Coque locale du mode distant — lot 108G. Aucune donnée métier.
 *   · réseau présent : ouverture de l'accueil de l'environnement (origine figée au build) ;
 *   · sinon : page « Connexion Internet indisponible ».
 * L'adresse vient UNIQUEMENT de `app-config.js` (généré au build) : jamais
 * d'un paramètre d'URL (aucune redirection ouverte).
 */
(function () {
  var cfg = window.VEREBONA_APP || {};
  var start = typeof cfg.startUrl === 'string' && /^https:\/\/[^/]+\/[^?#]*$/.test(cfg.startUrl) ? cfg.startUrl : null;
  if (start && navigator.onLine !== false) location.replace(start);
  else location.replace('offline.html');
})();
