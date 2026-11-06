import Foundation
import Capacitor
import Security
import UIKit

/// Lot 112E — état NATIF d'une valeur du Keychain de l'app, sans la lire.
///
/// Le plugin `@aparajita/capacitor-secure-storage` (KeychainSwift) rend
/// « absent » pour toute erreur de `SecItemCopyMatching`. Téléphone verrouillé,
/// une valeur de classe `whenUnlockedThisDeviceOnly` répond pourtant
/// `errSecInteractionNotAllowed` (-25308) : elle existe, elle est seulement
/// illisible pour l'instant. Sans ce code, l'app tirait un nouvel identifiant
/// d'installation (et pouvait purger le stockage sécurisé).
///
/// `probe({ prefixedKey })` → `{ status, osStatus, protectedDataAvailable }` :
///   · `present`  valeur trouvée (son contenu n'est PAS renvoyé) ;
///   · `absent`   `errSecItemNotFound` ET données protégées disponibles ;
///   · `locked`   `errSecInteractionNotAllowed`, ou introuvable alors que les
///                données protégées sont indisponibles (jamais « absent ») ;
///   · `error`    tout autre code (renvoyé dans `osStatus`).
/// Même requête que KeychainSwift (`kSecClassGenericPassword`, compte = clé
/// préfixée, non synchronisée). Seules les clés `verebona.` sont acceptées.
///
/// Événement `protectedDataChange` `{ available }` (déverrouillage /
/// verrouillage du téléphone) : l'app relit alors l'identifiant différé.
///
/// Côté JavaScript : `Capacitor.Plugins.VerebonaSecureStoreStatus`
/// (src/lib/native/secure-store.ts, `secureProbe`). Ne change NI la classe
/// d'accessibilité NI le contenu du Keychain : lecture seule.
@objc(VerebonaSecureStoreStatusPlugin)
public class VerebonaSecureStoreStatusPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VerebonaSecureStoreStatusPlugin"
    public let jsName = "VerebonaSecureStoreStatus"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "probe", returnType: CAPPluginReturnPromise)
    ]

    private static let allowedPrefix = "verebona."
    private var observers: [NSObjectProtocol] = []

    override public func load() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIApplication.protectedDataDidBecomeAvailableNotification,
                                            object: nil, queue: .main) { [weak self] _ in
            self?.notifyListeners("protectedDataChange", data: ["available": true])
        })
        observers.append(center.addObserver(forName: UIApplication.protectedDataWillBecomeUnavailableNotification,
                                            object: nil, queue: .main) { [weak self] _ in
            self?.notifyListeners("protectedDataChange", data: ["available": false])
        })
    }

    deinit {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
    }

    @objc func probe(_ call: CAPPluginCall) {
        guard let key = call.getString("prefixedKey"),
              key.hasPrefix(Self.allowedPrefix), key.count <= 128 else {
            call.reject("Clé invalide", "invalidKey")
            return
        }
        DispatchQueue.main.async {
            let available = UIApplication.shared.isProtectedDataAvailable
            DispatchQueue.global(qos: .userInitiated).async {
                let query: [String: Any] = [
                    kSecClass as String: kSecClassGenericPassword,
                    kSecAttrAccount as String: key,
                    kSecMatchLimit as String: kSecMatchLimitOne,
                    kSecReturnData as String: true
                ]
                var result: AnyObject?
                let status = SecItemCopyMatching(query as CFDictionary, &result) // contenu jamais renvoyé
                let label: String
                switch status {
                case errSecSuccess:
                    label = "present"
                case errSecItemNotFound:
                    label = available ? "absent" : "locked"
                case errSecInteractionNotAllowed:
                    label = "locked"
                default:
                    label = "error"
                }
                call.resolve([
                    "status": label,
                    "osStatus": Int(status),
                    "protectedDataAvailable": available
                ])
            }
        }
    }
}
