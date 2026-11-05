package fr.verebona.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Lot 110A — file persistante des partages natifs Android et jeton d'import.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  · STOCKAGE INTERNE PRIVÉ de l'app (`getFilesDir()/share-import/<id>/`),
 *    jamais le stockage partagé ; sauvegarde désactivée (allowBackup=false).
 *    Un dossier par partage : `manifest.json` (identifiant d'import par
 *    fichier, état fidèle) + copies des fichiers. Écriture atomique
 *    (fichier provisoire puis renommage).
 *  · Purge : copie effacée dès l'accusé serveur ou l'échec définitif ;
 *    dossier effacé à l'acquittement par l'app, à l'annulation, ou après
 *    7 jours ; dossiers provisoires abandonnés effacés après 1 h.
 *  · Jeton d'IMPORT (jamais la session) chiffré AES-GCM par une clé du
 *    Keystore Android (non exportable), dans les préférences privées.
 * ══════════════════════════════════════════════════════════════════════════
 */
final class ShareImportStore {
    private ShareImportStore() {}

    private static final String DIR = "share-import";
    private static final String MANIFEST = "manifest.json";
    private static final String PREFS = "verebona_share_import";
    private static final String KEY_GRANT = "grant";
    private static final String KEY_HINT = "account_hint";
    private static final String KEY_OPEN = "open_request";
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String ALIAS = "verebona_share_import_grant";

    /** Prévenu à chaque changement d'état (plugin : événement `stateChanged`). */
    private static volatile Runnable listener;

    static void setListener(Runnable r) { listener = r; }

    private static void changed() {
        Runnable r = listener;
        if (r != null) {
            try { r.run(); } catch (Exception ignored) { /* vue absente */ }
        }
    }

    static boolean isValidId(String id) {
        return id != null && id.matches("^[A-Fa-f0-9-]{8,64}$");
    }

    static synchronized File root(Context c) {
        File d = new File(c.getFilesDir(), DIR);
        if (!d.exists()) d.mkdirs();
        return d;
    }

    static File dir(Context c, String id) {
        return isValidId(id) ? new File(root(c), id) : null;
    }

    static File file(Context c, String id, String path) {
        File d = dir(c, id);
        if (d == null || path == null || path.contains("/") || path.startsWith(".")) return null;
        return new File(d, path);
    }

