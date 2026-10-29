import UIKit
import Capacitor

/// Lot 95 : contrôleur de la WebView Capacitor de Verebona.
/// Enregistre les plugins LOCAUX de l'application (non publiés sur npm).
class VerebonaBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(VerebonaAuthSessionPlugin())
    }
}
