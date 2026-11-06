/**
 * Lot 112 (correctif 4, 06/11) : garde-fou des droits signés lu en JSON.
 * Les droits ci-dessous ont la forme exacte de `codesign -d --entitlements - --xml`
 * converti par `plutil -convert json` (clés à points, tableaux de chaînes).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guard, readEntitlements } from '../scripts/signed-entitlements-guard.mjs';

const GROUP = 'group.fr.verebona.app.preprod';
const signed = (o = {}) => ({
  'application-identifier': 'ABCDE12345.fr.verebona.app.preprod',
  'com.apple.developer.team-identifier': 'ABCDE12345',
  'com.apple.security.application-groups': [GROUP],
  'com.apple.developer.associated-domains': ['applinks:app.preprod.verebona.fr', 'webcredentials:app.preprod.verebona.fr'],
  'aps-environment': 'production',
  'keychain-access-groups': ['ABCDE12345.fr.verebona.app.preprod'],
  ...o,
});

test('clés à points lues telles quelles (cause du refus à tort du 06/11)', () => {
  const r = readEntitlements(signed());
  assert.deepEqual(r.groups, [GROUP]);
  assert.equal(r.team, 'ABCDE12345');
  assert.deepEqual(r.keychain, ['ABCDE12345.fr.verebona.app.preprod']);
});

test('app et extension portant le groupe, même équipe : accepté', () => {
  const r = guard(GROUP, [{ name: 'App.app', json: signed() }, { name: 'ShareExtension.appex', json: signed({ 'keychain-access-groups': undefined }) }]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.lines.length, 2);
  assert.match(r.summary[1], /aucun \(le groupe d'apps sert de groupe Keychain\)/);
});

test('groupe absent : refus nommé, avec les groupes réellement signés', () => {
  const r = guard(GROUP, [{ name: 'App.app', json: signed({ 'com.apple.security.application-groups': ['group.autre'] }) }]);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /droits signés de App\.app : group\.autre/);
  const vide = guard(GROUP, [{ name: 'App.app', json: signed({ 'com.apple.security.application-groups': undefined }) }]);
  assert.match(vide.errors[0], /: aucun\)/);
});

test('deux équipes différentes : refus (Keychain non partagé)', () => {
  const r = guard(GROUP, [{ name: 'App.app', json: signed() }, { name: 'ShareExtension.appex', json: signed({ 'com.apple.developer.team-identifier': 'ZZZZZ99999' }) }]);
  assert.match(r.errors.join(' '), /deux équipes différentes/);
});

test('exécution comme dans le workflow : fichiers JSON, code de sortie, résumé', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ent-'));
  const app = join(dir, 'ent-App.app.json');
  const ext = join(dir, 'ent-ShareExtension.appex.json');
  writeFileSync(app, JSON.stringify(signed()));
  writeFileSync(ext, JSON.stringify(signed()));
  const summary = join(dir, 'summary.md');
  const script = new URL('../scripts/signed-entitlements-guard.mjs', import.meta.url).pathname;
  const out = execFileSync('node', [script, GROUP, `App.app=${app}`, `ShareExtension.appex=${ext}`], { env: { ...process.env, GITHUB_STEP_SUMMARY: summary }, encoding: 'utf8' });
  assert.match(out, /Droits signés du partage contrôlés/);
  writeFileSync(ext, JSON.stringify(signed({ 'com.apple.security.application-groups': [] })));
  assert.throws(() => execFileSync('node', [script, GROUP, `App.app=${app}`, `ShareExtension.appex=${ext}`], { encoding: 'utf8', stdio: 'pipe' }));
});
