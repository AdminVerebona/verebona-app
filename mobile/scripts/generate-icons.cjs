/**
 * Icônes et écrans de démarrage de l'application — lot 107F (charte Sérénité 2026).
 *
 * Source : design system « Verebona Sérénité » (assets/app-icon/*.svg : symbole 8 carrés ivoire + carré
 * cuivre incliné, fond pétrole). Variante PRÉPROD selon docs/design/brief-graphiste-icone-et-mascotte.md
 * § 2.3 : fond ivoire + bandeau cuivre « PRÉPROD » (repère de forme présent aussi dans le calque monochrome).
 *
 * Outil de développeur, NON lancé par la CI (les PNG générés sont versionnés) :
 *   node mobile/scripts/generate-icons.cjs "$PWD" public/fonts/figtree-latin-800-normal.woff2
 * puis aplatir les PNG iOS en RVB sans alpha (exigence App Store), ex. Pillow : Image.convert('RGB').
 * À remplacer par les fichiers du graphiste dès leur livraison (brief § 8).
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const [repo, fontFile] = process.argv.slice(2);
const FONT = fs.readFileSync(fontFile).toString('base64');
const PETROLE = '#17474D', IVOIRE = '#F8F6F1', CUIVRE = '#D66B53';

// Symbole (coordonnées du design system : 0..32 en x, -1.55..32 en y).
function symbol(fill, accent) {
  const cells = [[0,0],[11.43,0],[0,11.43],[11.43,11.43],[22.86,11.43],[0,22.86],[11.43,22.86],[22.86,22.86]];
  return cells.map(([x,y]) => `<rect x="${x}" y="${y}" width="9.14" height="9.14" rx="1.6" fill="${fill}"/>`).join('')
    + `<rect x="22.86" y="-1.55" width="9.14" height="9.14" rx="1.6" fill="${accent}" transform="rotate(18 27.43 3.02)"/>`;
}
const fontFace = `<style>@font-face{font-family:F;src:url(data:font/woff2;base64,${FONT}) format('woff2');font-weight:800}</style>`;

// Contenu dans un repère 108×108 (icône adaptative Android). env: prod|preprod ; mono: calque monochrome.
function fg108(env, mono = false) {
  if (env === 'prod') {
    const c = mono ? '#000' : IVOIRE;
    return `<g transform="translate(30.96 30.96) scale(1.44)">${symbol(c, mono ? '#000' : CUIVRE)}</g>`;
  }
  // Préprod : symbole plus petit, remonté ; bandeau « PRÉPROD » dans la zone sûre (cercle r=33).
  const c = mono ? '#000' : PETROLE;
  const s = 1.15, tx = 54 - 16 * s, ty = 27.5;
  const band = mono
    ? `<mask id="m"><rect x="33" y="68" width="42" height="13" rx="6.5" fill="#fff"/><text x="54" y="77.4" text-anchor="middle" font-family="F" font-weight="800" font-size="7.6" letter-spacing="0.25" fill="#000">PRÉPROD</text></mask><rect x="33" y="68" width="42" height="13" rx="6.5" fill="#000" mask="url(#m)"/>`
    : `<rect x="33" y="68" width="42" height="13" rx="6.5" fill="${CUIVRE}"/><text x="54" y="77.4" text-anchor="middle" font-family="F" font-weight="800" font-size="7.6" letter-spacing="0.25" fill="${IVOIRE}">PRÉPROD</text>`;
  return `<g transform="translate(${tx} ${ty}) scale(${s})">${symbol(c, mono ? '#000' : CUIVRE)}</g>${band}`;
}
const bg = (env) => (env === 'prod' ? PETROLE : IVOIRE);

function svg(w, h, viewBox, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${viewBox}">${fontFace}${body}</svg>`;
}

async function render(page, svgText, w, h, out, { transparent = false } = {}) {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svgText}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(50);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out, omitBackground: transparent, clip: { x: 0, y: 0, width: w, height: h } });
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const res = (env) => path.join(repo, 'mobile/android/app/src', env === 'prod' ? 'main' : 'preprod', 'res');
  const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

  for (const env of ['prod', 'preprod']) {
    for (const [d, k] of Object.entries(dens)) {
      const fgSize = Math.round(108 * k), legacy = Math.round(48 * k);
      const dir = path.join(res(env), `mipmap-${d}`);
      await render(page, svg(fgSize, fgSize, '0 0 108 108', fg108(env)), fgSize, fgSize, path.join(dir, 'ic_launcher_foreground.png'), { transparent: true });
      await render(page, svg(fgSize, fgSize, '0 0 108 108', fg108(env, true)), fgSize, fgSize, path.join(dir, 'ic_launcher_monochrome.png'), { transparent: true });
      // Icônes anciennes : zone 72 dp centrale (18..90), carré arrondi / rond.
      const full = (clip) => svg(legacy, legacy, '18 18 72 72',
        `<defs><clipPath id="c">${clip}</clipPath></defs><g clip-path="url(#c)"><rect x="0" y="0" width="108" height="108" fill="${bg(env)}"/>${fg108(env)}</g>`);
      await render(page, full('<rect x="19" y="19" width="70" height="70" rx="14"/>'), legacy, legacy, path.join(dir, 'ic_launcher.png'), { transparent: true });
      await render(page, full('<circle cx="54" cy="54" r="35"/>'), legacy, legacy, path.join(dir, 'ic_launcher_round.png'), { transparent: true });
    }
    // iOS 1024 : fond plein cadre, sans transparence (exigence App Store).
    const set = env === 'prod' ? 'AppIcon.appiconset' : 'AppIcon-Preprod.appiconset';
    const iosOut = path.join(repo, 'mobile/ios/App/App/Assets.xcassets', set, 'AppIcon-512@2x.png');
    const iosBody = env === 'prod'
      ? `<rect width="1024" height="1024" fill="${PETROLE}"/><g transform="translate(184.32 184.32) scale(20.48)">${symbol(IVOIRE, CUIVRE)}</g>`
      : `<rect width="1024" height="1024" fill="${IVOIRE}"/><g transform="translate(240 150) scale(17)">${symbol(PETROLE, CUIVRE)}</g>`
        + `<rect x="232" y="748" width="560" height="140" rx="70" fill="${CUIVRE}"/><text x="512" y="846" text-anchor="middle" font-family="F" font-weight="800" font-size="88" letter-spacing="4" fill="${IVOIRE}">PRÉPROD</text>`;
    await render(page, svg(1024, 1024, '0 0 1024 1024', iosBody), 1024, 1024, iosOut);
  }

  // Écrans de démarrage (communs) : fond ivoire (= SplashScreen.backgroundColor), symbole pétrole centré.
  const splash = (w, h) => {
    const size = Math.min(w, h) * 0.22, s = size / 32;
    return svg(w, h, `0 0 ${w} ${h}`, `<rect width="${w}" height="${h}" fill="${IVOIRE}"/><g transform="translate(${(w - size) / 2} ${(h - size) / 2}) scale(${s})">${symbol(PETROLE, CUIVRE)}</g>`);
  };
  const droot = path.join(repo, 'mobile/android/app/src/main/res');
  for (const d of fs.readdirSync(droot).filter((x) => x.startsWith('drawable'))) {
    const p = path.join(droot, d, 'splash.png');
    if (!fs.existsSync(p)) continue;
    const b = fs.readFileSync(p); const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
    await render(page, splash(w, h), w, h, p);
  }
  const iosSplash = path.join(repo, 'mobile/ios/App/App/Assets.xcassets/Splash.imageset');
  for (const f of fs.readdirSync(iosSplash).filter((x) => x.endsWith('.png'))) {
    await render(page, splash(2732, 2732), 2732, 2732, path.join(iosSplash, f));
  }
  await browser.close();
})();
