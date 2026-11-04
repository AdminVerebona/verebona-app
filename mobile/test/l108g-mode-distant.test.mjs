/**
 * Lot 108G — interface distante = cible V1 iOS / Android (décision PO du 03/11/2026)
 * et extension de partage iOS intégrée au projet Xcode.
 * Tests du dossier mobile/ (`npm test`), sans Mac ni SDK Android : ils vérifient
 * la politique, les garde-fous de distribution, la STRUCTURE du projet Xcode
 * (analyse réelle du pbxproj) et la cohérence du code natif avec la politique.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDistribution, resolveBuildConfig, LOCAL_ORIGINS } from '../config/environments.mjs';
import { decideNavigation, SYSTEM_SCHEMES, INTERNAL_FRAME_SCHEMES } from '../config/navigation-policy.mjs';
import { inspectArtifact } from '../scripts/distribution-guard.mjs';
import { checkReadiness } from '../scripts/readiness.mjs';
import { generatedFiles } from '../scripts/prepare.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(resolve(here, '..', rel), 'utf8');
const PREPROD = { VEREBONA_ENV: 'preprod', VEREBONA_APP_ORIGIN: 'https://app.preprod.verebona.fr' };
const PROD = { VEREBONA_ENV: 'prod', VEREBONA_APP_ORIGIN: 'https://app.verebona.fr' };

// ── Politique de navigation ────────────────────────────────────────────────

test('L108G-NAV : seule l’origine EXACTE de l’environnement est chargée dans la vue', () => {
  const ctx = { appOrigin: 'https://app.verebona.fr', localOrigins: Object.values(LOCAL_ORIGINS), mainFrame: true };
  const frame = { ...ctx, mainFrame: false };
  assert.equal(decideNavigation('https://app.verebona.fr/accueil', ctx), 'allow');
  assert.equal(decideNavigation('https://app.verebona.fr/documents/12?x=1#a', frame), 'allow');
  // Préfixe trompeur, autre port, http, identifiants : jamais dans la vue.
  assert.equal(decideNavigation('https://app.verebona.fr.exemple.com/accueil', ctx), 'external');
  assert.equal(decideNavigation('https://app.verebona.fr:8443/', ctx), 'external');
  assert.equal(decideNavigation('http://app.verebona.fr/accueil', ctx), 'external');
  assert.equal(decideNavigation('https://user:pw@app.verebona.fr/', ctx), 'block');
  // Autres domaines : navigateur système (vue principale), refus (cadre).
  assert.equal(decideNavigation('https://www.verebona.fr/cguv', ctx), 'external');
  assert.equal(decideNavigation('https://js.stripe.com/v3', frame), 'block');
  assert.equal(decideNavigation('https://www.youtube.com/embed/x', frame), 'block');
  // Coque locale (page « Connexion Internet indisponible »).
  assert.equal(decideNavigation('capacitor://localhost/offline.html', ctx), 'allow');
  assert.equal(decideNavigation('https://localhost/offline.html', ctx), 'allow');
  // Schémas système et internes.
  assert.equal(decideNavigation('mailto:contact@verebona.fr', ctx), 'system');
  assert.equal(decideNavigation('tel:+33100000000', ctx), 'system');
  assert.equal(decideNavigation('blob:https://app.verebona.fr/uuid', frame), 'allow');
  assert.equal(decideNavigation('about:blank', frame), 'allow');
  // Schémas dangereux.
  for (const u of ['javascript:alert(1)', 'file:///etc/passwd', 'intent://x#Intent;end', 'content://x', 'fr.verebona.app:/oauth?handoff=x', 'data:text/html,<p>x</p>']) {
    assert.equal(decideNavigation(u, ctx), 'block', u);
  }
  assert.equal(decideNavigation('pas une url', ctx), 'block');
});

test('L108G-NAV-NATIF : iOS et Android appliquent la même politique, plugins enregistrés', () => {
  const swift = read('ios/App/App/VerebonaNavigationGuard.swift');
  const java = read('android/app/src/main/java/fr/verebona/app/VerebonaNavigationGuardPlugin.java');
  for (const s of SYSTEM_SCHEMES) { assert.match(swift, new RegExp(`"${s}"`)); assert.match(java, new RegExp(`"${s}"`)); }
  for (const s of INTERNAL_FRAME_SCHEMES) { assert.match(swift, new RegExp(`"${s}"`)); assert.match(java, new RegExp(`"${s}"`)); }
  assert.match(swift, /override public func shouldOverrideLoad\(_ navigationAction: WKNavigationAction\) -> NSNumber\?/);
  assert.match(swift, /isMainFrame/);
  assert.match(swift, /o == appOrigin/);
  assert.match(java, /public Boolean shouldOverrideLoad\(Uri url\)/);
  assert.match(java, /o\.equals\(appOrigin\)/);
  assert.match(read('ios/App/App/VerebonaBridgeViewController.swift'), /registerPluginInstance\(VerebonaNavigationGuardPlugin\(\)\)/);
  assert.match(read('ios/App/App/VerebonaBridgeViewController.swift'), /registerPluginInstance\(VerebonaShareInboxPlugin\(\)\)/);
  assert.match(read('android/app/src/main/java/fr/verebona/app/MainActivity.java'), /registerPlugin\(VerebonaNavigationGuardPlugin\.class\)/);
  const plist = read('ios/App/App/Info.plist');
  assert.match(plist, /<key>WKAppBoundDomains<\/key>\s*<array>\s*<string>\$\(VB_APP_BOUND_DOMAIN\)<\/string>\s*<string>localhost<\/string>/);
  assert.match(plist, /<key>VBAppGroup<\/key>\s*<string>\$\(VB_APP_GROUP\)<\/string>/);
});

// ── Garde-fous de distribution (CA02) ─────────────────────────────────────

test('L108G-DIST : sonde locale jamais en production ni vers TestFlight / Play', () => {
  assert.deepEqual(checkDistribution(resolveBuildConfig(PREPROD), { publish: true }), []);
  assert.deepEqual(checkDistribution(resolveBuildConfig(PROD), { publish: true }), []);
  assert.deepEqual(checkDistribution(resolveBuildConfig({ ...PREPROD, VEREBONA_UI_MODE: 'local' }), { publish: false }), [], 'sonde : compilation seule admise en préproduction');
  assert.equal(checkDistribution(resolveBuildConfig({ ...PREPROD, VEREBONA_UI_MODE: 'local' }), { publish: true }).length, 1);
  assert.equal(checkDistribution(resolveBuildConfig({ ...PROD, VEREBONA_UI_MODE: 'local' }), { publish: false }).length, 1);
  const env = { ...PROD, VEREBONA_UI_MODE: 'local', GOOGLE_SERVICES_JSON_BASE64: 'x', ANDROID_UPLOAD_KEYSTORE_BASE64: 'x', ANDROID_UPLOAD_KEYSTORE_PASSWORD: 'x', ANDROID_UPLOAD_KEY_ALIAS: 'x', ANDROID_UPLOAD_KEY_PASSWORD: 'x', PLAY_SERVICE_ACCOUNT_JSON: 'x' };
  const r = checkReadiness('android', env, { publish: true });
  assert.equal(r.ready, false);
  assert.ok(r.problems.some((p) => /Sonde technique/.test(p)));
  assert.equal(checkReadiness('android', { ...env, VEREBONA_UI_MODE: 'remote' }, { publish: true }).ready, true);
});

test('L108G-DIST : le BINAIRE est contrôlé avant envoi (config embarquée, sonde, débogage)', () => {
  const b = resolveBuildConfig(PROD);
  const okCap = { appId: 'fr.verebona.app', server: { url: 'https://app.verebona.fr', allowNavigation: [], cleartext: false }, plugins: { CapacitorHttp: { enabled: false } }, ios: { webContentsDebuggingEnabled: false }, android: { webContentsDebuggingEnabled: false } };
  const appCfg = generatedFiles(b)['www/app-config.js'];
  assert.deepEqual(inspectArtifact(okCap, ['index.html', 'offline.html', 'app-config.js', 'cordova.js'], appCfg, b), []);
  // Sonde embarquée, mauvaise adresse, débogage en prod, domaine en plus, autre environnement.
  const local = generatedFiles(resolveBuildConfig({ ...PROD, VEREBONA_UI_MODE: 'local' }))['sonde-b/app-config.js'];
  assert.ok(inspectArtifact({ ...okCap, server: {} }, ['index.html', 'probe'], local, b).length >= 3);
  assert.ok(inspectArtifact({ ...okCap, server: { ...okCap.server, url: 'https://app.verebona.fr/accueil' } }, ['offline.html'], appCfg, b).some((p) => /server\.url/.test(p)));
  assert.ok(inspectArtifact({ ...okCap, ios: { webContentsDebuggingEnabled: true } }, ['offline.html'], appCfg, b).some((p) => /débogage/.test(p)));
  assert.ok(inspectArtifact({ ...okCap, server: { ...okCap.server, allowNavigation: ['evil.example'] } }, ['offline.html'], appCfg, b).some((p) => /allowNavigation/.test(p)));
  const pre = generatedFiles(resolveBuildConfig(PREPROD))['www/app-config.js'];
  assert.ok(inspectArtifact(okCap, ['offline.html'], pre, b).some((p) => /app-config/.test(p)));
});

test('L108G-WF : workflows — distant par défaut, production forcée en distant, binaire contrôlé avant envoi', () => {
  const ios = read('../.github/workflows/mobile-ios.yml');
  const android = read('../.github/workflows/mobile-android.yml');
  for (const wf of [ios, android]) {
    assert.match(wf, /default: remote/);
    assert.match(wf, /distribution-guard\.mjs/);
    assert.match(wf, /--publish/);
  }
  assert.match(ios, /inputs\.environment == 'prod'\) && 'remote' \|\|/);
  assert.match(android, /VEREBONA_ENV: prod\n\s+VEREBONA_APP_ORIGIN: \$\{\{ vars\.VEREBONA_APP_ORIGIN \}\}\n\s+# [^\n]*\n\s+VEREBONA_UI_MODE: remote/);
  // Extension présente dans l'archive, identifiant dérivé, groupe signé.
  assert.match(ios, /PlugIns\/ShareExtension\.appex/);
  assert.match(ios, /\$APP_ID\.ShareExtension/);
  assert.match(ios, /codesign -d --entitlements/);
  // Lot 107-bis conservé (nettoyage + transmission par GITHUB_ENV des identifiants ASC).
  assert.ok(ios.includes(String.raw`nettoyer() { printf '%s' "$1" | tr -d ' \t\r\n"'"'"; }`), 'nettoyage 107-bis conservé');
  assert.match(ios, /echo "ASC_API_KEY_ID=\$ASC_API_KEY_ID" >> "\$GITHUB_ENV"/);
  assert.match(ios, /echo "ASC_API_ISSUER_ID=\$ASC_API_ISSUER_ID" >> "\$GITHUB_ENV"/);
  // Play : production = BROUILLON uniquement (aucune mise en ligne publique par le workflow).
  assert.match(android, /status: \$\{\{ inputs\.prod_track == 'production' && 'draft' \|\| 'completed' \}\}/);
});

test('L108G-WWW : coque locale sans sonde ni donnée, page « Connexion Internet indisponible »', () => {
  const entries = readdirSync(resolve(here, '../www'));
  assert.ok(!entries.some((n) => /probe|sonde/i.test(n)), 'aucune sonde dans la coque distribuée');
  const offline = read('www/offline.html');
  assert.match(offline, /Connexion Internet indisponible/);
  assert.match(offline, />Réessayer</);
  assert.match(offline, /Content-Security-Policy/);
  const js = read('www/offline.js') + read('www/shell.js');
  assert.ok(!/location\.search|URLSearchParams|location\.hash/.test(js), 'aucune adresse lue dans l’URL (pas de redirection ouverte)');
  assert.match(read('www/offline.js'), /Android System WebView/);
  assert.ok(existsSync(resolve(here, '../sonde-b/index.html')), 'sonde conservée hors de la coque distante');
});

// ── Projet Xcode : analyse réelle du pbxproj ──────────────────────────────

/** Analyseur minimal du format « plist ASCII » d'Xcode (dictionnaires, listes, chaînes). */
function parsePbx(src) {
  let i = 0;
  const skip = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src.startsWith('/*', i)) { i = src.indexOf('*/', i) + 2; continue; }
      if (src.startsWith('//', i)) { i = src.indexOf('\n', i); continue; }
      return;
    }
  };
  const value = () => {
    skip();
    const c = src[i];
    if (c === '{') {
      i++; const o = {};
      for (;;) { skip(); if (src[i] === '}') { i++; return o; } const k = value(); skip(); if (src[i++] !== '=') throw new Error(`= attendu à ${i}`); o[k] = value(); skip(); if (src[i++] !== ';') throw new Error(`; attendu à ${i}`); }
    }
    if (c === '(') {
      i++; const a = [];
      for (;;) { skip(); if (src[i] === ')') { i++; return a; } a.push(value()); skip(); if (src[i] === ',') i++; }
    }
    if (c === '"') {
      let s = ''; i++;
      while (src[i] !== '"') { if (src[i] === '\\') { s += src[i + 1]; i += 2; } else s += src[i++]; }
      i++; return s;
    }
    const m = /^[A-Za-z0-9_$.\/:+-]+/.exec(src.slice(i));
    if (!m) throw new Error(`jeton inattendu à ${i} : ${src.slice(i, i + 20)}`);
    i += m[0].length; return m[0];
  };
  const r = value();
  skip();
  if (i < src.length) throw new Error('contenu après la racine');
  return r;
}

