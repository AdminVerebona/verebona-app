/*
 * Page « Connexion Internet indisponible » — lot 108G.
 * Trois causes, un message clair chacune, jamais de donnée métier :
 *   · pas de réseau                → « Connexion Internet indisponible » + Réessayer (et reprise auto au retour du réseau) ;
 *   · réseau présent, serveur muet → « Service momentanément indisponible » + Réessayer ;
 *   · Android : WebView trop ancienne (sous `minWebViewVersion`) → mise à jour « Android System WebView ».
 * « Réessayer » ne vise QUE l'accueil de l'environnement (adresse figée au build).
 */
(function () {
  var cfg = window.VEREBONA_APP || {};
  var start = typeof cfg.startUrl === 'string' && /^https:\/\/[^/]+\/[^?#]*$/.test(cfg.startUrl) ? cfg.startUrl : null;
  var btn = document.getElementById('retry');
  var title = document.getElementById('title');
  var text = document.getElementById('text');
  var hint = document.getElementById('hint');

  function chromeMajor() {
    var m = /Chrome\/(\d+)/.exec(navigator.userAgent || '');
    return m ? parseInt(m[1], 10) : null;
  }
  var android = /Android/i.test(navigator.userAgent || '');
  var min = typeof cfg.minWebViewVersion === 'number' ? cfg.minWebViewVersion : null;
  var major = chromeMajor();
  var webviewTooOld = android && min !== null && major !== null && major < min;

  function render() {
    if (webviewTooOld) {
      title.textContent = 'Mise à jour nécessaire';
      text.textContent = 'Le composant « Android System WebView » de ce téléphone est trop ancien pour afficher Verebona en toute sécurité. Mettez-le à jour depuis Google Play (ou mettez à jour Chrome), puis réessayez.';
      return;
    }
    if (navigator.onLine === false) {
      title.textContent = 'Connexion Internet indisponible';
      text.textContent = 'Verebona a besoin d’Internet pour afficher vos biens et vos documents. Vérifiez votre connexion puis réessayez. Votre session est conservée.';
    } else {
      title.textContent = 'Service momentanément indisponible';
      text.textContent = 'Verebona ne répond pas pour le moment. Réessayez dans quelques instants. Votre session est conservée.';
    }
  }

  function retry() {
    if (!start) { hint.hidden = false; hint.textContent = 'Fermez puis rouvrez l’application.'; return; }
    if (navigator.onLine === false && !webviewTooOld) {
      render();
      hint.hidden = false;
      hint.textContent = 'Toujours pas de connexion. Nouvel essai automatique dès le retour du réseau.';
      return;
    }
    btn.disabled = true;
    location.replace(start);
  }

  render();
  btn.addEventListener('click', retry);
  // Reprise automatique au retour du réseau (sauf WebView trop ancienne : rien ne changerait).
  window.addEventListener('online', function () { if (!webviewTooOld) retry(); });
  window.addEventListener('offline', render);
})();
