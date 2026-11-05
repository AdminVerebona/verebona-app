package fr.verebona.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.ImageDecoder;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.util.TypedValue;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Lot 110A — réception d'un partage Android (ACTION_SEND / ACTION_SEND_MULTIPLE).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * Écran de décision LÉGER (dialogue sur fond transparent, au-dessus de
 * l'application source) : nom du ou des documents reçus et EXACTEMENT
 * les trois choix du contrat :
 *   « Importer et ouvrir Verebona » : import lancé (WorkManager), puis
 *       Verebona s'ouvre sur le suivi / le document ;
 *   « Importer sans ouvrir » : import lancé, l'activité se termine →
 *       retour à l'application source, Verebona ne s'ouvre pas ;
 *   « Annuler » : copies provisoires effacées, AUCUN envoi.
 * Les fichiers sont copiés dans le STOCKAGE INTERNE PRIVÉ (jamais le
 * stockage partagé) avant la décision ; l'envoi ne commence qu'au choix.
 * Photos HEIC / HEIF : converties en JPEG (Android 9+), signalé ; sinon refus
 * avec motif. Aucune seconde confirmation, aucun formulaire ensuite.
 * ══════════════════════════════════════════════════════════════════════════
 */
public class ShareReceiverActivity extends Activity {
    private final String shareId = UUID.randomUUID().toString();
    private final List<JSONObject> accepted = new ArrayList<>();
    private final List<String[]> refused = new ArrayList<>();
    private AlertDialog dialog;
    private boolean decided = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Intent intent = getIntent();
        String action = intent == null ? null : intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) { finish(); return; }
        showPreparing();
        final List<Uri> uris = sharedUris(intent);
        final String declaredType = intent.getType();
        new Thread(() -> {
            prepare(uris, declaredType);
            new Handler(Looper.getMainLooper()).post(this::showChoices);
        }, "vb-share-prepare").start();
    }

    @SuppressWarnings("deprecation")
    private static List<Uri> sharedUris(Intent intent) {
        List<Uri> out = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) out.add(u);
        } else {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) out.addAll(list);
        }
        return out;
    }

    // ── Préparation (aucun envoi) ───────────────────────────────────────────

    private void prepare(List<Uri> uris, String declaredType) {
        File staging = ShareImportStore.staging(this, shareId);
        ContentResolver cr = getContentResolver();
        int index = 0;
        for (Uri uri : uris) {
            String name = displayName(cr, uri, index);
            index++;
            if (accepted.size() >= ShareImportContract.MAX_FILES) {
                refused.add(new String[] { name, ShareImportContract.MAX_FILES + " fichiers au plus par partage." });
                continue;
            }
            String mime = ShareImportContract.normalizeMime(cr.getType(uri) != null ? cr.getType(uri) : declaredType);
            try {
                String ext = ShareImportContract.extensionFor(mime);
                String converted = null;
                if (ext == null && ShareImportContract.isHeic(mime)) {
                    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
                        refused.add(new String[] { name, "Photo HEIC non prise en charge sur cette version d’Android : partagez-la au format JPEG." });
                        continue;
                    }
                    ext = "jpg";
                    converted = mime.contains("heif") ? "HEIF" : "HEIC";
                }
                if (ext == null) {
                    refused.add(new String[] { name, "Format non pris en charge : PDF, image, Word, Excel, texte ou CSV uniquement." });
                    continue;
                }
                String path = index + "-" + safeName(name, ext);
                File target = new File(staging, path);
                if (converted != null) convertToJpeg(uri, target); else copy(cr, uri, target);
                long size = target.length();
                if (size > ShareImportContract.MAX_BYTES) { target.delete(); refused.add(new String[] { name, "Fichier trop volumineux (25 Mo au plus)." }); continue; }
                if (size == 0) { target.delete(); refused.add(new String[] { name, "Fichier vide." }); continue; }
                JSONObject f = new JSONObject();
                f.put("operationId", UUID.randomUUID().toString());
                f.put("path", path);
                f.put("name", path.substring(path.indexOf('-') + 1));
                f.put("mimeType", converted != null ? "image/jpeg" : mime);
                f.put("size", size);
                f.put("sha256", sha256(target));
                if (converted != null) f.put("convertedFrom", converted);
                f.put("state", ShareImportContract.QUEUED);
                f.put("attempts", 0);
                accepted.add(f);
            } catch (Exception e) {
                refused.add(new String[] { name, "Fichier illisible." });
            }
        }
    }

    private static String displayName(ContentResolver cr, Uri uri, int index) {
        try (Cursor c = cr.query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                String n = c.getString(0);
                if (n != null && !n.trim().isEmpty()) return n.trim();
            }
        } catch (Exception ignored) { /* fournisseur sans nom */ }
        return "Document " + (index + 1);
    }

    private static String safeName(String name, String ext) {
        String base = name.replace('/', '-').replace('\\', '-');
        int dot = base.lastIndexOf('.');
        String stem = dot > 0 ? base.substring(0, dot) : base;
        if (stem.isEmpty()) stem = "Document";
        if (stem.length() > 80) stem = stem.substring(0, 80);
        return stem + "." + ext;
    }

    private static void copy(ContentResolver cr, Uri uri, File target) throws Exception {
        try (InputStream in = cr.openInputStream(uri); OutputStream out = new FileOutputStream(target)) {
            if (in == null) throw new java.io.IOException("flux absent");
            byte[] buf = new byte[64 * 1024];
            long total = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                total += n;
                if (total > ShareImportContract.MAX_BYTES + 1) break; // refusé ensuite (taille)
                out.write(buf, 0, n);
            }
        }
    }

    /** HEIC / HEIF → JPEG qualité maximale, orientation appliquée par ImageDecoder (API publique, Android 9+). */
    private void convertToJpeg(Uri uri, File target) throws Exception {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) throw new java.io.IOException("conversion indisponible");
        // Mémoire logicielle : compression JPEG garantie (pas de bitmap « matériel »).
        Bitmap bmp = ImageDecoder.decodeBitmap(ImageDecoder.createSource(getContentResolver(), uri),
            (decoder, info, source) -> decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE));
        try (OutputStream out = new FileOutputStream(target)) {
            if (!bmp.compress(Bitmap.CompressFormat.JPEG, 100, out)) throw new java.io.IOException("conversion impossible");
        } finally {
            bmp.recycle();
        }
    }

    private static String sha256(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
        }
        StringBuilder sb = new StringBuilder();
        for (byte b : md.digest()) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    // ── Interface ───────────────────────────────────────────────────────────

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    private void showPreparing() {
        LinearLayout box = new LinearLayout(this);
        box.setPadding(dp(24), dp(24), dp(24), dp(16));
        box.addView(new ProgressBar(this));
        dialog = new AlertDialog.Builder(this, R.style.VerebonaShareDialog).setTitle("Préparation…").setView(box)
            .setOnCancelListener(d -> cancel()).create();
        dialog.show();
    }

    private void showChoices() {
        if (isFinishing()) return;
        if (dialog != null) dialog.dismiss();
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(24), dp(8), dp(24), dp(8));
        for (int i = 0; i < Math.min(accepted.size(), 5); i++) {
            JSONObject f = accepted.get(i);
            TextView t = new TextView(this);
            t.setText(f.optString("name") + (f.has("convertedFrom") ? "\nPhoto " + f.optString("convertedFrom") + " convertie en JPEG (qualité maximale)." : ""));
            t.setPadding(0, dp(4), 0, dp(4));
            box.addView(t);
        }
        if (accepted.size() > 5) {
            TextView t = new TextView(this);
            t.setText("et " + (accepted.size() - 5) + " autre(s)");
            box.addView(t);
        }
        for (String[] r : refused) {
            TextView t = new TextView(this);
            t.setText("Non repris — " + r[0] + " : " + r[1]);
            t.setAlpha(0.7f);
            t.setPadding(0, dp(4), 0, dp(4));
            box.addView(t);
        }
        boolean signedIn = ShareImportStore.readGrant(this) != null;
        if (!accepted.isEmpty() && !signedIn) {
            TextView t = new TextView(this);
            t.setText("Vous n’êtes pas connecté à Verebona sur ce téléphone : l’import se terminera à la prochaine ouverture de l’application, sans rien resélectionner.");
            t.setAlpha(0.7f);
            t.setPadding(0, dp(8), 0, dp(4));
            box.addView(t);
        }
        if (!accepted.isEmpty()) {
            if (getResources().getBoolean(R.bool.vb_share_open_app)) {
                box.addView(choice(ShareImportContract.LABEL_IMPORT_AND_OPEN, v -> commit(true)));
            }
            box.addView(choice(ShareImportContract.LABEL_IMPORT_ONLY, v -> commit(false)));
        }
        box.addView(choice(ShareImportContract.LABEL_CANCEL, v -> cancel()));
        String title = accepted.isEmpty() ? "Aucun document importable"
            : accepted.size() > 1 ? accepted.size() + " documents pour Verebona" : "Document pour Verebona";
        dialog = new AlertDialog.Builder(this, R.style.VerebonaShareDialog).setTitle(title).setView(box)
            .setOnCancelListener(d -> cancel()).create();
        dialog.show();
    }

    private Button choice(String label, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setOnClickListener(l);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(8);
        b.setLayoutParams(lp);
        return b;
    }

    // ── Choix ───────────────────────────────────────────────────────────────

    private void commit(boolean open) {
        if (decided) return; // double toucher : un seul import
        decided = true;
        try {
            JSONObject grant = ShareImportStore.readGrant(this);
            JSONObject m = new JSONObject();
            m.put("version", 2);
            m.put("id", shareId);
            m.put("createdAt", System.currentTimeMillis());
            m.put("accountKey", grant != null ? grant.optString("accountKey") : JSONObject.NULL);
            String hint = ShareImportStore.accountHint(this);
            m.put("accountHint", hint != null ? hint : JSONObject.NULL);
            JSONArray files = new JSONArray();
            for (JSONObject f : accepted) files.put(f);
            m.put("files", files);
            JSONArray rf = new JSONArray();
            for (String[] r : refused) rf.put(new JSONObject().put("name", r[0]).put("reason", r[1]));
            m.put("refused", rf);
            ShareImportStore.publish(this, shareId, m);
            ShareImportWorker.startShare(getApplicationContext(), shareId);
        } catch (Exception e) {
            ShareImportStore.discardStaging(this, shareId);
            if (dialog != null) dialog.dismiss();
            new AlertDialog.Builder(this, R.style.VerebonaShareDialog).setTitle("Import impossible")
                .setMessage("Le document n’a pas pu être préparé. Rien n’a été importé : partagez-le de nouveau.")
                .setPositiveButton("Fermer", (d, w) -> finish()).setOnCancelListener(d -> finish()).show();
            return;
        }
        if (dialog != null) dialog.dismiss();
        if (open) {
            ShareImportStore.setOpenRequest(this, shareId);
            Intent i = new Intent(this, MainActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            startActivity(i);
        }
        finish();
    }

    private void cancel() {
        if (decided) return;
        decided = true;
        ShareImportStore.discardStaging(this, shareId);
        if (dialog != null) dialog.dismiss();
        finish();
    }

    @Override
    protected void onDestroy() {
        if (dialog != null) dialog.dismiss();
        super.onDestroy();
    }
}