test('L108G-XCODE : pbxproj valide, toutes les références résolues', () => {
  const pbx = parsePbx(read('ios/App/App.xcodeproj/project.pbxproj').replace(/^\/\/ !\$\*UTF8\*\$!\n/, ''));
  const objects = pbx.objects;
  const ids = new Set(Object.keys(objects));
  assert.ok(ids.has(pbx.rootObject));
  // Toute valeur de 24 hexadécimaux est un objet existant.
  const walk = (v, path) => {
    if (typeof v === 'string') { if (/^[0-9A-F]{24}$/.test(v)) assert.ok(ids.has(v), `${path} → ${v} introuvable`); return; }
    if (Array.isArray(v)) v.forEach((x, n) => walk(x, `${path}[${n}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (path.endsWith('TargetAttributes')) assert.ok(ids.has(k), `TargetAttributes ${k}`); walk(x, `${path}.${k}`); }
  };
  walk(objects, 'objects');
  // Chaque fichier source référencé existe sur le disque.
  const groupOf = new Map();
  for (const [id, o] of Object.entries(objects)) if (o.isa === 'PBXGroup' || o.isa === 'PBXVariantGroup') for (const c of o.children ?? []) groupOf.set(c, id);
  const pathOf = (id) => { const o = objects[id]; const parent = groupOf.get(id); const own = o.path ?? ''; return parent ? `${pathOf(parent)}/${own}`.replace(/^\/+/, '') : own; };
  for (const [id, o] of Object.entries(objects)) {
    if (o.isa === 'PBXFileReference' && o.lastKnownFileType === 'sourcecode.swift') {
      assert.ok(existsSync(resolve(here, '../ios/App', pathOf(id))), `${pathOf(id)} absent`);
    }
  }
});

test('L108G-XCODE : cible ShareExtension intégrée, embarquée et paramétrée par environnement', () => {
  const pbx = parsePbx(read('ios/App/App.xcodeproj/project.pbxproj').replace(/^\/\/ !\$\*UTF8\*\$!\n/, ''));
  const o = pbx.objects;
  const project = o[pbx.rootObject];
  const targets = project.targets.map((id) => o[id]);
  const app = targets.find((t) => t.name === 'App');
  const ext = targets.find((t) => t.name === 'ShareExtension');
  assert.ok(ext, 'cible ShareExtension dans le projet');
  assert.equal(ext.productType, 'com.apple.product-type.app-extension');
  assert.equal(o[ext.productReference].path, 'ShareExtension.appex');
  // Dépendance + phase « Embed Foundation Extensions » (PlugIns, dstSubfolderSpec 13).
  assert.ok(app.dependencies.some((d) => o[o[d].target]?.name === 'ShareExtension'), 'l’app dépend de l’extension');
  const embed = app.buildPhases.map((id) => o[id]).find((ph) => ph.isa === 'PBXCopyFilesBuildPhase');
  assert.equal(embed.dstSubfolderSpec, '13');
  assert.ok(embed.files.some((f) => o[o[f].fileRef].path === 'ShareExtension.appex'));
  // Sources de l'extension et de l'app.
  const sourcesOf = (t) => t.buildPhases.map((id) => o[id]).find((ph) => ph.isa === 'PBXSourcesBuildPhase').files.map((f) => o[o[f].fileRef].path);
  assert.deepEqual(sourcesOf(ext), ['ShareViewController.swift']);
  for (const f of ['VerebonaNavigationGuard.swift', 'VerebonaShareInbox.swift', 'VerebonaBridgeViewController.swift']) assert.ok(sourcesOf(app).includes(f), f);
  // Réglages : identifiant dérivé de l'app, droits propres, xcconfig de l'environnement, signature automatique.
  for (const cfgId of o[ext.buildConfigurationList].buildConfigurations) {
    const c = o[cfgId];
    assert.equal(o[c.baseConfigurationReference].path, '../Verebona.xcconfig');
    assert.equal(c.buildSettings.PRODUCT_BUNDLE_IDENTIFIER, '$(VB_SHARE_EXTENSION_ID)');
    assert.equal(c.buildSettings.CODE_SIGN_ENTITLEMENTS, 'ShareExtension/ShareExtension.entitlements');
    assert.equal(c.buildSettings.CODE_SIGN_STYLE, 'Automatic');
    assert.equal(c.buildSettings.INFOPLIST_FILE, 'ShareExtension/Info.plist');
    assert.equal(c.buildSettings.APPLICATION_EXTENSION_API_ONLY, 'YES');
  }
  for (const env of [PREPROD, PROD]) {
    const b = resolveBuildConfig(env);
    const x = generatedFiles(b)['ios/Verebona.xcconfig'];
    assert.match(x, new RegExp(`VB_SHARE_EXTENSION_ID = ${b.appId.replace(/\./g, '\\.')}\\.ShareExtension\\n`));
    assert.match(x, new RegExp(`VB_APP_GROUP = group\\.${b.appId.replace(/\./g, '\\.')}\\n`));
  }
  assert.match(read('ios/App/ShareExtension/ShareExtension.entitlements'), /<string>\$\(VB_APP_GROUP\)<\/string>/);
  assert.match(read('ios/App/App/App.entitlements'), /<string>\$\(VB_APP_GROUP\)<\/string>/);
  assert.ok(!existsSync(resolve(here, '../ios-share-extension')), 'plus de dossier à intégrer à la main');
});

// ── Extension de partage : conformité et file technique ───────────────────

test('L108G-SHARE : extension conforme (aucune ouverture de l’app), formats, confirmation fidèle', () => {
  const swift = read('ios/App/ShareExtension/ShareViewController.swift');
  const code = swift.split('\n').filter((l) => !/^\s*\/\/\//.test(l) && !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/UIApplication|openURL|\.open\(|responder|sel_registerName|perform\(/.test(code), 'aucune ouverture indirecte de l’app');
  assert.ok(!/share-target-data|UserDefaults/.test(code), 'plus de clé unique écrasée à chaque partage');
  assert.match(code, /Document prêt à importer dans Verebona/);
  assert.ok(!/enregistré dans votre compte\./.test(code.replace(/Rien n’est encore enregistré dans votre compte\./, '')), 'jamais « enregistré »');
  for (const t of ['.pdf', '.jpeg', '.png', '.webP', '.heic', '.heif']) assert.ok(code.includes(t), t);
  assert.match(code, /convertie en JPEG/);
  assert.match(code, /FileProtectionType\.complete/);
  assert.match(code, /isExcludedFromBackup = true/);
  assert.match(code, /moveItem\(at: staging, to: final\)/, 'élément publié d’un coup (jamais à moitié écrit)');
  // Constantes partagées avec le plugin de l'app.
  const inbox = read('ios/App/App/VerebonaShareInbox.swift');
  for (const k of ['inboxFolder = "partages-v1"', 'manifestName = "manifest.json"']) { assert.ok(swift.includes(k), k); assert.ok(inbox.includes(k), k); }
  assert.match(inbox, /jsName = "VerebonaShareInbox"/);
  const plist = read('ios/App/ShareExtension/Info.plist');
  assert.match(plist, /com\.apple\.share-services/);
  assert.match(plist, /UTI-CONFORMS-TO "com\.adobe\.pdf"/);
  assert.match(plist, /UTI-CONFORMS-TO "public\.image"/);
});
