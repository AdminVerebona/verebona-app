/**
 * Lot 110B — clés d'accès (WebAuthn) dans la vue de l'application.
 * iOS : domaine associé `webcredentials:` (déjà présent) ; Android : WebAuthn
 * activé dans la WebView par l'app (AndroidX WebKit, par réflexion, repli
 * TOTP si non pris en charge). Contrôles statiques (aucun appareil ici).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, '..', p), 'utf8');

test('L110B-MOB-01 : iOS — domaine associé webcredentials sur l’hôte de l’environnement', () => {
  assert.match(read('ios/App/App/App.entitlements'), /<string>webcredentials:\$\(VB_APP_HOST\)<\/string>/);
});

test('L110B-MOB-02 : Android — WebAuthn activé APRÈS l’initialisation du pont, plugins inchangés', () => {
  const act = read('android/app/src/main/java/fr/verebona/app/MainActivity.java');
  assert.match(act, /registerPlugin\(VerebonaBiometricStatePlugin\.class\);\s*super\.onCreate\(savedInstanceState\);/);
  assert.match(act, /super\.onCreate\(savedInstanceState\);[\s\S]*VerebonaWebAuthn\.enable\(this\.bridge\.getWebView\(\)\)/);
  const j = read('android/app/src/main/java/fr/verebona/app/VerebonaWebAuthn.java');
  assert.match(j, /WEB_AUTHENTICATION_SUPPORT_FOR_APP/);
  assert.match(j, /isFeatureSupported/);
  // Aucune dépendance de compilation nouvelle (réflexion) ; aucune exception ne remonte.
  assert.doesNotMatch(j, /^import androidx\./m);
  assert.match(j, /catch \(Throwable t\)/);
});
