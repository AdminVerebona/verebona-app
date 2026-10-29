/**
 * Correctif CI mobile du 29/10/2026 : un push sur main ne doit plus faire
 * échouer le workflow tant que les variables/secrets des stores ne sont pas posés.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBuildConfig } from '../config/environments.mjs';
import { checkReadiness } from '../scripts/readiness.mjs';

const ANDROID_OK = {
  VEREBONA_ENV: 'preprod', VEREBONA_APP_ORIGIN: 'https://app.preprod.verebona.fr',
  GOOGLE_SERVICES_JSON_BASE64: 'x', ANDROID_UPLOAD_KEYSTORE_BASE64: 'x', ANDROID_UPLOAD_KEYSTORE_PASSWORD: 'x',
  ANDROID_UPLOAD_KEY_ALIAS: 'x', ANDROID_UPLOAD_KEY_PASSWORD: 'x', PLAY_SERVICE_ACCOUNT_JSON: 'x',
};

test('variables GitHub non posées (chaînes vides) : version, build et mode par défaut, pas d’erreur', () => {
  const b = resolveBuildConfig({ ...ANDROID_OK, VEREBONA_APP_VERSION: '', VEREBONA_APP_BUILD: '', VEREBONA_UI_MODE: '' });
  assert.equal(b.version, '0.1.0');
  assert.equal(b.build, '1');
  assert.equal(b.uiMode, 'remote');
});

test('origine absente : jamais devinée, toujours une erreur', () => {
  assert.throws(() => resolveBuildConfig({ VEREBONA_ENV: 'preprod', VEREBONA_APP_ORIGIN: '' }), /VEREBONA_APP_ORIGIN/);
});

test('rien de posé (situation du 29/10) : build Android non prêt, liste des manques sans valeur', () => {
  const r = checkReadiness('android', { VEREBONA_ENV: 'preprod', VEREBONA_APP_ORIGIN: '', VEREBONA_APP_VERSION: '' }, { publish: true });
  assert.equal(r.ready, false);
  assert.ok(r.problems.some((p) => p.includes('VEREBONA_APP_ORIGIN')));
  assert.ok(r.problems.some((p) => p.includes('PLAY_SERVICE_ACCOUNT_JSON')));
  assert.ok(!r.problems.some((p) => p.includes('VEREBONA_APP_VERSION')), 'version vide = défaut, pas un manque');
});

test('tout posé : prêt ; compte Play exigé seulement si publication', () => {
  assert.deepEqual(checkReadiness('android', ANDROID_OK, { publish: true }), { ready: true, problems: [] });
  const { PLAY_SERVICE_ACCOUNT_JSON, ...noPlay } = ANDROID_OK;
  assert.equal(checkReadiness('android', noPlay, { publish: false }).ready, true);
  assert.equal(checkReadiness('android', noPlay, { publish: true }).ready, false);
});

test('origine posée mais invalide ou de mauvais environnement : non prêt, motif explicite', () => {
  assert.match(checkReadiness('android', { ...ANDROID_OK, VEREBONA_APP_ORIGIN: 'http://x.fr/app' }).problems.join(' '), /origine https/);
  assert.match(checkReadiness('android', { ...ANDROID_OK, VEREBONA_APP_ORIGIN: 'https://app.verebona.fr' }).problems.join(' '), /pas de préproduction/);
});

test('iOS : équipe Apple et clés App Store Connect exigées', () => {
  const r = checkReadiness('ios', { VEREBONA_ENV: 'preprod', VEREBONA_APP_ORIGIN: 'https://app.preprod.verebona.fr' });
  assert.equal(r.ready, false);
  for (const n of ['APPLE_TEAM_ID', 'ASC_API_KEY_P8_BASE64', 'ASC_API_KEY_ID', 'ASC_API_ISSUER_ID', 'GOOGLE_SERVICE_INFO_PLIST_BASE64']) {
    assert.ok(r.problems.some((p) => p.includes(n)), n);
  }
});
