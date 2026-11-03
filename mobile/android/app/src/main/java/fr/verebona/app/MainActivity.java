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
        registerPlugin(VerebonaBiometricStatePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
