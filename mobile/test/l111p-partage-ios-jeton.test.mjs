/**
 * Lot 111P — partage iOS « Vous n'êtes pas connecté » à tort (correctif 110A).
 * Contrôles de contenu sans Mac ni SDK Android : états distincts et textes
 * identiques serveur / Swift / Java, Keychain aux retours distingués et
 * écriture vérifiée, refus serveur attribué au bon jeton (pas de boucle),
 * journal natif sans donnée, garde CI des droits signés.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const WORKFLOW = read('../.github/workflows/mobile-ios.yml');

const policyNotices = () => {
  const block = /SHARE_IMPORT_EXTENSION_NOTICES = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(POLICY)[1];
  return Object.fromEntries([...block.matchAll(/(\w+): '([^']+)'/g)].map((m) => [m[1], m[2]]));
};

test('L111P-TEXTES : mêmes clés et mêmes textes serveur / iOS / Android ; jamais « Vous n’êtes pas connecté »', () => {
  const ts = policyNotices();
  assert.deepEqual(Object.keys(ts).sort(), [
    'mfa_required', 'pending_auth', 'server_unavailable', 'session_refused', 'terms_required', 'token_expired', 'token_missing', 'token_refused', 'token_unreadable',
  ]);
  assert.equal(ts.token_missing, 'L’import se terminera à la prochaine ouverture de Verebona, sans rien resélectionner.');
  const swift = Object.fromEntries([...CORE.matchAll(/^\s*"(\w+)": "([^"]+)",$/gm)].map((m) => [m[1], m[2]]));
  const java = Object.fromEntries([...CONTRACT.matchAll(/\{ "(\w+)", "([^"]+)" \}/g)].filter((m) => m[1] in ts).map((m) => [m[1], m[2]]));
  assert.deepEqual(swift, ts);
  assert.deepEqual(java, ts);
  for (const [name, src] of Object.entries({ CORE, EXT, VIEW, PLUGIN_IOS, RECEIVER, WORKER, STORE, CONTRACT, POLICY })) {
    assert.ok(!/n’êtes pas connecté|n'êtes pas connecté/.test(noComments(src)), `${name} : aucune déconnexion affirmée`);
    // « Reconnectez-vous » reste admis pour SESSION_REVOKED (fin de session constatée par le serveur).
    assert.ok(!/(?<!re)connectez-vous pour terminer/.test(noComments(src)), `${name} : aucun « connectez-vous » sans preuve`);
  }
  // Aucun texte n'affirme une déconnexion : seule la fin de session CONSTATÉE par le serveur en parle.
  for (const [k, v] of Object.entries(ts)) if (k !== 'session_refused' && k !== 'mfa_required') assert.ok(!/connect/i.test(v), k);
});

test('L111P-ETATS : état constaté du jeton (present / missing / expired / refused / unreadable), même règle iOS / Android', () => {
  for (const st of ['present', 'missing', 'expired', 'refused', 'unreadable']) {
    assert.ok(CORE.includes(`"${st}"`), `iOS ${st}`);
    assert.ok(CONTRACT.includes(`"${st}"`), `Android ${st}`);
    assert.ok(read('../src/lib/native/share-import.ts').includes(`'${st}'`), `web ${st}`);
  }
  // Clé du texte : SESSION_REVOKED / MFA_REQUIRED / CGUV distingués, autre refus = jeton à renouveler.
  for (const [code, key] of [['SESSION_REVOKED', 'session_refused'], ['MFA_REQUIRED', 'mfa_required'], ['CGUV_REACCEPTANCE_REQUIRED', 'terms_required']]) {
    assert.match(CORE, new RegExp(`case "${code}": return "${key}"`));
    assert.match(CONTRACT, new RegExp(`"${code}"\\.equals\\(refusedCode\\)\\) return "${key}"`));
  }
  // Codes de refus renouvelables : identiques partout.
  const tsCodes = /SHARE_IMPORT_RENEWABLE_REFUSALS = Object\.freeze\(\[([\s\S]*?)\]/.exec(POLICY)[1].match(/'[A-Z_]+'/g).map((x) => x.slice(1, -1)).sort();
  const swiftCodes = /static let renewable: Set<String> = \[([^\]]+)\]/.exec(CORE)[1].match(/"[A-Z_]+"/g).map((x) => x.slice(1, -1)).sort();
  const javaCodes = /RENEWABLE_REFUSALS = \{([\s\S]*?)\};/.exec(CONTRACT)[1].match(/"[A-Z_]+"/g).map((x) => x.slice(1, -1)).sort();
  assert.deepEqual(swiftCodes, tsCodes);
  assert.deepEqual(javaCodes, tsCodes);
  // L'extension et l'activité affichent l'état constaté, plus un booléen « connecté ».
  assert.ok(!/signedIn/.test(EXT + VIEW + RECEIVER));
  assert.match(EXT, /VBGrantState\.current\(\)/);
  assert.match(EXT, /model\.notice = VBShareNotice\.text\(for: grantState\)/);
  assert.match(VIEW, /if model\.phase == \.ready, let notice = model\.notice/);
  assert.match(RECEIVER, /ShareImportStore\.grantState\(this\)/);
  assert.match(RECEIVER, /ShareImportContract\.noticeKey\(gs\[0\], gs\[2\]\)/);
});

test('L111P-KEYCHAIN : retours distingués, accessibilité après 1er déverrouillage, écriture vérifiée sans fenêtre vide', () => {
  for (const [constant, code] of [['errSecItemNotFound', 'NOT_FOUND'], ['errSecInteractionNotAllowed', 'LOCKED'], ['errSecMissingEntitlement', 'MISSING_ENTITLEMENT']]) {
    assert.match(CORE, new RegExp(`case ${constant}: return "${code}"`));
  }
  assert.match(CORE, /return VBGrantRead\(grant: nil, code: "DECODE"\)/);
  assert.match(CORE, /return VBGrantRead\(grant: nil, code: "NO_APP_GROUP"\)/);
  assert.match(CORE, /default: return "OS_\\\(status\)"/);
  // Accessibilité inchangée (envoi de fond, extension) : après le premier déverrouillage, propre à l'appareil.
  assert.match(CORE, /kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly/);
  assert.match(CORE, /kSecAttrAccessGroup as String: VBShareImport\.appGroup/);
  // Mise à jour en place d'abord, ajout sinon, relecture du MÊME jeton.
  const write = /static func write\(_ grant: VBShareGrant\) -> String \{[\s\S]*?\n    \}\n/.exec(CORE)[0];
  assert.ok(write.indexOf('SecItemUpdate') < write.indexOf('SecItemAdd'));
  assert.match(write, /guard check\.grant\?\.token == grant\.token else \{ return "VERIFY_\\\(check\.code\)" \}/);
  // Le plugin rend le motif (KEYCHAIN_<code>) au lieu d'un échec muet.
  assert.match(PLUGIN_IOS, /call\.reject\("Enregistrement impossible", "KEYCHAIN_\\\(written\)"\)/);
  // Android : commit synchrone + relecture, motif KEYSTORE_<code>, lecture distinguée.
  assert.match(STORE, /\.commit\(\);/);
  assert.match(STORE, /return "VERIFY_" \+ check\[1\]/);
  assert.match(STORE, /new Object\[\] \{ null, "KEYSTORE" \}/);
  assert.match(STORE, /new Object\[\] \{ null, "NOT_FOUND" \}/);
  assert.match(PLUGIN_ANDROID, /call\.reject\("Enregistrement impossible", "KEYSTORE_" \+ written\)/);
});

test('L111P-REFUS : refus serveur attribué au jeton utilisé (référence non secrète), jamais renvoyé en boucle', () => {
  // Référence = 12 hex de SHA-256(jeton), comme `shareImportGrantRef` (token_hash tronqué).
  assert.match(CORE, /SHA256\.hash\(data: Data\(token\.utf8\)\)/);
  assert.match(CORE, /\.prefix\(12\)/);
  assert.match(STORE, /MessageDigest\.getInstance\("SHA-256"\)/);
  assert.match(STORE, /for \(int i = 0; i < 6; i\+\+\)/);
  assert.match(read('../src/services/mobile/share-import/grants.ts'), /tokenHash\.slice\(0, SHARE_IMPORT_GRANT_REF_LENGTH\)/);
  assert.match(POLICY, /SHARE_IMPORT_GRANT_REF_LENGTH = 12/);
  // iOS : référence portée par la tâche ; refus marqué ; jeton refusé non « utilisable » ; reprise immédiate seulement avec un jeton PLUS RÉCENT.
  assert.match(CORE, /task\.taskDescription = "\\\(m\.id\)\|\\\(m\.files\[i\]\.operationId\)\|\\\(g\.ref\)"/);
  assert.match(CORE, /if outcome == "auth", let ref = usedRef, let code = serverCode \{ VBShareRefusals\.mark\(ref: ref, code: code\) \}/);
  assert.match(CORE, /var usable: VBShareGrant\? \{ status == "present" \? raw : nil \}/);
  assert.match(CORE, /fresh\.ref != usedRef/);
  assert.match(CORE, /VBShareRefusals\.clear\(\)/);
  // Android : même règle, nouvel essai borné par MAX_ATTEMPTS.
  assert.match(WORKER, /ShareImportStore\.markRefused\(c, usedRef, code\)/);
  assert.match(WORKER, /!usedRef\.equals\(ShareImportStore\.ref\(fresh\.optString\("token"\)\)\)\s*&& getRunAttemptCount\(\) \+ 1 < ShareImportContract\.MAX_ATTEMPTS/);
  assert.match(STORE, /if \(refusalFor\(c, ref\(g\.optString\("token"\)\)\) != null\) return null;/);
  assert.match(STORE, /\.remove\(KEY_REFUSAL\)/);
  // État rendu à la vue : référence et dernier refus, jamais le jeton.
  assert.match(PLUGIN_IOS, /"ref": g\.ref/);
  assert.match(PLUGIN_IOS, /gd\["refusedCode"\] = c/);
  assert.match(PLUGIN_ANDROID, /gs\.put\("ref", ShareImportStore\.ref\(g\.optString\("token"\)\)\)/);
  assert.ok(!/"token": g\.token|out\["token"\]|gd\["token"\]/.test(PLUGIN_IOS));
  assert.ok(!/gs\.put\("token"|out\.put\("token"/.test(PLUGIN_ANDROID));
});

test('L111P-DIAG : journal natif à codes seuls (jamais jeton, nom de fichier, compte), rendu par getState', () => {
  assert.match(CORE, /code\.range\(of: "\^\[A-Z0-9_-\]\{1,48\}\$", options: \.regularExpression\)/);
  assert.match(STORE, /code\.matches\("\^\[A-Z0-9_-\]\{1,48\}\$"\)/);
  const logs = [...(CORE + EXT + PLUGIN_IOS).matchAll(/VBShareDiag\.log\(([^\n]+)\)/g)].map((m) => m[1]);
  assert.ok(logs.length >= 8);
  for (const l of logs) assert.ok(!/token|\.name|accountKey|uploadUrl|message/.test(l.replace(/VBShareDiag\.safe\(serverCode\)/g, '')), l);
  const jlogs = [...(WORKER + RECEIVER + PLUGIN_ANDROID).matchAll(/ShareImportStore\.diag\((?:c|this|getContext\(\)), ([^\n]+)\)/g)].map((m) => m[1]);
  assert.ok(jlogs.length >= 5);
  for (const l of jlogs) assert.ok(!/token|"name"|accountKey|uploadUrl/.test(l), l);
  assert.match(PLUGIN_IOS, /"diagnostics": VBShareDiag\.entries\(\)/);
  assert.match(PLUGIN_ANDROID, /out\.put\("diagnostics"/);
  for (const code of ['EXT_SHOWN_', 'UPLOAD_AUTH_', 'UPLOAD_OK', 'APP_SETGRANT_']) {
    assert.ok(CORE.includes(code) || EXT.includes(code) || PLUGIN_IOS.includes(code), `iOS ${code}`);
    assert.ok(WORKER.includes(code) || RECEIVER.includes(code) || PLUGIN_ANDROID.includes(code), `Android ${code}`);
  }
});

test('L111P-CI : droits SIGNÉS contrôlés (groupe d’apps des deux binaires, même équipe, keychain-access-groups relevé)', () => {
  const step = /- name: Garde-fou — droits signés du partage \(groupe d'apps, Keychain\)[\s\S]*?\n {6}# Lot 108G/.exec(WORKFLOW)?.[0];
  assert.ok(step, 'étape présente');
  assert.ok(WORKFLOW.indexOf('Garde-fou — droits signés du partage') < WORKFLOW.indexOf('- name: Envoyer à App Store Connect (TestFlight)'));
  assert.match(step, /codesign -d --entitlements - --xml "\$b"/);
  // Lot 112 (correctif 4) : lecture des clés par JSON (plutil -extract prenait les points du nom
  // de la clé pour des séparateurs) ; mêmes contrôles, dans signed-entitlements-guard.mjs.
  assert.match(step, /plutil -convert json/);
  assert.doesNotMatch(step, /plutil -extract com\./);
  assert.match(step, /node mobile\/scripts\/signed-entitlements-guard\.mjs "\$GROUP"/);
  assert.match(step, /Print VBAppGroup/);
  assert.match(step, /for b in "\$APP" "\$EXT"; do/);
  const guard = readFileSync(new URL('../scripts/signed-entitlements-guard.mjs', import.meta.url), 'utf8');
  for (const k of ['com.apple.security.application-groups', 'keychain-access-groups', 'com.apple.developer.team-identifier', 'GITHUB_STEP_SUMMARY']) assert.ok(guard.includes(k), k);
});
