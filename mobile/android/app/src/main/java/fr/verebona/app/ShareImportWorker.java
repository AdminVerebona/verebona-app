package fr.verebona.app;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

/**
 * Lot 110A — envoi d'un fichier partagé par WorkManager (application fermée).
 *
 *  · un travail UNIQUE par identifiant d'import (`vb-share-<operationId>`,
 *    KEEP) : double toucher, reprise, redémarrage → jamais deux envois
 *    simultanés ; le serveur rend de toute façon le document existant pour
 *    un identifiant déjà importé (idempotence) ;
 *  · contrainte réseau (CONNECTED), reprise exponentielle sur incident
 *    passager ; WorkManager persiste les travaux (redémarrage du téléphone,
 *    fermeture forcée) ;
 *  · « Document ajouté » seulement sur l'accusé du serveur ; refus définitif
 *    (format, quota…) : état « Échec » + cause, copie purgée ; jeton absent /
 *    expiré / session close : « En attente de connexion », reprise au
 *    prochain jeton (ouverture de Verebona).
 */
public class ShareImportWorker extends Worker {
    private static final String TAG = "vb-share-import";

    public ShareImportWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    /** Lance l'envoi des fichiers non terminés d'un partage, avec le jeton DE SON compte. */
    static void startShare(Context c, String shareId) {
        // Lot 111P : jeton UTILISABLE = présent, non échu et non refusé par le serveur (pas de renvoi en boucle).
        final JSONObject grant = ShareImportStore.readGrant(c);
        final String[] gs = ShareImportStore.grantState(c);
        final String waitMessage = waitingMessage(gs);
        final boolean[] waiting = { false };
        final java.util.List<String> toEnqueue = new java.util.ArrayList<>();
        ShareImportStore.update(c, shareId, m -> {
            String account = m.isNull("accountKey") ? null : m.optString("accountKey", null);
            String hint = m.isNull("accountHint") ? null : m.optString("accountHint", null);
            if (account == null && grant != null && (hint == null || hint.equals(grant.optString("accountKey")))) {
                account = grant.optString("accountKey");
                m.put("accountKey", account);
            }
            boolean usable = grant != null && account != null && account.equals(grant.optString("accountKey"));
            JSONArray files = m.getJSONArray("files");
            for (int i = 0; i < files.length(); i++) {
                JSONObject f = files.getJSONObject(i);
                String st = f.optString("state");
                if (ShareImportContract.isFinal(st)) continue;
                if (!usable) {
                    f.put("state", ShareImportContract.WAITING_AUTH);
                    f.put("code", gs[2] != null ? gs[2] : grant != null ? "LOCAL_OTHER_ACCOUNT" : "LOCAL_" + gs[0].toUpperCase(java.util.Locale.ROOT));
                    f.put("message", waitMessage);
                    waiting[0] = true;
                    continue;
                }
                if (!ShareImportContract.UPLOADING.equals(st)) {
                    f.put("state", ShareImportContract.QUEUED);
                    f.remove("message");
                }
                toEnqueue.add(f.getString("operationId"));
            }
        });
        for (String op : toEnqueue) enqueue(c, shareId, op);
        if (waiting[0]) ShareImportStore.diag(c, "UPLOAD_WAIT_" + gs[0].toUpperCase(java.util.Locale.ROOT) + "_" + gs[1]);
    }

    /** Texte d'attente CONSTATÉ (mêmes textes qu'iOS), jamais « connectez-vous » sans preuve. */
    static String waitingMessage(String[] gs) {
        String t = ShareImportContract.notice(ShareImportContract.noticeKey(gs[0], gs[2]));
        return t != null ? t : ShareImportContract.notice("token_missing");
    }

    static void resumeAll(Context c) {
        for (JSONObject m : ShareImportStore.list(c)) {
            if (!ShareImportStore.isSettled(m)) startShare(c, m.optString("id"));
        }
    }

    private static void enqueue(Context c, String shareId, String operationId) {
        Constraints constraints = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        OneTimeWorkRequest req = new OneTimeWorkRequest.Builder(ShareImportWorker.class)
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .setInputData(new Data.Builder().putString("shareId", shareId).putString("operationId", operationId).build())
            .addTag(TAG)
            .build();
        WorkManager.getInstance(c).enqueueUniqueWork("vb-share-" + operationId, ExistingWorkPolicy.KEEP, req);
    }

