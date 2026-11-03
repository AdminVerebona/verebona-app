package fr.verebona.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.security.KeyStore;
import java.util.UUID;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;

/**
 * Lot 107A — empreinte de l'ENRÔLEMENT biométrique du téléphone.
 *
 * Une clé AES du Keystore Android (jamais exportable) est créée avec
 * {@code setUserAuthenticationRequired(true)} et
 * {@code setInvalidatedByBiometricEnrollment(true)} : Android l'invalide
 * définitivement dès qu'une empreinte / un visage est ajouté ou que toutes
 * les biométries sont retirées. Un identifiant aléatoire (non secret) est
 * associé à chaque génération de clé ; quand la clé est invalidée ou absente
 * (réinstallation, suppression des clés), une nouvelle clé et un nouvel
 * identifiant sont créés : l'app voit l'identifiant changer et suspend le
 * déverrouillage biométrique (« à réactiver »).
 *
 * La clé ne chiffre rien et ne sert qu'à ce contrôle : AUCUNE donnée
 * biométrique, aucun mot de passe, rien n'est envoyé au serveur. Biométrie
 * forte absente → {@code token: null} (contrôle impossible, sans blocage).
 *
 * Côté JavaScript : {@code Capacitor.Plugins.VerebonaBiometricState.enrollmentToken()}
 * → {@code { token: string | null }} (src/lib/native/biometric-consent.ts).
 */
@CapacitorPlugin(name = "VerebonaBiometricState")
public class VerebonaBiometricStatePlugin extends Plugin {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String ALIAS = "verebona_biometric_enrollment";
    private static final String PREFS = "verebona_biometric_state";
    private static final String TOKEN = "token";

    @PluginMethod
    public void enrollmentToken(PluginCall call) {
        JSObject ret = new JSObject();
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        try {
            KeyStore ks = KeyStore.getInstance(KEYSTORE);
            ks.load(null);
            String token = prefs.getString(TOKEN, null);
            if (token == null || !keyStillValid(ks)) {
                if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS);
                createKey();
                token = UUID.randomUUID().toString();
                prefs.edit().putString(TOKEN, token).apply();
            }
            ret.put("token", token);
        } catch (Exception e) {
            // Aucune biométrie forte enrôlée, Keystore indisponible… : pas de contrôle possible.
            prefs.edit().remove(TOKEN).apply();
            ret.put("token", JSONObject.NULL);
        }
        call.resolve(ret);
    }

    /** {@code Cipher.init} lève KeyPermanentlyInvalidatedException si l'enrôlement a changé (sans demander d'authentification). */
    private boolean keyStillValid(KeyStore ks) throws Exception {
        if (!ks.containsAlias(ALIAS)) return false;
        SecretKey key = (SecretKey) ks.getKey(ALIAS, null);
        if (key == null) return false;
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key);
            return true;
        } catch (KeyPermanentlyInvalidatedException e) {
            return false;
        }
    }

    private void createKey() throws Exception {
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)
            .build());
        generator.generateKey();
    }
}
