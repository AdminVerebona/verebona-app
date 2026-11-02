/**
 * Lot 102C — décisions PO « Firebase Analytics désactivé tant qu'aucun besoin
 * spécifique n'est validé » et « pas de Web Push / PWA ; push mobile natif
 * uniquement ». Contrôles statiques des fichiers natifs et des dépendances.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, '..', p), 'utf8');

test('L102C-FB-01 : Android — collecte Analytics désactivée définitivement, FCM sans initialisation automatique', () => {
  const m = read('android/app/src/main/AndroidManifest.xml');
  assert.match(m, /firebase_analytics_collection_enabled"\s+android:value="false"/);
  assert.match(m, /firebase_analytics_collection_deactivated"\s+android:value="true"/);
  assert.match(m, /google_analytics_adid_collection_enabled"\s+android:value="false"/);
  assert.match(m, /firebase_messaging_auto_init_enabled"\s+android:value="false"/);
});

test('L102C-FB-02 : iOS — collecte Analytics désactivée définitivement (prioritaire sur GoogleService-Info.plist)', () => {
  const p = read('ios/App/App/Info.plist');
  assert.match(p, /<key>FIREBASE_ANALYTICS_COLLECTION_ENABLED<\/key>\s*<false\/>/);
  assert.match(p, /<key>FIREBASE_ANALYTICS_COLLECTION_DEACTIVATED<\/key>\s*<true\/>/);
  assert.match(p, /<key>FirebaseMessagingAutoInitEnabled<\/key>\s*<false\/>/);
});

test('L102C-FB-03 : aucun SDK Analytics embarqué — seul Firebase Messaging (push natif)', () => {
  const pkg = JSON.parse(read('package.json'));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  assert.ok(deps.includes('@capacitor-firebase/messaging'));
  assert.deepEqual(deps.filter((d) => /analytics|crashlytics|performance|gtag/i.test(d)), []);
  const gradle = read('android/app/build.gradle') + read('android/app/capacitor.build.gradle') + read('android/build.gradle');
  assert.doesNotMatch(gradle, /firebase-analytics|play-services-measurement/);
  const spm = read('ios/App/CapApp-SPM/Package.swift');
  assert.doesNotMatch(spm, /FirebaseAnalytics|GoogleAppMeasurement/);
});

test('L102C-FB-04 : pas de push Web — Capacitor ne déclare que la messagerie native', () => {
  const cfg = read('capacitor.config.ts');
  assert.match(cfg, /FirebaseMessaging/);
  assert.doesNotMatch(cfg, /PushNotifications:\s*\{[^}]*web/i);
});
