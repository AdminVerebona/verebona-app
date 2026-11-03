/**
 * Lot 107A — déverrouillage biométrique automatique et invalidation à
 * l'enrôlement. Contrôles statiques de la coque native : plugin local
 * `VerebonaBiometricState` présent et enregistré sur iOS et Android, aucune
 * nouvelle dépendance npm, justification Face ID, aperçu multitâche masqué.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, '..', p), 'utf8');

test('L107A-NAT-01 : iOS — plugin local compilé dans la cible App et enregistré', () => {
  const pbx = read('ios/App/App.xcodeproj/project.pbxproj');
  assert.match(pbx, /107A0E0012F0A00000000001 \/\* VerebonaBiometricState\.swift \*\/ = \{isa = PBXFileReference/);
  assert.match(pbx, /107A0E0012F0A00000000002 \/\* VerebonaBiometricState\.swift in Sources \*\/ = \{isa = PBXBuildFile; fileRef = 107A0E0012F0A00000000001/);
  assert.equal((pbx.match(/107A0E0012F0A00000000001 \/\* VerebonaBiometricState\.swift \*\/,/g) ?? []).length, 1, 'groupe App');
  assert.equal((pbx.match(/107A0E0012F0A00000000002 \/\* VerebonaBiometricState\.swift in Sources \*\/,/g) ?? []).length, 1, 'phase Sources');
  assert.match(read('ios/App/App/VerebonaBridgeViewController.swift'), /registerPluginInstance\(VerebonaBiometricStatePlugin\(\)\)/);
  const swift = read('ios/App/App/VerebonaBiometricState.swift');
  assert.match(swift, /jsName = "VerebonaBiometricState"/);
  assert.match(swift, /evaluatedPolicyDomainState/);
  assert.match(swift, /SHA256\.hash/);
});

test('L107A-NAT-02 : Android — plugin local enregistré avant le pont, clé invalidée à l’enrôlement', () => {
  const act = read('android/app/src/main/java/fr/verebona/app/MainActivity.java');
  assert.match(act, /registerPlugin\(VerebonaBiometricStatePlugin\.class\);\s*super\.onCreate\(savedInstanceState\);/);
  const java = read('android/app/src/main/java/fr/verebona/app/VerebonaBiometricStatePlugin.java');
  assert.match(java, /@CapacitorPlugin\(name = "VerebonaBiometricState"\)/);
  assert.match(java, /setInvalidatedByBiometricEnrollment\(true\)/);
  assert.match(java, /KeyPermanentlyInvalidatedException/);
});

test('L107A-NAT-03 : aucune nouvelle dépendance ; plugins biométrie / stockage sécurisé / aperçu masqué déjà présents', () => {
  const pkg = JSON.parse(read('package.json'));
  for (const d of ['@aparajita/capacitor-biometric-auth', '@aparajita/capacitor-secure-storage', '@capacitor-community/privacy-screen']) {
    assert.ok(pkg.dependencies[d], d);
  }
  assert.match(read('ios/App/App/Info.plist'), /<key>NSFaceIDUsageDescription<\/key>\s*<string>Face ID sert uniquement à déverrouiller Verebona/);
  assert.match(read('capacitor.config.ts'), /PrivacyScreen: \{ enable: true/);
});
