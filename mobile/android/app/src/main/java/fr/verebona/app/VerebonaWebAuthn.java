package fr.verebona.app;

import android.util.Log;
import android.webkit.WebSettings;
import android.webkit.WebView;

import java.lang.reflect.Field;
import java.lang.reflect.Method;

/**
 * Lot 110B (double authentification) — clés d'accès (WebAuthn) dans la WebView
 * de l'application.
 *
 * La WebView Android n'expose `navigator.credentials` (WebAuthn) qu'une fois
 * activée par l'application : `WebSettingsCompat.setWebAuthenticationSupport(
 * settings, WEB_AUTHENTICATION_SUPPORT_FOR_APP)` (bibliothèque AndroidX WebKit,
 * fonctionnalité `WebViewFeature.WEB_AUTHENTICATION`). Les clés sont alors
 * gérées par le Credential Manager du téléphone, pour le domaine chargé
 * (RP ID = hôte de l'environnement), à condition que l'application soit
 * associée à ce domaine par Digital Asset Links
 * (`/.well-known/assetlinks.json`, relation `get_login_creds`, déjà servie par
 * le serveur — `src/lib/mobile/app-links.ts`).
 *
 * Appel par RÉFLEXION : aucune dépendance de compilation nouvelle (AndroidX
 * WebKit est déjà embarqué par Capacitor) ; WebView trop ancienne ou fonction
 * absente → rien n'est activé, journal, et l'interface propose le code de
 * l'application d'authentification (repli, sans contourner la MFA).
 */
final class VerebonaWebAuthn {
    private static final String TAG = "VerebonaWebAuthn";

    private VerebonaWebAuthn() {}

    static void enable(WebView webView) {
        if (webView == null) return;
        try {
            Class<?> feature = Class.forName("androidx.webkit.WebViewFeature");
            Method isSupported = feature.getMethod("isFeatureSupported", String.class);
            Field name = feature.getField("WEB_AUTHENTICATION");
            Object supported = isSupported.invoke(null, (String) name.get(null));
            if (!(supported instanceof Boolean) || !((Boolean) supported)) {
                Log.i(TAG, "WebAuthn non pris en charge par cette WebView : repli sur l'application d'authentification.");
                return;
            }
            Class<?> compat = Class.forName("androidx.webkit.WebSettingsCompat");
            int forApp = compat.getField("WEB_AUTHENTICATION_SUPPORT_FOR_APP").getInt(null);
            Method set = compat.getMethod("setWebAuthenticationSupport", WebSettings.class, int.class);
            set.invoke(null, webView.getSettings(), forApp);
            Log.i(TAG, "WebAuthn activé pour l'application.");
        } catch (Throwable t) {
            Log.w(TAG, "WebAuthn non activé (" + t.getClass().getSimpleName() + ") : repli sur l'application d'authentification.");
        }
    }
}
