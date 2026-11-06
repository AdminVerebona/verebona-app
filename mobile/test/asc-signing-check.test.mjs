/**
 * Lot 112 (correctif du 06/11) : diagnostic de signature iOS avant l'archivage
 * (« No profiles for 'fr.verebona.app.preprod' were found »).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyse, readXcconfig, REQUIRED_CAPABILITIES } from '../scripts/asc-signing-check.mjs';

const ids = { appId: 'fr.verebona.app.preprod', shareId: 'fr.verebona.app.preprod.ShareExtension' };
const ok = {
  [ids.appId]: { id: 'A', capabilities: [...REQUIRED_CAPABILITIES.app] },
  [ids.shareId]: { id: 'S', capabilities: [...REQUIRED_CAPABILITIES.extension] },
};

test('xcconfig : identifiants de l\'app et de l\'extension lus', () => {
  const r = readXcconfig('VB_APP_ID = fr.verebona.app.preprod\nVB_SHARE_EXTENSION_ID = fr.verebona.app.preprod.ShareExtension\nVB_APP_GROUP = group.fr.verebona.app.preprod\n');
  assert.deepEqual(r, { ...ids, appGroup: 'group.fr.verebona.app.preprod' });
});

test('tout est en place : aucun constat bloquant', () => {
  const r = analyse({ ids, bundles: ok, devices: 1, profiles: [{ name: 'p', state: 'ACTIVE', bundle: ids.appId }] });
  assert.deepEqual([r.errors, r.warnings], [[], []]);
});

test('identifiant d\'app absent : bloquant, nommé', () => {
  const r = analyse({ ids, bundles: { ...ok, [ids.appId]: null }, devices: 1, profiles: [] });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /fr\.verebona\.app\.preprod/);
  assert.match(r.errors[0], /Identifiers/);
});

test('aucun appareil : bloquant', () => {
  const r = analyse({ ids, bundles: ok, devices: 0, profiles: [] });
  assert.match(r.errors.join(' '), /Aucun appareil iOS actif/);
});

test('fonctionnalité manquante et profil invalide : avertissements explicites', () => {
  const r = analyse({
    ids, bundles: { ...ok, [ids.appId]: { id: 'A', capabilities: ['PUSH_NOTIFICATIONS'] } }, devices: 2,
    profiles: [{ name: 'iOS Team Provisioning Profile: fr.verebona.app.preprod', state: 'INVALID', bundle: ids.appId }, { name: 'autre', state: 'INVALID', bundle: 'fr.autre' }],
  });
  assert.equal(r.errors.length, 0);
  assert.match(r.warnings.join(' '), /ASSOCIATED_DOMAINS, APP_GROUPS/);
  assert.match(r.warnings.join(' '), /INVALID/);
  assert.doesNotMatch(r.warnings.join(' '), /autre/);
});

test('workflow iOS : diagnostic lancé avant l\'archivage, version de Xcode affichée', () => {
  const wf = readFileSync(new URL('../../.github/workflows/mobile-ios.yml', import.meta.url), 'utf8');
  const diag = wf.indexOf('node mobile/scripts/asc-signing-check.mjs');
  const archive = wf.indexOf('-archivePath "$RUNNER_TEMP/App.xcarchive"');
  assert.ok(diag > 0 && archive > diag);
  assert.match(wf, /xcodebuild -version/);
});
