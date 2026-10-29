import Foundation
import Capacitor
import AuthenticationServices

/// Lot 95 (PO M1) — connexion Google / Apple par ASWebAuthenticationSession.
///
/// Le parcours OAuth ne s'exécute JAMAIS dans la WebView de l'app : il s'ouvre
/// dans la session d'authentification du système, qui partage les comptes du
/// navigateur et rend l'adresse de retour à l'app :
///   · iOS 17.4+ et `callbackHost` / `callbackPath` fournis : retour https
///     (lien universel vérifié par le fichier apple-app-site-association) ;
///   · sinon : schéma privé `callbackScheme` (RFC 8252).
/// Côté JavaScript : `Capacitor.Plugins.VerebonaAuthSession.start({ url, callbackScheme, callbackHost, callbackPath })`
/// → `{ status: 'completed', url }` ou `{ status: 'cancelled' }` (src/lib/native/oauth.ts).
@objc(VerebonaAuthSessionPlugin)
public class VerebonaAuthSessionPlugin: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "VerebonaAuthSessionPlugin"
    public let jsName = "VerebonaAuthSession"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise)
    ]

    private var session: ASWebAuthenticationSession?

    @objc func start(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = URL(string: raw), url.scheme == "https" else {
            call.reject("Adresse de connexion invalide.", "INVALID_URL")
            return
        }
        let scheme = call.getString("callbackScheme")
        let host = call.getString("callbackHost")
        let path = call.getString("callbackPath")

        DispatchQueue.main.async {
            let completion: (URL?, Error?) -> Void = { [weak self] callbackURL, error in
                self?.session = nil
                if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                    call.resolve(["status": "cancelled"])
                    return
                }
                if error != nil {
                    call.reject("La connexion n’a pas pu aboutir.", "FAILED")
                    return
                }
                guard let callbackURL = callbackURL else {
                    call.reject("Retour de connexion vide.", "FAILED")
                    return
                }
                call.resolve(["status": "completed", "url": callbackURL.absoluteString])
            }

            let authSession: ASWebAuthenticationSession
            if #available(iOS 17.4, *), let host = host, let path = path {
                authSession = ASWebAuthenticationSession(url: url, callback: .https(host: host, path: path), completionHandler: completion)
            } else if let scheme = scheme {
                authSession = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme, completionHandler: completion)
            } else {
                call.reject("Aucune adresse de retour configurée.", "NO_CALLBACK")
                return
            }
            authSession.presentationContextProvider = self
            // Partage les comptes Google / Apple déjà ouverts dans Safari.
            authSession.prefersEphemeralWebBrowserSession = false
            self.session = authSession
            if !authSession.start() {
                self.session = nil
                call.reject("Impossible d’ouvrir la connexion.", "START_FAILED")
            }
        }
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        return bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }
}
