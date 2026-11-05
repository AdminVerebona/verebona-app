package fr.verebona.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

/**
 * Activité unique de l'application Verebona (préproduction et production :
 * même code, variantes Gradle « preprod » / « prod »).
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Lot 107A : plugins LOCAUX de l'application (non publiés sur npm),
        // à enregistrer avant l'initialisation du pont Capacitor.
        // Lot 108G : garde de navigation (seule l'origine de l'environnement
        // est chargée dans la vue ; tout autre lien → navigateur du téléphone).
        registerPlugin(VerebonaNavigationGuardPlugin.class);
        // Lot 110A : partage natif à import direct (jeton d'import, états fidèles).
        registerPlugin(VerebonaShareImportPlugin.class);
        registerPlugin(VerebonaBiometricStatePlugin.class);
        super.onCreate(savedInstanceState);
        // Lot 110B : clés d'accès (WebAuthn) dans la vue, via le Credential Manager.
        if (this.bridge != null) VerebonaWebAuthn.enable(this.bridge.getWebView());
    }
}
