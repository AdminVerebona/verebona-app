import UIKit
import UniformTypeIdentifiers

/// Lot 95 (CDC 12 IMP-02, G0-07) — extension de partage iOS « Verebona ».
///
/// À AJOUTER UNE FOIS sur un Mac (Xcode › File › New › Target › Share Extension,
/// nom « ShareExtension »), en remplaçant le contrôleur généré par ce fichier et
/// l'Info.plist par celui de ce dossier (procédure : docs/mobile/builds-et-secrets.md).
///
/// Rôle : copier les PDF / images partagés dans le conteneur du groupe d'apps
/// (`VB_APP_GROUP`), déposer leur description sous la clé `share-target-data`
/// lue par le plugin `@capgo/capacitor-share-target`, puis rouvrir l'app
/// (`<schéma>://share`). Aucun envoi réseau ici : l'app applique ensuite le
/// parcours d'ajout habituel (connexion, rattachement, quota).
class ShareViewController: UIViewController {
    private let appGroupId: String = Bundle.main.object(forInfoDictionaryKey: "VBAppGroup") as? String ?? ""
    private let urlScheme: String = Bundle.main.object(forInfoDictionaryKey: "VBURLScheme") as? String ?? ""
    private let accepted: [UTType] = [.pdf, .image]

    override func viewDidLoad() {
        super.viewDidLoad()
        Task { await collect() }
    }

    private func collect() async {
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId) else {
            finish()
            return
        }
        let inbox = container.appendingPathComponent("partages", isDirectory: true)
        try? FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
        var files: [[String: Any]] = []
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        for provider in providers.prefix(10) {
            guard let type = accepted.first(where: { provider.hasItemConformingToTypeIdentifier($0.identifier) }) else { continue }
            if let url = try? await loadFile(provider, type: type) {
                let target = inbox.appendingPathComponent(UUID().uuidString + "-" + url.lastPathComponent)
                do {
                    try FileManager.default.copyItem(at: url, to: target)
                    let mime = UTType(filenameExtension: target.pathExtension)?.preferredMIMEType ?? (type == .pdf ? "application/pdf" : "image/jpeg")
                    files.append(["uri": target.absoluteString, "name": url.lastPathComponent, "mimeType": mime])
                } catch { continue }
            }
        }
        if !files.isEmpty, let defaults = UserDefaults(suiteName: appGroupId) {
            defaults.set(["title": "", "texts": [String](), "files": files], forKey: "share-target-data")
        }
        if let url = URL(string: "\(urlScheme)://share") { open(url) }
        finish()
    }

    private func loadFile(_ provider: NSItemProvider, type: UTType) async throws -> URL {
        try await withCheckedThrowingContinuation { cont in
            _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, error in
                guard let url = url else { cont.resume(throwing: error ?? CocoaError(.fileReadUnknown)); return }
                // Le fichier fourni est temporaire : copie immédiate dans un emplacement durable.
                let copy = FileManager.default.temporaryDirectory.appendingPathComponent(url.lastPathComponent)
                try? FileManager.default.removeItem(at: copy)
                do { try FileManager.default.copyItem(at: url, to: copy); cont.resume(returning: copy) } catch { cont.resume(throwing: error) }
            }
        }
    }

    /// Ouverture de l'app hôte depuis une extension (chaîne des répondeurs).
    private func open(_ url: URL) {
        var responder: UIResponder? = self
        while let r = responder {
            if let app = r as? UIApplication {
                app.open(url, options: [:], completionHandler: nil)
                return
            }
            responder = r.next
        }
    }

    private func finish() {
        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }
}