    @NonNull
    @Override
    public Result doWork() {
        final Context c = getApplicationContext();
        final String shareId = getInputData().getString("shareId");
        final String operationId = getInputData().getString("operationId");
        JSONObject m = ShareImportStore.read(c, shareId);
        if (m == null || operationId == null) return Result.success(); // partage acquitté ou purgé
        JSONObject f = findFile(m, operationId);
        if (f == null || ShareImportContract.isFinal(f.optString("state"))) return Result.success();
        JSONObject grant = ShareImportStore.readGrant(c);
        String account = m.isNull("accountKey") ? null : m.optString("accountKey", null);
        if (grant == null || account == null || !account.equals(grant.optString("accountKey"))) {
            String[] gs = ShareImportStore.grantState(c);
            setState(c, shareId, operationId, ShareImportContract.WAITING_AUTH, gs[2] != null ? gs[2] : "LOCAL_" + gs[0].toUpperCase(java.util.Locale.ROOT), waitingMessage(gs), null, false);
            return Result.success(); // repris au prochain jeton (setGrant)
        }
        final String usedRef = ShareImportStore.ref(grant.optString("token"));
        File copy = ShareImportStore.file(c, shareId, f.optString("path"));
        if (copy == null || !copy.exists()) {
            setState(c, shareId, operationId, ShareImportContract.FAILED, "LOCAL_FILE_MISSING", "Fichier plus disponible sur ce téléphone : partagez-le de nouveau.", null, false);
            return Result.success();
        }
        setState(c, shareId, operationId, ShareImportContract.UPLOADING, null, null, null, false);

        int status = 0;
        String bodyOutcome = null;
        String code = null;
        String message = null;
        Integer fileId = null;
        boolean transport = false;
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(grant.getString("uploadUrl")).openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setUseCaches(false);
            conn.setConnectTimeout(30_000);
            conn.setReadTimeout(120_000);
            conn.setFixedLengthStreamingMode(copy.length());
            conn.setRequestProperty("Authorization", "Bearer " + grant.getString("token"));
            conn.setRequestProperty("Content-Type", f.optString("mimeType"));
            conn.setRequestProperty("X-Verebona-Operation-Id", operationId);
            conn.setRequestProperty("X-Verebona-File-Name", URLEncoder.encode(f.optString("name"), "UTF-8").replace("+", "%20"));
            conn.setRequestProperty("X-Verebona-Sha256", f.optString("sha256"));
            conn.setRequestProperty("X-Verebona-Share-Client", "ANDROID");
            try (InputStream in = new FileInputStream(copy); OutputStream out = conn.getOutputStream()) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    if (isStopped()) throw new java.io.InterruptedIOException("arrêté");
                    out.write(buf, 0, n);
                }
            }
            status = conn.getResponseCode();
            InputStream rs = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            if (rs != null) {
                try (InputStream r = rs) {
                    ByteArrayOutputStream bo = new ByteArrayOutputStream();
                    byte[] buf = new byte[4096];
                    int n;
                    while ((n = r.read(buf)) > 0 && bo.size() < 64 * 1024) bo.write(buf, 0, n);
                    JSONObject j = new JSONObject(new String(bo.toByteArray(), StandardCharsets.UTF_8));
                    bodyOutcome = j.optString("outcome", null);
                    code = j.optString("code", null);
                    message = j.optString("message", null);
                    if (j.has("fileId")) fileId = j.optInt("fileId");
                } catch (Exception ignored) { /* corps illisible : statut seul */ }
            }
        } catch (Exception e) {
            transport = true;
        } finally {
            if (conn != null) conn.disconnect();
        }

        String outcome = ShareImportContract.outcome(status, bodyOutcome, transport);
        // Lot 111P : trace expurgée (catégorie + code serveur ou statut ; jamais le jeton ni le nom du fichier).
        ShareImportStore.diag(c, "imported".equals(outcome) ? "UPLOAD_OK"
            : "auth".equals(outcome) ? "UPLOAD_AUTH_" + ShareImportContract.safeCode(code)
            : "refused".equals(outcome) ? "UPLOAD_REFUSED_" + ShareImportContract.safeCode(code)
            : transport ? "UPLOAD_RETRY_NETWORK" : "UPLOAD_RETRY_HTTP_" + status);
        switch (outcome) {
            case "imported":
                setState(c, shareId, operationId, ShareImportContract.IMPORTED, null, null, fileId, false);
                return Result.success();
            case "refused":
                setState(c, shareId, operationId, ShareImportContract.FAILED, code,
                    message != null ? message : "Le document n’a pas pu être importé.", null, false);
                return Result.success();
            case "auth": {
                // Jeton refusé par le serveur : marqué (par sa référence) pour l'activité et l'app, qui le renouvelle.
                ShareImportStore.markRefused(c, usedRef, code);
                JSONObject fresh = ShareImportStore.readGrant(c);
                if (fresh != null && !usedRef.equals(ShareImportStore.ref(fresh.optString("token")))
                    && getRunAttemptCount() + 1 < ShareImportContract.MAX_ATTEMPTS) {
                    // Jeton PLUS RÉCENT déjà là (renouvelé pendant l'envoi) : nouvel essai avec lui, borné.
                    setState(c, shareId, operationId, ShareImportContract.QUEUED, code, null, null, true);
                    return Result.retry();
                }
                setState(c, shareId, operationId, ShareImportContract.WAITING_AUTH, code,
                    message != null ? message : ShareImportContract.notice("token_refused"), null, false);
                return Result.success();
            }
            default:
                if (getRunAttemptCount() + 1 >= ShareImportContract.MAX_ATTEMPTS) {
                    setState(c, shareId, operationId, ShareImportContract.FAILED, code,
                        "Import impossible après plusieurs essais : partagez de nouveau le document.", null, true);
                    return Result.success();
                }
                setState(c, shareId, operationId, transport ? ShareImportContract.WAITING_NETWORK : ShareImportContract.QUEUED, code,
                    transport ? "En attente de réseau." : null, null, true);
                return Result.retry();
        }
    }

    private static JSONObject findFile(JSONObject m, String operationId) {
        JSONArray files = m.optJSONArray("files");
        if (files == null) return null;
        for (int i = 0; i < files.length(); i++) {
            JSONObject f = files.optJSONObject(i);
            if (f != null && operationId.equals(f.optString("operationId"))) return f;
        }
        return null;
    }

    private static void setState(Context c, String shareId, String operationId, String state, String code, String message, Integer fileId, boolean attempt) {
        ShareImportStore.update(c, shareId, m -> {
            JSONObject f = findFile(m, operationId);
            if (f == null) return;
            f.put("state", state);
            if (code != null) f.put("code", code); else f.remove("code");
            if (message != null) f.put("message", message); else f.remove("message");
            if (fileId != null) f.put("fileId", fileId.intValue());
            if (attempt) f.put("attempts", f.optInt("attempts") + 1);
        });
    }
}
