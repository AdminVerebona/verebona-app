import UIKit
import Capacitor

/// Lot 95 : contrôleur de la WebView Capacitor de Verebona.
/// Enregistre les plugins LOCAUX de l'application (non publiés sur npm).
class VerebonaBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(VerebonaAuthSessionPlugin())
        // Lot 107A : empreinte de l'enrôlement Face ID / Touch ID (invalidation du déverrouillage).
        bridge?.registerPluginInstance(VerebonaBiometricStatePlugin())
        // Lot 108G : garde de navigation (seule l'origine de l'environnement
        // accède au pont) et file technique des partages entrants.
        bridge?.registerPluginInstance(VerebonaNavigationGuardPlugin())
        bridge?.registerPluginInstance(VerebonaShareInboxPlugin())
        // Lot 110A : partage natif à import direct (jeton d'import, états fidèles).
        bridge?.registerPluginInstance(VerebonaShareImportPlugin())
    }
}
