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

test('appels à l\'API : jamais de « limit » sur une relation (400 du 06/11) ; erreur inattendue = avertissement, pas un échec', async () => {
  const { check } = await import('../scripts/asc-signing-check.mjs');
  const { generateKeyPairSync } = await import('node:crypto');
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'asc-'));
  const key = join(dir, 'AuthKey.p8');
  writeFileSync(key, generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const urls = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url); urls.push(u);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
    if (/\/bundleIds\/[^/]+\/bundleIdCapabilities/.test(u)) {
      if (u.includes('limit=')) return json({ errors: [{ detail: "The parameter 'limit' can not be used with this request" }] }, 400);
      return json({ data: [{ attributes: { capabilityType: 'APP_GROUPS' } }, { attributes: { capabilityType: 'ASSOCIATED_DOMAINS' } }, { attributes: { capabilityType: 'PUSH_NOTIFICATIONS' } }] });
    }
    if (u.includes('/bundleIds?')) {
      const id = decodeURIComponent(/identifier\]=([^&]+)/.exec(u)[1]);
      return json({ data: [{ id: `B-${id}`, attributes: { identifier: id } }] });
    }
    if (u.includes('/devices?')) return json({ data: [{ id: 'D' }] });
    if (u.includes('/profiles?')) return json({ errors: [{ detail: 'inattendu' }] }, 500);
    return json({}, 404);
  };
  const out = [];
  try {
    const r = await check({ ASC_KEY_PATH: key, ASC_API_KEY_ID: 'ABCDEFGHIJ', ASC_API_ISSUER_ID: '00000000-0000-0000-0000-000000000000' },
      'VB_APP_ID = fr.verebona.app.preprod\nVB_SHARE_EXTENSION_ID = fr.verebona.app.preprod.ShareExtension\n', { log: (l) => out.push(l) });
    assert.deepEqual(r.errors, []);
    assert.ok(urls.filter((u) => u.includes('bundleIdCapabilities')).every((u) => !u.includes('limit=')));
    assert.match(out.join('\n'), /::warning::.*Profils non lus/);
  } finally { globalThis.fetch = saved; }
});

test('certificats : seuls ceux de développement créés par l\'API sont révoqués', async () => {
  const { cleanup, isCiDevCertificate } = await import('../scripts/asc-cleanup-dev-certs.mjs');
  const c = (id, certificateType, name) => ({ id, attributes: { certificateType, name, displayName: name } });
  const certs = [
    c('1', 'DEVELOPMENT', 'Apple Development: Created via API'),
    c('2', 'IOS_DEVELOPMENT', 'iOS Development: Created via API'),
    c('3', 'DEVELOPMENT', 'Apple Development: Geoffroy (MacBook)'),
    c('4', 'DISTRIBUTION', 'Apple Distribution: Created via API'),
    c('5', 'IOS_DISTRIBUTION', 'iOS Distribution: Verebona'),
  ];
  assert.deepEqual(certs.filter(isCiDevCertificate).map((x) => x.id), ['1', '2']);
  const { generateKeyPairSync } = await import('node:crypto');
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const key = join(mkdtempSync(join(tmpdir(), 'asc-')), 'AuthKey.p8');
  writeFileSync(key, generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const deleted = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (init?.method === 'DELETE') { deleted.push(u.split('/').pop()); return new Response(null, { status: 204 }); }
    return new Response(JSON.stringify({ data: certs }), { status: 200 });
  };
  try {
    const r = await cleanup({ ASC_KEY_PATH: key, ASC_API_KEY_ID: 'ABCDEFGHIJ', ASC_API_ISSUER_ID: '00000000-0000-0000-0000-000000000000' }, { log: () => {} });
    assert.deepEqual(deleted, ['1', '2']);
    assert.deepEqual(r, { dev: 3, revoked: 2 });
  } finally { globalThis.fetch = saved; }
});

test('workflow iOS : révocation des certificats de la CI avant l\'archivage', () => {
  const wf = readFileSync(new URL('../../.github/workflows/mobile-ios.yml', import.meta.url), 'utf8');
  const clean = wf.indexOf('node mobile/scripts/asc-cleanup-dev-certs.mjs');
  assert.ok(clean > 0 && wf.indexOf('-archivePath "$RUNNER_TEMP/App.xcarchive"') > clean);
});
