/*
 * Sonde Gate 0 — mode B (interface embarquée), lot 95.
 * Avec CapacitorHttp activé (capacitor.config.ts, mode local), `fetch` passe par
 * la pile réseau native : pas de CORS, cookies dans le magasin natif.
 * On mesure, SANS modifier le serveur :
 *   · la lecture publique ;
 *   · la connexion (attendu aujourd'hui : refus CSRF « origine non reconnue »,
 *     la requête native n'ayant pas l'origine du site — voir la doc Gate 0) ;
 *   · la persistance des cookies HttpOnly entre deux lancements.
 * Le journal ne contient que statuts, codes et noms de cookies (jamais de valeur).
 */
(function () {
  var cfg = window.VEREBONA_APP || {};
  var origin = cfg.origin || '';
  var logEl = document.getElementById('log');
  document.getElementById('env').textContent = (cfg.appName || 'Verebona') + ' — ' + origin + ' — ' + (cfg.version || '') + ' (' + (cfg.build || '') + ')';

  function log(line) { logEl.textContent = new Date().toLocaleTimeString('fr-FR') + '  ' + line + '\n' + logEl.textContent; }
  function headers() {
    var cap = window.Capacitor;
    var platform = cap && cap.getPlatform ? cap.getPlatform() : 'web';
    return {
      'Content-Type': 'application/json',
      'X-Verebona-Client': platform === 'ios' ? 'IOS' : platform === 'android' ? 'ANDROID' : 'WEB',
      'X-Verebona-App-Version': cfg.version || '0.0.0',
      'X-Verebona-App-Build': String(cfg.build || '0')
    };
  }
  async function call(method, path, body) {
    try {
      var res = await fetch(origin + path, { method: method, credentials: 'include', headers: headers(), body: body ? JSON.stringify(body) : undefined });
      var text = await res.text();
      var code = '';
      try { var j = JSON.parse(text); code = j.code || (j.success === true ? 'success' : '') || ''; } catch (e) { /* non JSON */ }
      log(method + ' ' + path + ' → ' + res.status + (code ? ' ' + code : ''));
      await cookieNames();
    } catch (e) {
      log(method + ' ' + path + ' → échec réseau (' + (e && e.message ? e.message : 'inconnu') + ')');
    }
  }
  async function cookieNames() {
    var c = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorCookies;
    if (!c || !c.getCookies) return;
    try {
      var all = await c.getCookies({ url: origin });
      log('   cookies présents : ' + (Object.keys(all || {}).join(', ') || 'aucun'));
    } catch (e) { /* plugin indisponible */ }
  }
  document.getElementById('t-config').onclick = function () { call('GET', '/api/mobile/config'); };
  document.getElementById('t-me').onclick = function () { call('GET', '/api/auth/me'); };
  document.getElementById('t-refresh').onclick = function () { call('POST', '/api/auth/refresh'); };
  document.getElementById('t-logout').onclick = function () { call('POST', '/api/auth/logout'); };
  document.getElementById('login').onsubmit = function (ev) {
    ev.preventDefault();
    var f = ev.target;
    call('POST', '/api/auth/login', { email: f.email.value, password: f.password.value });
    f.password.value = '';
  };
  cookieNames();
})();
