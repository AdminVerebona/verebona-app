import Foundation
import Capacitor
import CryptoKit
import LocalAuthentication

/// Lot 107A — empreinte de l'ENRÔLEMENT biométrique du téléphone.
///
/// Sert uniquement à savoir si les visages / doigts enregistrés dans iOS ont
/// changé depuis l'activation du déverrouillage biométrique de Verebona
/// (ajout d'un visage alternatif, d'un doigt, réinitialisation de Face ID…).
/// Dans ce cas, l'app suspend l'option (« à réactiver ») au lieu de laisser
/// une nouvelle biométrie ouvrir Verebona.
///
/// Rend un condensé SHA-256 de `LAContext.evaluatedPolicyDomainState` (valeur
/// opaque fournie par iOS, qui change à chaque modification de l'enrôlement) :
/// AUCUNE donnée biométrique, aucune donnée personnelle, rien n'est envoyé au
/// serveur. Biométrie absente ou non configurée → `token: null`.
///
/// Côté JavaScript : `Capacitor.Plugins.VerebonaBiometricState.enrollmentToken()`
/// → `{ token: string | null }` (src/lib/native/biometric-consent.ts).
@objc(VerebonaBiometricStatePlugin)
public class VerebonaBiometricStatePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VerebonaBiometricStatePlugin"
    public let jsName = "VerebonaBiometricState"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "enrollmentToken", returnType: CAPPluginReturnPromise)
    ]

    @objc func enrollmentToken(_ call: CAPPluginCall) {
        let context = LAContext()
        var error: NSError?
        // `evaluatedPolicyDomainState` n'est renseigné qu'après `canEvaluatePolicy`.
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error),
              let state = context.evaluatedPolicyDomainState else {
            call.resolve(["token": NSNull()])
            return
        }
        let token = SHA256.hash(data: state).map { String(format: "%02x", $0) }.joined()
        call.resolve(["token": token])
    }
}
