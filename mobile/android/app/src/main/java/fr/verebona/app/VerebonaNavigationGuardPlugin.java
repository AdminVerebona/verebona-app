package fr.verebona.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Lot 108G — garde de navigation de la vue (interface distante, cible V1).
 *
 * Applique {@code mobile/config/navigation-policy.mjs} avant la règle de
 * Capacitor (crochet {@code shouldOverrideLoad}, consulté en premier par
 * {@code Bridge.launchIntent}) :
 * <ul>
 *   <li>origine EXACTE de l'environnement (https + hôte + port) ou coque locale
 *       (https://localhost) : chargée dans la vue ;</li>
 *   <li>autre domaine http(s) : ouvert dans le navigateur du téléphone (hors de l'app) ;</li>
 *   <li>mailto:, tel:, sms:, geo:, maps: : remis au système ;</li>
 *   <li>about:, blob:, data: : laissés au moteur web (aperçus générés par la page) ;</li>
 *   <li>tout le reste (intent:, javascript:, file:, content:, schémas privés) : refusé.</li>
 * </ul>
 * Le pont natif lui-même n'est exposé qu'à l'origine de {@code server.url}
 * (règle d'origine {@code addWebMessageListener} ; voir docs/mobile/architecture-distante.md).
 */
@CapacitorPlugin(name = "VerebonaNavigationGuard")
public class VerebonaNavigationGuardPlugin extends Plugin {

    static final Set<String> SYSTEM_SCHEMES = new HashSet<>(Arrays.asList("mailto", "tel", "sms", "geo", "maps"));
    static final Set<String> INTERNAL_FRAME_SCHEMES = new HashSet<>(Arrays.asList("about", "blob", "data"));

    private static String origin(Uri u) {
        if (u == null || u.getScheme() == null || u.getHost() == null) return null;
        int port = u.getPort();
        return u.getScheme().toLowerCase(Locale.ROOT) + "://" + u.getHost().toLowerCase(Locale.ROOT) + (port == -1 ? "" : ":" + port);
    }

    /** null : décision laissée à Capacitor ; true : chargement annulé ; false : chargement admis. */
    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        if (url == null || url.getScheme() == null) return true;
        String scheme = url.getScheme().toLowerCase(Locale.ROOT);
        String appOrigin = origin(Uri.parse(getBridge().getServerUrl() != null ? getBridge().getServerUrl() : getBridge().getLocalUrl()));
        String localOrigin = origin(Uri.parse(getBridge().getLocalUrl()));

        if ("https".equals(scheme) || "http".equals(scheme)) {
            if (url.getUserInfo() != null) return true;
            String o = origin(url);
            if ("https".equals(scheme) && o != null && o.equals(appOrigin)) return false;
            if (o != null && o.equals(localOrigin)) return false;
            openOutside(url, true);
            return true;
        }
        if (INTERNAL_FRAME_SCHEMES.contains(scheme)) return false;
        if (SYSTEM_SCHEMES.contains(scheme)) {
            openOutside(url, false);
            return true;
        }
        Logger.warn("VerebonaNavigationGuard", "Navigation refusée (schéma " + scheme + ")");
        return true;
    }

    private void openOutside(Uri url, boolean browsable) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, url);
            if (browsable) i.addCategory(Intent.CATEGORY_BROWSABLE);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        } catch (ActivityNotFoundException e) {
            Logger.warn("VerebonaNavigationGuard", "Aucune application pour ouvrir ce lien");
        }
    }
}
