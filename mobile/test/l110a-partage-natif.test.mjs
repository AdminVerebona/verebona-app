/**
 * Lot 110A — partage natif iOS / Android à trois choix (décision PO du 04/11/2026).
 * Tests du dossier mobile/ (`npm test`), sans Mac ni SDK Android : cohérence du
 * contrat entre le serveur (src/lib/mobile/share-import-policy.ts), l'extension
 * iOS (Swift), l'activité Android (Java), le projet Xcode, les Info.plist,
 * l'AndroidManifest et Gradle ; garde-fou « jamais une option “et ouvrir” qui
 * n'ouvre pas » sur iOS.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHARE_IMPORT, resolveBuildConfig, resolveShareImportConfig } from '../config/environments.mjs';
import { generatedFiles } from '../scripts/prepare.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(resolve(here, '..', rel), 'utf8');
const noComments = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const POLICY = read('../src/lib/mobile/share-import-policy.ts');
const CORE = read('ios/App/Shared/VerebonaShareImportCore.swift');
const EXT = read('ios/App/ShareExtension/ShareViewController.swift');
const VIEW = read('ios/App/ShareExtension/ShareImportView.swift');
const PLUGIN_IOS = read('ios/App/App/VerebonaShareImportPlugin.swift');
const JAVA_DIR = 'android/app/src/main/java/fr/verebona/app/';
const CONTRACT = read(`${JAVA_DIR}ShareImportContract.java`);
const RECEIVER = read(`${JAVA_DIR}ShareReceiverActivity.java`);
const WORKER = read(`${JAVA_DIR}ShareImportWorker.java`);
const STORE = read(`${JAVA_DIR}ShareImportStore.java`);
const PLUGIN_ANDROID = read(`${JAVA_DIR}VerebonaShareImportPlugin.java`);
const MANIFEST = read('android/app/src/main/AndroidManifest.xml');

/** Types du contrat serveur : [{ mime, ext, uti }]. */
const TYPES = [...POLICY.matchAll(/\{ mime: '([^']+)', ext: '([^']+)', uti: '([^']+)' \}/g)].map((m) => ({ mime: m[1], ext: m[2], uti: m[3] }));

test('L110A-CONTRAT : libellés identiques serveur / iOS / Android', () => {
  const labels = {
    importAndOpen: /importAndOpen: '([^']+)'/.exec(POLICY)[1],
    importOnly: /importOnly: '([^']+)'/.exec(POLICY)[1],
    cancel: /cancel: '([^']+)'/.exec(POLICY)[1],
  };
  assert.deepEqual(labels, { importAndOpen: 'Importer et ouvrir Verebona', importOnly: 'Importer sans ouvrir', cancel: 'Annuler' });
  assert.ok(CORE.includes(`importAndOpen = "${labels.importAndOpen}"`));
  assert.ok(CORE.includes(`importOnly = "${labels.importOnly}"`));
  assert.ok(CORE.includes(`cancel = "${labels.cancel}"`));
  assert.ok(CONTRACT.includes(`LABEL_IMPORT_AND_OPEN = "${labels.importAndOpen}"`));
  assert.ok(CONTRACT.includes(`LABEL_IMPORT_ONLY = "${labels.importOnly}"`));
  assert.ok(CONTRACT.includes(`LABEL_CANCEL = "${labels.cancel}"`));
  // États fidèles : mêmes clés partout.
  for (const st of ['queued', 'uploading', 'waiting_network', 'waiting_auth', 'imported', 'failed']) {
    assert.ok(POLICY.includes(`${st}:`), st);
    assert.ok(CORE.includes(`"${st}"`), st);
    assert.ok(CONTRACT.includes(`"${st}"`), st);
  }
});

