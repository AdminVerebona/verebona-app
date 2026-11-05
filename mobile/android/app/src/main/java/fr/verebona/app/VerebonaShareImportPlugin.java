package fr.verebona.app;

import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Lot 110A — plugin local « VerebonaShareImport » (même contrat qu'iOS,
 * src/lib/native/share-import.ts) :
 *
 *   getState()            → { available, grant: { accountKey, expiresAt } | null, items }
 *                           (le jeton n'est JAMAIS rendu à la vue)
 *   setGrant({ token, expiresAt, accountKey, uploadUrl }) → stockage chiffré,
 *                           puis reprise des imports « En attente de connexion »
 *   clearGrant()          → jeton retiré (déconnexion, changement d'espace)
 *   acknowledge({ id })   → partage TERMINÉ affiché : dossier purgé
 *   resume()              → reprise des imports non terminés
 *   consumeOpenRequest()  → { id } laissé par « Importer et ouvrir Verebona »
 *   événement `stateChanged`.
 */
@CapacitorPlugin(name = "VerebonaShareImport")
public class VerebonaShareImportPlugin extends Plugin {

    @Override
    public void load() {
        ShareImportStore.setListener(() -> notifyListeners("stateChanged", new JSObject()));
    }

    @Override
    protected void handleOnResume() {
        ShareImportWorker.resumeAll(getContext());
        notifyListeners("stateChanged", new JSObject());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        notifyListeners("stateChanged", new JSObject());
    }

    @PluginMethod
    public void getState(PluginCall call) {
        JSObject out = new JSObject();
        out.put("available", true);
        JSArray items = new JSArray();
        for (JSONObject m : ShareImportStore.list(getContext())) {
            try {
                JSObject o = new JSObject();
                o.put("id", m.optString("id"));
                o.put("createdAt", m.optLong("createdAt"));
                if (!m.isNull("accountKey")) o.put("accountKey", m.optString("accountKey"));
                if (!m.isNull("accountHint")) o.put("accountHint", m.optString("accountHint"));
                JSONArray files = m.optJSONArray("files");
                JSArray fs = new JSArray();
                for (int i = 0; files != null && i < files.length(); i++) {
                    JSONObject f = files.getJSONObject(i);
                    JSObject x = new JSObject();
                    for (String k : new String[] { "operationId", "name", "mimeType", "state", "code", "message", "convertedFrom" }) {
                        if (f.has(k) && !f.isNull(k)) x.put(k, f.optString(k));
                    }
                    x.put("size", f.optLong("size"));
                    if (f.has("fileId")) x.put("fileId", f.optInt("fileId"));
                    fs.put(x);
                }
                o.put("files", fs);
                o.put("refused", m.optJSONArray("refused") != null ? m.optJSONArray("refused") : new JSONArray());
                items.put(o);
            } catch (Exception ignored) { /* élément illisible : ignoré */ }
        }
        out.put("items", items);
        // Lot 111P : état DISTINGUÉ du jeton, code du Keystore, référence non secrète,
        // dernier refus serveur, journal natif (codes seuls) — jamais le jeton.
        String[] state = ShareImportStore.grantState(getContext());
        out.put("grantStatus", state[0]);
        out.put("storeCode", state[1]);
        JSONObject g = ShareImportStore.readGrantForState(getContext());
        if (g != null) {
            JSObject gs = new JSObject();
            gs.put("accountKey", g.optString("accountKey"));
            gs.put("expiresAt", g.optString("expiresAt"));
            gs.put("ref", ShareImportStore.ref(g.optString("token")));
            if (state[2] != null) gs.put("refusedCode", state[2]);
            out.put("grant", gs);
        }
        try { out.put("diagnostics", new JSArray(ShareImportStore.diagnostics(getContext()).toString())); } catch (Exception ignored) { /* facultatif */ }
        call.resolve(out);
    }

    @PluginMethod
    public void setGrant(PluginCall call) {
        String token = call.getString("token");
        String expiresAt = call.getString("expiresAt");
        String accountKey = call.getString("accountKey");
        String uploadUrl = call.getString("uploadUrl");
        Uri u = uploadUrl == null ? null : Uri.parse(uploadUrl);
        Uri app = Uri.parse(getBridge().getServerUrl() == null ? "" : getBridge().getServerUrl());
        if (token == null || !token.startsWith("vbsi_") || expiresAt == null || accountKey == null || u == null
            || !"https".equals(u.getScheme()) || u.getHost() == null || !u.getHost().equals(app.getHost())) {
            ShareImportStore.diag(getContext(), "APP_SETGRANT_INVALID");
            call.reject("Jeton d’import invalide", "INVALID_GRANT");
            return;
        }
        try {
            JSONObject g = new JSONObject();
            g.put("token", token);
            g.put("expiresAt", expiresAt);
            g.put("accountKey", accountKey);
            g.put("uploadUrl", uploadUrl);
            // Lot 111P : écriture VÉRIFIÉE, motif rendu à la vue (KEYSTORE_KEY, KEYSTORE_COMMIT, KEYSTORE_VERIFY_…).
            String written = ShareImportStore.saveGrant(getContext(), g);
            ShareImportStore.diag(getContext(), "APP_SETGRANT_" + written);
            if (!"OK".equals(written)) { call.reject("Enregistrement impossible", "KEYSTORE_" + written); return; }
        } catch (Exception e) {
            call.reject("Enregistrement impossible", "KEYSTORE_JSON");
            return;
        }
        ShareImportWorker.resumeAll(getContext());
        JSObject ok = new JSObject();
        ok.put("ok", true);
        call.resolve(ok);
    }

    @PluginMethod
    public void clearGrant(PluginCall call) {
        ShareImportStore.clearGrant(getContext());
        ShareImportStore.diag(getContext(), "APP_CLEARGRANT");
        JSObject ok = new JSObject();
        ok.put("ok", true);
        call.resolve(ok);
    }

    @PluginMethod
    public void acknowledge(PluginCall call) {
        String id = call.getString("id");
        if (!ShareImportStore.isValidId(id)) { call.reject("Identifiant invalide"); return; }
        JSONObject m = ShareImportStore.read(getContext(), id);
        if (m != null && ShareImportStore.isSettled(m)) ShareImportStore.remove(getContext(), id);
        JSObject ok = new JSObject();
        ok.put("ok", true);
        call.resolve(ok);
    }

    @PluginMethod
    public void resume(PluginCall call) {
        ShareImportWorker.resumeAll(getContext());
        JSObject ok = new JSObject();
        ok.put("ok", true);
        call.resolve(ok);
    }

    @PluginMethod
    public void consumeOpenRequest(PluginCall call) {
        JSObject out = new JSObject();
        String id = ShareImportStore.consumeOpenRequest(getContext());
        if (id != null) out.put("id", id);
        call.resolve(out);
    }
}
