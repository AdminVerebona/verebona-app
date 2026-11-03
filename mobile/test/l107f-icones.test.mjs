/**
 * Lot 107F — icônes de l'application (charte Sérénité 2026) : plus d'icône Capacitor par défaut,
 * variante PRÉPROD distincte, calque monochrome, icône iOS sans canal alpha.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(resolve(root, rel));
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
/** Largeur, hauteur, type de couleur PNG (2 = RVB sans alpha, 6 = RVBA). */
const png = (rel) => { const b = read(rel); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), colorType: b[25] }; };

// Empreintes des icônes Capacitor livrées par défaut (le « X » bleu), interdites désormais.
const CAPACITOR_DEFAULTS = new Set([
  '87cb2f2ffe992652bb4fa768c73719a37b5852ab17fbf8e170e888f7a42b0761',
  '29e4777e319de3ee5a52c3a8004ec19d0568414004257e36d7c94a077d71c93b',
]);
const DENS = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const RES = { prod: 'android/app/src/main/res', preprod: 'android/app/src/preprod/res' };

test('Android : chaque variante a ses icônes à toutes les densités, aux bonnes tailles', () => {
  for (const [env, res] of Object.entries(RES)) {
    for (const [d, k] of Object.entries(DENS)) {
      for (const [name, size] of [['ic_launcher', 48], ['ic_launcher_round', 48], ['ic_launcher_foreground', 108], ['ic_launcher_monochrome', 108]]) {
        const rel = `${res}/mipmap-${d}/${name}.png`;
        assert.ok(existsSync(resolve(root, rel)), `${env} : ${rel} manquant`);
        const { w, h } = png(rel);
        assert.equal(w, Math.round(size * k), rel);
        assert.equal(h, Math.round(size * k), rel);
        assert.ok(!CAPACITOR_DEFAULTS.has(sha(read(rel))), `${rel} : icône Capacitor par défaut`);
      }
    }
  }
});

test('Android : préprod visuellement distincte de la production (fond et avant-plan)', () => {
  for (const d of Object.keys(DENS)) {
    for (const name of ['ic_launcher', 'ic_launcher_foreground', 'ic_launcher_monochrome']) {
      assert.notEqual(sha(read(`${RES.prod}/mipmap-${d}/${name}.png`)), sha(read(`${RES.preprod}/mipmap-${d}/${name}.png`)), `${d}/${name}`);
    }
  }
  assert.match(read(`${RES.prod}/values/ic_launcher_background.xml`).toString(), /#17474D/);
  assert.match(read(`${RES.preprod}/values/ic_launcher_background.xml`).toString(), /#F8F6F1/);
});

test('Android : icône adaptative avec calque monochrome (icônes à thème)', () => {
  for (const f of ['ic_launcher', 'ic_launcher_round']) {
    const xml = read(`${RES.prod}/mipmap-anydpi-v26/${f}.xml`).toString();
    assert.match(xml, /<background android:drawable="@color\/ic_launcher_background"\/>/);
    assert.match(xml, /<foreground android:drawable="@mipmap\/ic_launcher_foreground"\/>/);
    assert.match(xml, /<monochrome android:drawable="@mipmap\/ic_launcher_monochrome"\/>/);
  }
});

test('iOS : icônes 1024 production et préprod, sans canal alpha, distinctes', () => {
  const prod = 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png';
  const pre = 'ios/App/App/Assets.xcassets/AppIcon-Preprod.appiconset/AppIcon-512@2x.png';
  for (const rel of [prod, pre]) {
    assert.deepEqual(png(rel), { w: 1024, h: 1024, colorType: 2 }, rel);
    assert.ok(!CAPACITOR_DEFAULTS.has(sha(read(rel))), rel);
  }
  assert.notEqual(sha(read(prod)), sha(read(pre)));
});

test('Écrans de démarrage : plus le logo Capacitor (iOS sans alpha)', () => {
  for (const f of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
    assert.deepEqual(png(`ios/App/App/Assets.xcassets/Splash.imageset/${f}`), { w: 2732, h: 2732, colorType: 2 });
  }
  assert.ok(existsSync(resolve(root, 'android/app/src/main/res/drawable/splash.png')));
});