test('L110A-FORMATS : même liste serveur / Swift / Java / manifeste / règle d’activation iOS ; HEIC converti', () => {
  assert.equal(TYPES.length, 11);
  const swiftDirect = [...EXT.matchAll(/\("([^"]+)", "([^"]+)", "([a-z]+)"\)/g)].map((m) => ({ uti: m[1], mime: m[2], ext: m[3] }));
  assert.deepEqual(new Set(swiftDirect.map((t) => t.mime)), new Set(TYPES.map((t) => t.mime)));
  for (const t of TYPES) assert.ok(swiftDirect.some((s) => s.uti === t.uti && s.mime === t.mime && s.ext === t.ext), t.mime);
  const javaTypes = [...CONTRACT.matchAll(/\{ "([^"]+)", "([a-z]+)" \}/g)].map((m) => ({ mime: m[1], ext: m[2] }));
  assert.deepEqual(new Set(javaTypes.map((t) => `${t.mime}:${t.ext}`)), new Set(TYPES.map((t) => `${t.mime}:${t.ext}`)));
  // Activation iOS : documents (le texte seul ne fait pas apparaître Verebona) + toute image (HEIC converti).
  const rule = /<key>NSExtensionActivationRule<\/key>\s*<string>([^<]+)<\/string>/.exec(read('ios/App/ShareExtension/Info.plist'))[1];
  for (const t of TYPES.filter((x) => !x.mime.startsWith('image/') && x.mime !== 'text/plain')) assert.ok(rule.includes(`"${t.uti}"`), t.uti);
  assert.ok(rule.includes('"public.image"'));
  assert.ok(!rule.includes('public.plain-text') && !rule.includes('public.text"') && !rule.includes('public.url'));
  // Android : réception par l'activité dédiée, mêmes formats (sans texte seul), images (HEIC) comprises.
  const receiver = /<activity\s+android:name="\.ShareReceiverActivity"[\s\S]*?<\/activity>/.exec(MANIFEST)[0];
  for (const t of TYPES.filter((x) => !x.mime.startsWith('image/') && x.mime !== 'text/plain')) assert.ok(receiver.includes(`android:mimeType="${t.mime}"`), t.mime);
  assert.ok(receiver.includes('android:mimeType="image/*"'));
  assert.ok(!/action\.SEND"[\s\S]*?android:mimeType="text\/plain"/.test(receiver));
  // Stratégie HEIC explicite et identique.
  assert.match(POLICY, /SHARE_IMPORT_HEIC_STRATEGY = 'convert-to-jpeg'/);
  assert.match(EXT, /convertToJPEG/);
  assert.match(RECEIVER, /ImageDecoder\.decodeBitmap/);
  assert.match(RECEIVER, /Build\.VERSION_CODES\.P/);
  // Limites alignées sur le dépôt (10 fichiers, 25 Mo).
  assert.match(CORE, /maxFiles = 10/); assert.match(CORE, /maxBytes = 25_000_000/);
  assert.match(CONTRACT, /MAX_FILES = 10/); assert.match(CONTRACT, /MAX_BYTES = 25_000_000L/);
});

test('L110A-IOS-OUVRIR : jamais d’option « et ouvrir » sur iOS, aucun contournement privé', () => {
  assert.equal(SHARE_IMPORT.ios.openAppChoice, false);
  assert.throws(() => resolveShareImportConfig({ ...SHARE_IMPORT, ios: { ...SHARE_IMPORT.ios, openAppChoice: true } }), /aucune API publique/);
  assert.throws(() => resolveShareImportConfig({ ...SHARE_IMPORT, ios: { ...SHARE_IMPORT.ios, importLabel: 'Importer et ouvrir Verebona' } }), /libellé non validé/);
  const code = noComments(EXT + VIEW + CORE);
  assert.ok(!/VBShareLabels\.importAndOpen/.test(code), 'le libellé « et ouvrir » n’est jamais affiché par l’extension');
  assert.ok(!/UIApplication|openURL|extensionContext\?\.open|\.open\(|UIResponder|next\s*\?|sel_registerName|perform\(|NSSelectorFromString/.test(code), 'aucune ouverture (même indirecte) de l’app');
  assert.match(EXT, /completeRequest\(returningItems: \[\], completionHandler: nil\)/);
  assert.match(EXT, /cancelRequest\(withError:/);
  // Plus de grande alerte « Document prêt… OK ».
  assert.ok(!/Document prêt à importer|"OK"/.test(EXT + VIEW));
});

test('L110A-IOS-IMPORT : choix = import immédiat (arrière-plan, groupe d’apps), annulation = aucun envoi', () => {
  // Envoi lancé AVANT la fermeture ; annulation : copies provisoires effacées, aucune tâche réseau.
  const commit = /private func commit\(\) \{[\s\S]*?\n    \}\n/.exec(EXT)[0];
  assert.ok(commit.indexOf('VBShareUploader.shared.start') < commit.indexOf('completeRequest'));
  assert.match(commit, /model\.phase = \.sending/, 'double toucher : un seul import');
  const cancel = /private func cancel\(\) \{[\s\S]*?\n    \}\n/.exec(EXT)[0];
  assert.ok(!/Uploader|URLSession|upload/.test(cancel));
  assert.match(cancel, /removeItem\(at: s\)/);
  // URLSession d'arrière-plan partagée avec le groupe d'apps, sans cookie de session.
  assert.match(CORE, /URLSessionConfiguration\.background\(withIdentifier: identifier\)/);
  assert.match(CORE, /sharedContainerIdentifier = VBShareImport\.appGroup/);
  assert.match(CORE, /sessionSendsLaunchEvents = true/);
  assert.match(CORE, /httpShouldSetCookies = false/);
  assert.match(CORE, /uploadTask\(with: req, fromFile: file\)/);
  // Jeton d'import (jamais la session) dans le Keychain du groupe d'apps.
  assert.match(CORE, /kSecAttrAccessGroup as String: VBShareImport\.appGroup/);
  assert.match(CORE, /kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly/);
  assert.match(CORE, /"Bearer \\\(g\.token\)"/);
  // Isolation : envoi seulement avec le jeton DU compte du partage.
  assert.match(CORE, /g\.accountKey == m\.accountKey/);
  // Accusé : seul un 2xx « imported » vaut succès ; 2xx illisible = nouvel essai.
  assert.match(CORE, /if o == "imported" \{ return \(200\.\.<300\)\.contains\(status\) \? "imported" : "retry" \}/);
  assert.match(CORE, /if \(200\.\.<300\)\.contains\(status\) \{ return "retry" \}/);
  // Purge des copies terminées, coordination entre processus, 7 jours.
  assert.match(CORE, /NSFileCoordinator/);
  assert.match(CORE, /where VBShareState\.isFinal\(f\.state\)/);
  assert.match(CORE, /localTtl: TimeInterval = 7 \* 24 \* 3600/);
  // Application réveillée à la fin de l'envoi ; plugin enregistré.
  assert.match(read('ios/App/App/AppDelegate.swift'), /handleEventsForBackgroundURLSession identifier: String[\s\S]*VBShareUploader\.shared\.handleEvents/);
  assert.match(read('ios/App/App/VerebonaBridgeViewController.swift'), /registerPluginInstance\(VerebonaShareImportPlugin\(\)\)/);
  assert.match(PLUGIN_IOS, /jsName = "VerebonaShareImport"/);
  assert.ok(!/"token":\s*g\.token|out\["token"\]/.test(PLUGIN_IOS), 'le jeton n’est jamais rendu à la vue');
  // Notification (option B) sans nom de fichier.
  const notif = /private func notifyIfEnabled[\s\S]*?\n    \}\n/.exec(CORE)[0];
  assert.ok(!/\.name/.test(notif.replace(/identifier:/g, '')), 'aucun nom de fichier dans la notification');
});

test('L110A-XCODE : cœur partagé dans les deux cibles, réglages d’environnement générés', () => {
  const pbx = read('ios/App/App.xcodeproj/project.pbxproj');
  const phase = (id) => new RegExp(`${id} /\\* Sources \\*/ = \\{[\\s\\S]*?files = \\(([\\s\\S]*?)\\);`).exec(pbx)[1];
  const app = phase('504EC3001FED79650016851F');
  const ext = phase('1086E0012F0A00000000000E');
  assert.match(app, /VerebonaShareImportCore\.swift in Sources/);
  assert.match(app, /VerebonaShareImportPlugin\.swift in Sources/);
  assert.match(ext, /VerebonaShareImportCore\.swift in Sources/);
  assert.match(ext, /ShareImportView\.swift in Sources/);
  assert.ok(!/VerebonaShareImportPlugin/.test(ext), 'aucun code Capacitor dans l’extension');
  assert.match(pbx, /110A00012F0A000000000008 \/\* Shared \*\/ = \{[\s\S]*?path = Shared;/);
  for (const env of [{ VEREBONA_ENV: 'preprod', VEREBONA_APP_ORIGIN: 'https://app.preprod.verebona.fr' }, { VEREBONA_ENV: 'prod', VEREBONA_APP_ORIGIN: 'https://app.verebona.fr' }]) {
    const files = generatedFiles(resolveBuildConfig(env));
    // Arbitrage PO du 05/11/2026 : iOS = « Importer dans Verebona » + « Annuler », notification « Touchez pour l’ouvrir » après enregistrement.
    assert.match(files['ios/Verebona.xcconfig'], /VB_SHARE_COMPLETION_NOTICE = YES\n/);
    assert.match(files['ios/Verebona.xcconfig'], /VB_SHARE_IMPORT_LABEL = Importer dans Verebona\n/);
    assert.match(files['android/verebona.properties'], /shareOpenApp=true\n/);
  }
  for (const p of ['ios/App/App/Info.plist', 'ios/App/ShareExtension/Info.plist']) {
    const plist = read(p);
    assert.match(plist, /<key>VBShareCompletionNotice<\/key>\s*<string>\$\(VB_SHARE_COMPLETION_NOTICE\)<\/string>/);
    assert.match(plist, /<key>VBShareImportLabel<\/key>\s*<string>\$\(VB_SHARE_IMPORT_LABEL\)<\/string>/);
    assert.match(plist, /<key>VBAppGroup<\/key>\s*<string>\$\(VB_APP_GROUP\)<\/string>/);
  }
  // Mêmes droits qu'au lot 108G : groupe d'apps (Keychain partagé par le groupe), aucun nouveau droit.
  for (const p of ['ios/App/App/App.entitlements', 'ios/App/ShareExtension/ShareExtension.entitlements']) {
    assert.match(read(p), /com\.apple\.security\.application-groups<\/key>\s*<array>\s*<string>\$\(VB_APP_GROUP\)<\/string>/);
  }
  assert.ok(!/keychain-access-groups/.test(read('ios/App/ShareExtension/ShareExtension.entitlements')));
});

test('L110A-ANDROID : activité de réception, WorkManager, stockage interne privé, trois choix', () => {
  const main = /<activity[\s\S]*?android:name="\.MainActivity"[\s\S]*?<\/activity>/.exec(MANIFEST)[0];
  assert.ok(!/action\.SEND/.test(main), 'MainActivity ne reçoit plus les partages (plus de formulaire prérempli)');
  const receiver = /<activity\s+android:name="\.ShareReceiverActivity"[\s\S]*?<\/activity>/.exec(MANIFEST)[0];
  assert.match(receiver, /android:exported="true"/);
  assert.match(receiver, /android\.intent\.action\.SEND"/);
  assert.match(receiver, /android\.intent\.action\.SEND_MULTIPLE"/);
  assert.match(receiver, /android:excludeFromRecents="true"/);
  assert.match(receiver, /Theme\.Translucent\.NoTitleBar/);
  // Trois choix, « et ouvrir » piloté par la configuration (vrai : ouvre réellement l'app).
  assert.match(RECEIVER, /R\.bool\.vb_share_open_app[\s\S]*LABEL_IMPORT_AND_OPEN[\s\S]*LABEL_IMPORT_ONLY[\s\S]*LABEL_CANCEL/);
  assert.match(RECEIVER, /new Intent\(this, MainActivity\.class\)/);
  assert.match(RECEIVER, /if \(decided\) return; \/\/ double toucher/);
  const cancel = /private void cancel\(\) \{[\s\S]*?\n    \}\n/.exec(RECEIVER)[0];
  assert.ok(!/Worker|startShare|HttpURLConnection/.test(cancel), 'Annuler : aucun envoi');
  assert.match(cancel, /discardStaging/);
  // Stockage interne privé uniquement ; purge.
  const all = RECEIVER + STORE + WORKER;
  assert.ok(!/getExternal|MediaStore|Environment\.DIRECTORY|EXTERNAL_STORAGE/.test(all));
  assert.match(STORE, /c\.getFilesDir\(\), DIR/);
  assert.match(STORE, /LOCAL_TTL_MS/);
  assert.match(STORE, /AES\/GCM\/NoPadding/);
  // WorkManager : travail unique par identifiant d'import, réseau requis, reprise exponentielle.
  assert.match(WORKER, /enqueueUniqueWork\("vb-share-" \+ operationId, ExistingWorkPolicy\.KEEP/);
  assert.match(WORKER, /setRequiredNetworkType\(NetworkType\.CONNECTED\)/);
  assert.match(WORKER, /BackoffPolicy\.EXPONENTIAL/);
  assert.match(WORKER, /account\.equals\(grant\.optString\("accountKey"\)\)/);
  assert.match(CONTRACT, /if \(bodyOutcome\.equals\("imported"\)\) return status >= 200 && status < 300 \? "imported" : "retry";/);
  assert.match(CONTRACT, /if \(status >= 200 && status < 300\) return "retry";/);
  // Mêmes en-têtes que la route serveur.
  const route = read('../src/app/api/mobile/share-import/upload/route.ts');
  for (const h of ['X-Verebona-Operation-Id', 'X-Verebona-File-Name', 'X-Verebona-Sha256']) {
    assert.ok(route.toLowerCase().includes(h.toLowerCase()), h);
    assert.ok(CORE.includes(`"${h}"`), h);
    assert.ok(WORKER.includes(`"${h}"`), h);
  }
  // Plugin enregistré, jeton jamais rendu à la vue.
  assert.match(read(`${JAVA_DIR}MainActivity.java`), /registerPlugin\(VerebonaShareImportPlugin\.class\)/);
  assert.match(PLUGIN_ANDROID, /@CapacitorPlugin\(name = "VerebonaShareImport"\)/);
  assert.ok(!/gs\.put\("token"|out\.put\("token"/.test(PLUGIN_ANDROID));
  // Gradle.
  assert.match(read('android/app/build.gradle'), /implementation "androidx\.work:work-runtime:\$androidxWorkVersion"/);
  assert.match(read('android/app/build.gradle'), /resValue "bool", "vb_share_open_app", vb\('shareOpenApp', 'true'\)/);
  assert.match(read('android/variables.gradle'), /androidxWorkVersion = '2\.\d+\.\d+'/);
  assert.match(read('android/app/src/main/res/values/styles.xml'), /name="VerebonaShareDialog"/);
  assert.match(read('android/app/src/main/res/values-night/styles.xml'), /name="VerebonaShareDialog"/);
});

test('L110A-WEB : plugin déclaré au pont, même nom sur les deux OS', () => {
  const bridge = read('../src/lib/native/bridge.ts');
  assert.match(bridge, /shareImport: 'VerebonaShareImport'/);
  for (const m of ['getState', 'setGrant', 'clearGrant', 'acknowledge', 'resume', 'consumeOpenRequest']) {
    assert.ok(PLUGIN_IOS.includes(`name: "${m}"`), `iOS ${m}`);
    assert.ok(new RegExp(`public void ${m}\\(PluginCall call\\)`).test(PLUGIN_ANDROID), `Android ${m}`);
  }
});
