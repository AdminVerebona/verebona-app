/**
 * Lot 111E — remplissage automatique des mots de passe dans la vue distante.
 * Contrôles statiques (aucun appareil ici) :
 *  - iOS : domaines associés applinks + webcredentials sur l'hôte EXACT de
 *    l'environnement (généré dans Verebona.xcconfig), et garde CI qui vérifie
 *    les droits du binaire SIGNÉ avant l'envoi TestFlight ;
 *  - Android : rien n'exclut la WebView des services de remplissage
 *    (pas d'importantForAutofill « no* », pas de FLAG_SECURE) — la WebView
 *    système (Android 8+) expose les champs au cadre Autofill par défaut :
 *    aucun réglage natif n'est nécessaire, donc aucun n'est ajouté.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatedFiles } from '../scripts/prepare.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (e === 'build' || e === '.gradle') continue;
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

test('L111E-MOB-01 : iOS — applinks et webcredentials sur $(VB_APP_HOST), hôte généré = hôte de l’origine', () => {
  const ent = read('ios/App/App/App.entitlements');
  assert.match(ent, /<string>applinks:\$\(VB_APP_HOST\)<\/string>/);
  assert.match(ent, /<string>webcredentials:\$\(VB_APP_HOST\)<\/string>/);
  const files = generatedFiles({
    env: 'preprod', appName: 'Verebona Préprod', appId: 'fr.verebona.app.preprod', origin: 'https://app.preprod.verebona.fr',
    host: 'app.preprod.verebona.fr', hostname: 'app.preprod.verebona.fr', startUrl: 'https://app.preprod.verebona.fr/accueil',
    uiMode: 'remote', version: '1.0.0', build: 1, urlScheme: 'fr.verebona.app.preprod', iosAppGroup: 'group.fr.verebona.app.preprod',
  });
  assert.match(files['ios/Verebona.xcconfig'], /^VB_APP_HOST = app\.preprod\.verebona\.fr$/m);
  assert.match(files['ios/Verebona.xcconfig'], /^CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements$/m);
});

test('L111E-MOB-02 : iOS — la CI refuse un binaire signé sans webcredentials:<hôte>', () => {
  const wf = readFileSync(resolve(root, '..', '.github/workflows/mobile-ios.yml'), 'utf8');
  assert.match(wf, /VB_APP_HOST = \/\/p' mobile\/ios\/Verebona\.xcconfig/);
  assert.match(wf, /codesign -d --entitlements - --xml "\$APP"[^\n]*grep -q "webcredentials:\$HOST<"/);
});

test('L111E-MOB-03 : Android — rien n’exclut la WebView des services de remplissage automatique', () => {
  const src = walk(resolve(root, 'android/app/src/main')).filter((p) => /\.(xml|java|kt)$/.test(p));
  for (const p of src) {
    const t = readFileSync(p, 'utf8');
    assert.doesNotMatch(t, /importantForAutofill\s*=\s*"no/i, p);
    assert.doesNotMatch(t, /IMPORTANT_FOR_AUTOFILL_NO/, p);
    assert.doesNotMatch(t, /FLAG_SECURE/, p);
  }
});
