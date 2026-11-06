/**
 * Lot 112E — identifiant d'installation lu téléphone verrouillé. Contrôles
 * statiques de la coque iOS : plugin local `VerebonaSecureStoreStatus`
 * compilé dans la cible App et enregistré, lecture SEULE du Keychain, code
 * `errSecInteractionNotAllowed` distingué de « introuvable », classe
 * d'accessibilité inchangée, aucune nouvelle dépendance.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, '..', p), 'utf8');

test('L112E-NAT-01 : iOS — plugin local compilé dans la cible App et enregistré', () => {
  const pbx = read('ios/App/App.xcodeproj/project.pbxproj');
  assert.match(pbx, /112E00012F0A000000000001 \/\* VerebonaSecureStoreStatus\.swift \*\/ = \{isa = PBXFileReference/);
  assert.match(pbx, /112E00012F0A000000000002 \/\* VerebonaSecureStoreStatus\.swift in Sources \*\/ = \{isa = PBXBuildFile; fileRef = 112E00012F0A000000000001/);
  assert.equal((pbx.match(/112E00012F0A000000000001 \/\* VerebonaSecureStoreStatus\.swift \*\/,/g) ?? []).length, 1, 'groupe App');
  assert.equal((pbx.match(/112E00012F0A000000000002 \/\* VerebonaSecureStoreStatus\.swift in Sources \*\/,/g) ?? []).length, 1, 'phase Sources (cible App seulement)');
  assert.match(read('ios/App/App/VerebonaBridgeViewController.swift'), /registerPluginInstance\(VerebonaSecureStoreStatusPlugin\(\)\)/);
});

test('L112E-NAT-02 : iOS — lecture seule, verrouillé ≠ absent, préfixe imposé', () => {
  const swift = read('ios/App/App/VerebonaSecureStoreStatus.swift');
  assert.match(swift, /jsName = "VerebonaSecureStoreStatus"/);
  assert.match(swift, /case errSecInteractionNotAllowed:\s*label = "locked"/);
  assert.match(swift, /case errSecItemNotFound:\s*label = available \? "absent" : "locked"/);
  assert.match(swift, /isProtectedDataAvailable/);
  assert.match(swift, /protectedDataDidBecomeAvailableNotification/);
  assert.match(swift, /hasPrefix\(Self\.allowedPrefix\)/);
  assert.doesNotMatch(swift, /SecItemAdd|SecItemUpdate|SecItemDelete/, 'aucune écriture du Keychain');
  assert.doesNotMatch(swift, /"value"|"data":/, 'le contenu n’est jamais renvoyé');
});

test('L112E-NAT-03 : classe d’accessibilité inchangée, aucune nouvelle dépendance', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.dependencies['@aparajita/capacitor-secure-storage'], '8.0.1');
  const ts = readFileSync(resolve(here, '..', '..', 'src/lib/native/secure-store.ts'), 'utf8');
  assert.match(ts, /const KEYCHAIN_WHEN_UNLOCKED_THIS_DEVICE_ONLY = 1;/);
  assert.match(ts, /access: KEYCHAIN_WHEN_UNLOCKED_THIS_DEVICE_ONLY/);
});