    private static JSONObject readJson(File f) {
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[(int) Math.min(f.length(), 1_000_000)];
            int n = 0;
            while (n < buf.length) {
                int r = in.read(buf, n, buf.length - n);
                if (r < 0) break;
                n += r;
            }
            return new JSONObject(new String(buf, 0, n, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return null;
        }
    }

    private static void writeJson(File target, JSONObject o) throws Exception {
        File tmp = new File(target.getParentFile(), "." + target.getName() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(o.toString().getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        }
        if (!tmp.renameTo(target)) throw new java.io.IOException("renommage impossible");
    }

    private static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        f.delete();
    }

    /** Dossier provisoire d'un partage en préparation (rien n'est visible ni envoyé). */
    static synchronized File staging(Context c, String id) {
        File d = new File(root(c), ".tmp-" + id);
        d.mkdirs();
        return d;
    }

    static synchronized void discardStaging(Context c, String id) {
        deleteTree(new File(root(c), ".tmp-" + id));
    }

    /** Publication : manifeste écrit puis renommage du dossier d'un coup. */
    static synchronized void publish(Context c, String id, JSONObject manifest) throws Exception {
        File staging = new File(root(c), ".tmp-" + id);
        writeJson(new File(staging, MANIFEST), manifest);
        File d = dir(c, id);
        if (d == null || !staging.renameTo(d)) throw new java.io.IOException("publication impossible");
        changed();
    }

    static synchronized JSONObject read(Context c, String id) {
        File d = dir(c, id);
        return d == null ? null : readJson(new File(d, MANIFEST));
    }

    /** Partages présents, du plus ancien au plus récent (expirés et provisoires abandonnés purgés). */
    static synchronized List<JSONObject> list(Context c) {
        List<JSONObject> out = new ArrayList<>();
        File[] kids = root(c).listFiles();
        if (kids == null) return out;
        long now = System.currentTimeMillis();
        for (File k : kids) {
            if (k.getName().startsWith(".")) {
                if (now - k.lastModified() > 3600_000L) deleteTree(k);
                continue;
            }
            JSONObject m = readJson(new File(k, MANIFEST));
            if (m == null || !k.getName().equals(m.optString("id"))) { deleteTree(k); continue; }
            if (now - m.optLong("createdAt") > ShareImportContract.LOCAL_TTL_MS) { deleteTree(k); continue; }
            out.add(m);
        }
        Collections.sort(out, (a, b) -> Long.compare(a.optLong("createdAt"), b.optLong("createdAt")));
        return out;
    }

    interface Mutator { void apply(JSONObject manifest) throws Exception; }

    /** Lecture-modification-écriture sous verrou ; copies des fichiers terminés effacées. */
    static synchronized JSONObject update(Context c, String id, Mutator mutator) {
        File d = dir(c, id);
        if (d == null) return null;
        File mf = new File(d, MANIFEST);
        JSONObject m = readJson(mf);
        if (m == null) return null;
        try {
            mutator.apply(m);
            JSONArray files = m.optJSONArray("files");
            if (files != null) {
                for (int i = 0; i < files.length(); i++) {
                    JSONObject f = files.getJSONObject(i);
                    if (ShareImportContract.isFinal(f.optString("state"))) {
                        File copy = file(c, id, f.optString("path"));
                        if (copy != null && copy.exists()) copy.delete();
                    }
                }
            }
            writeJson(mf, m);
        } catch (Exception e) {
            return null;
        }
        changed();
        return m;
    }

    static boolean isSettled(JSONObject m) {
        JSONArray files = m.optJSONArray("files");
        if (files == null || files.length() == 0) return false;
        for (int i = 0; i < files.length(); i++) {
            if (!ShareImportContract.isFinal(files.optJSONObject(i).optString("state"))) return false;
        }
        return true;
    }

    static synchronized void remove(Context c, String id) {
        deleteTree(dir(c, id));
        changed();
    }

    // ── Jeton d'import (chiffré par le Keystore) ─────────────────────────────

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        if (ks.containsAlias(ALIAS)) return (SecretKey) ks.getKey(ALIAS, null);
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        kg.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return kg.generateKey();
    }

    static synchronized boolean saveGrant(Context c, JSONObject grant) {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = cipher.getIV();
            byte[] ct = cipher.doFinal(grant.toString().getBytes(StandardCharsets.UTF_8));
            byte[] all = new byte[iv.length + ct.length];
            System.arraycopy(iv, 0, all, 0, iv.length);
            System.arraycopy(ct, 0, all, iv.length, ct.length);
            prefs(c).edit()
                .putString(KEY_GRANT, Base64.encodeToString(all, Base64.NO_WRAP))
                .putString(KEY_HINT, grant.optString("accountKey"))
                .apply();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** Jeton présent ET non expiré, sinon null. */
    static synchronized JSONObject readGrant(Context c) {
        String raw = prefs(c).getString(KEY_GRANT, null);
        if (raw == null) return null;
        try {
            byte[] all = Base64.decode(raw, Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, all, 0, 12));
            byte[] pt = cipher.doFinal(all, 12, all.length - 12);
            JSONObject g = new JSONObject(new String(pt, StandardCharsets.UTF_8));
            long exp = parseIsoMillis(g.optString("expiresAt"));
            if (exp <= System.currentTimeMillis() || !g.optString("uploadUrl").startsWith("https://")) return null;
            return g;
        } catch (Exception e) {
            return null;
        }
    }

    static synchronized void clearGrant(Context c) {
        prefs(c).edit().remove(KEY_GRANT).apply();
    }

    static String accountHint(Context c) {
        return prefs(c).getString(KEY_HINT, null);
    }

    static void setOpenRequest(Context c, String id) {
        prefs(c).edit().putString(KEY_OPEN, id).apply();
    }

    static synchronized String consumeOpenRequest(Context c) {
        String id = prefs(c).getString(KEY_OPEN, null);
        if (id != null) prefs(c).edit().remove(KEY_OPEN).apply();
        return id;
    }

    /** `2026-11-07T10:00:00.000Z` → millisecondes (format rendu par le serveur). */
    static long parseIsoMillis(String iso) {
        try {
            java.text.SimpleDateFormat f = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.ROOT);
            f.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
            java.util.Date d = f.parse(iso);
            return d == null ? 0 : d.getTime();
        } catch (Exception e) {
            return 0;
        }
    }
}
