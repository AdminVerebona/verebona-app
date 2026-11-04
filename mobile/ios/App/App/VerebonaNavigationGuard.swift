import Foundation
import UIKit
import WebKit
import Capacitor

/// Lot 108G — garde de navigation de la vue (interface distante, cible V1).
///
/// Applique `mobile/config/navigation-policy.mjs` AVANT la règle de Capacitor
/// (crochet `shouldOverrideLoad`, consulté en premier) :
///   · origine EXACTE de l'environnement (schéma https + hôte + port) ou coque
///     locale (`capacitor://localhost`) : chargée dans la vue ;
///   · autre domaine, vue principale : ouvert dans Safari (hors de l'app) ;
///   · autre domaine, cadre (iframe) : REFUSÉ — le gestionnaire de messages du
///     pont natif est joignable depuis tout cadre d'une page ;
///   · mailto:, tel:, sms:, geo:, maps: (vue principale) : remis au système ;
///   · about:, blob:, data: dans un cadre (aperçu PDF de la page) : admis ;
///   · tout le reste (javascript:, file:, schémas privés…) : refusé.
/// Pourquoi : la règle de Capacitor compare un PRÉFIXE de chaîne
/// (`https://app.verebona.fr` accepterait `https://app.verebona.fr.exemple.com`)
/// et laisse passer tous les cadres.
@objc(VerebonaNavigationGuardPlugin)
public class VerebonaNavigationGuardPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VerebonaNavigationGuardPlugin"
    public let jsName = "VerebonaNavigationGuard"
    public let pluginMethods: [CAPPluginMethod] = []

    static let systemSchemes: Set<String> = ["mailto", "tel", "sms", "geo", "maps"]
    static let internalFrameSchemes: Set<String> = ["about", "blob", "data"]

    private func origin(_ url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased() else { return nil }
        let port = url.port.map { ":\($0)" } ?? ""
        return "\(scheme)://\(host)\(port)"
    }

    /// nil : décision laissée à Capacitor ; true : chargement annulé ; false : chargement admis.
    @objc override public func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard let bridge = bridge, let url = navigationAction.request.url else { return true }
        let mainFrame = navigationAction.targetFrame == nil || navigationAction.targetFrame?.isMainFrame == true
        let scheme = url.scheme?.lowercased() ?? ""
        let appOrigin = origin(bridge.config.serverURL)
        let localOrigin = origin(bridge.config.localURL)

        if scheme == "https" || scheme == "http" {
            if url.user != nil || url.password != nil { return true }
            let o = origin(url)
            if scheme == "https", let o = o, o == appOrigin { return false }
            if let o = o, o == localOrigin { return false }
            if mainFrame { openOutside(url) }
            return true
        }
        if let o = origin(url), o == localOrigin { return false }
        if !mainFrame && Self.internalFrameSchemes.contains(scheme) { return false }
        if mainFrame && (scheme == "about" || scheme == "blob") { return false }
        if mainFrame && Self.systemSchemes.contains(scheme) { openOutside(url); return true }
        return true
    }

    private func openOutside(_ url: URL) {
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
        }
    }
}
