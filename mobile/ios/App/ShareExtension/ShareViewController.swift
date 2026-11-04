import UIKit
import UniformTypeIdentifiers
import ImageIO

/// Extension de partage iOS « Verebona » — lot 95, réécrite au lot 108G
/// (CDC 12 IMP-02..06, G0-07 ; ticket « Partage iOS vers Verebona »).
///
/// Cible Xcode `ShareExtension` VERSIONNÉE dans App.xcodeproj (plus aucune
/// manipulation manuelle) ; identifiant `<identifiant de l'app>.ShareExtension`,
/// groupe d'apps `group.<identifiant de l'app>` (préproduction et production).
///
/// ══════════════════════════════════════════════════════════════════════════
/// CE QUE FAIT L'EXTENSION — ET RIEN DE PLUS
///
///  1. trie les éléments partagés : PDF, JPEG, PNG, WEBP acceptés tels quels ;
///     photo HEIC / HEIF (ou autre image) CONVERTIE en JPEG qualité maximale,
///     orientation et métadonnées conservées, et SIGNALÉE (jamais en silence) ;
///     tout autre format refusé avec son nom et le motif ; 10 fichiers au plus ;
///  2. copie les fichiers dans la FILE TECHNIQUE du groupe d'apps : un dossier
///     par partage (`partages-v1/<identifiant>/`), écrit d'abord sous un nom
///     provisoire puis renommé d'un coup (jamais d'élément à moitié écrit),
///     protection de fichier « complète », exclu des sauvegardes. Deux
///     partages successifs donnent deux éléments : rien n'est écrasé ;
///  3. affiche une confirmation FIDÈLE : « Document prêt à importer dans
///     Verebona » — rien n'est encore envoyé ni enregistré dans le compte.
///
/// Aucun appel réseau, aucune session, aucune ouverture de l'application
/// (pas de chaîne de répondeurs ni d'`UIApplication.open`, non admis pour une
/// extension de partage) : l'utilisateur ouvre Verebona, qui reprend la file
/// (plugin local `VerebonaShareInbox`, après Face ID / connexion) dans le
/// parcours d'ajout habituel. Cette file n'est PAS un mode hors connexion.
/// Contrat partagé avec l'app : mêmes constantes dans VerebonaShareInbox.swift
/// (contrôlé par mobile/test/l108g-mode-distant.test.mjs).
/// ══════════════════════════════════════════════════════════════════════════
class ShareViewController: UIViewController {
    /// Dossier de la file technique dans le groupe d'apps (version du format).
    static let inboxFolder = "partages-v1"
    static let manifestName = "manifest.json"
    /// Nombre maximal de fichiers par partage (comme le dépôt de l'app).
    static let maxFilesPerShare = 10
    /// Nombre maximal de partages en attente (au-delà : refus explicite).
    static let maxPendingShares = 20

    private let appGroupId: String = Bundle.main.object(forInfoDictionaryKey: "VBAppGroup") as? String ?? ""

    private let titleLabel = UILabel()
    private let messageLabel = UILabel()
    private let spinner = UIActivityIndicatorView(style: .large)
    private let button = UIButton(type: .system)

    private struct Accepted { let url: URL; let name: String; let mimeType: String; let size: Int; let convertedFrom: String? }
    private struct Refused { let name: String; let reason: String }

    // MARK: - Interface

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor.systemBackground
        titleLabel.font = .preferredFont(forTextStyle: .title2)
        titleLabel.adjustsFontForContentSizeCategory = true
        titleLabel.numberOfLines = 0
        titleLabel.textAlignment = .center
        titleLabel.text = "Préparation…"
        messageLabel.font = .preferredFont(forTextStyle: .body)
        messageLabel.adjustsFontForContentSizeCategory = true
        messageLabel.numberOfLines = 0
        messageLabel.textAlignment = .center
        messageLabel.textColor = .secondaryLabel
        button.setTitle("OK", for: .normal)
        button.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        button.isHidden = true
        button.addTarget(self, action: #selector(close), for: .touchUpInside)
        spinner.startAnimating()

        let stack = UIStackView(arrangedSubviews: [spinner, titleLabel, messageLabel, button])
        stack.axis = .vertical
        stack.spacing = 16
        stack.alignment = .fill
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
        Task { await collect() }
    }

    @MainActor
    private func show(title: String, message: String) {
        spinner.stopAnimating()
        spinner.isHidden = true
        titleLabel.text = title
        messageLabel.text = message
        button.isHidden = false
    }

    @objc private func close() {
        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }

    // MARK: - Réception

    private func collect() async {
        let fm = FileManager.default
        guard !appGroupId.isEmpty, let container = fm.containerURL(forSecurityApplicationGroupIdentifier: appGroupId) else {
            await show(title: "Partage indisponible", message: "Verebona ne peut pas recevoir ce document sur ce téléphone (groupe d’apps absent). Ajoutez-le depuis l’application.")
            return
        }
        let inbox = container.appendingPathComponent(Self.inboxFolder, isDirectory: true)
        try? fm.createDirectory(at: inbox, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        let pending = ((try? fm.contentsOfDirectory(atPath: inbox.path)) ?? []).filter { !$0.hasPrefix(".") }.count
        if pending >= Self.maxPendingShares {
            await show(title: "Trop de documents en attente", message: "Ouvrez Verebona pour importer ou abandonner les documents déjà partagés, puis partagez de nouveau.")
            return
        }

        let shareId = UUID().uuidString
        let staging = inbox.appendingPathComponent(".tmp-\(shareId)", isDirectory: true)
        let final = inbox.appendingPathComponent(shareId, isDirectory: true)
        do {
            try fm.createDirectory(at: staging, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        } catch {
            await show(title: "Copie impossible", message: "Le document n’a pas pu être préparé (espace de stockage du téléphone ?). Rien n’a été importé.")
            return
        }

        var accepted: [Accepted] = []
        var refused: [Refused] = []
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        for (index, provider) in providers.enumerated() {
            let fallbackName = provider.suggestedName ?? "Document \(index + 1)"
            if accepted.count >= Self.maxFilesPerShare {
                refused.append(Refused(name: fallbackName, reason: "10 fichiers au plus par partage."))
                continue
            }
            do {
                if let file = try await receive(provider, index: index, into: staging) { accepted.append(file) }
                else { refused.append(Refused(name: fallbackName, reason: "Format non pris en charge : PDF, JPEG, PNG, WEBP ou photo HEIC uniquement.")) }
            } catch {
                refused.append(Refused(name: fallbackName, reason: "Fichier illisible."))
            }
        }

        guard !accepted.isEmpty else {
            try? fm.removeItem(at: staging)
            await show(title: "Aucun document importable", message: describe(refused))
            return
        }

        // Manifeste puis renommage atomique : l'app ne voit jamais un élément incomplet.
        let manifest: [String: Any] = [
            "version": 1,
            "id": shareId,
            "createdAt": Int(Date().timeIntervalSince1970 * 1000),
            "files": accepted.map { f -> [String: Any] in
                var d: [String: Any] = ["path": f.url.lastPathComponent, "name": f.name, "mimeType": f.mimeType, "size": f.size]
                if let c = f.convertedFrom { d["convertedFrom"] = c }
                return d
            },
            "refused": refused.map { ["name": $0.name, "reason": $0.reason] },
        ]
        do {
            let data = try JSONSerialization.data(withJSONObject: manifest, options: [])
            try data.write(to: staging.appendingPathComponent(Self.manifestName), options: [.atomic, .completeFileProtection])
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var stagingURL = staging
            try? stagingURL.setResourceValues(values)
            try fm.moveItem(at: staging, to: final)
        } catch {
            try? fm.removeItem(at: staging)
            await show(title: "Copie impossible", message: "Le document n’a pas pu être préparé. Rien n’a été importé : partagez-le de nouveau.")
            return
        }

        let title = accepted.count > 1 ? "\(accepted.count) documents prêts à importer dans Verebona" : "Document prêt à importer dans Verebona"
        var message = "Ouvrez Verebona pour vérifier et finaliser l’ajout. Rien n’est encore enregistré dans votre compte."
        let converted = accepted.filter { $0.convertedFrom != nil }
        if !converted.isEmpty {
            message += "\n\n" + converted.map { "\($0.name) : photo \($0.convertedFrom ?? "") convertie en JPEG (qualité maximale)." }.joined(separator: "\n")
        }
        if !refused.isEmpty { message += "\n\nNon repris :\n" + describe(refused) }
        await show(title: title, message: message)
    }

    private func describe(_ refused: [Refused]) -> String {
        refused.map { "\($0.name) : \($0.reason)" }.joined(separator: "\n")
    }

    /// Types acceptés tels quels (le serveur Verebona les accepte : `file-validation.ts`).
    private static let direct: [(UTType, String, String)] = [
        (.pdf, "application/pdf", "pdf"),
        (.jpeg, "image/jpeg", "jpg"),
        (.png, "image/png", "png"),
        (.webP, "image/webp", "webp"),
    ]

    /// Un élément partagé → fichier copié dans `dir`, ou nil si format refusé.
    private func receive(_ provider: NSItemProvider, index: Int, into dir: URL) async throws -> Accepted? {
        for (type, mime, ext) in Self.direct where provider.hasItemConformingToTypeIdentifier(type.identifier) {
            let target = dir.appendingPathComponent("\(index)-\(safeName(provider, ext: ext))")
            try await copyRepresentation(provider, type: type, to: target)
            return Accepted(url: target, name: target.lastPathComponent.replacingOccurrences(of: "\(index)-", with: "", options: .anchored), mimeType: mime, size: size(of: target), convertedFrom: nil)
        }
        // HEIC / HEIF (photos iPhone) ou autre image : conversion JPEG signalée.
        if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            let source = dir.appendingPathComponent(".src-\(index)")
            try await copyRepresentation(provider, type: .image, to: source)
            defer { try? FileManager.default.removeItem(at: source) }
            let label = provider.hasItemConformingToTypeIdentifier(UTType.heic.identifier) ? "HEIC"
                : provider.hasItemConformingToTypeIdentifier(UTType.heif.identifier) ? "HEIF" : "image"
            let target = dir.appendingPathComponent("\(index)-\(safeName(provider, ext: "jpg"))")
            try convertToJPEG(from: source, to: target)
            return Accepted(url: target, name: target.lastPathComponent.replacingOccurrences(of: "\(index)-", with: "", options: .anchored), mimeType: "image/jpeg", size: size(of: target), convertedFrom: label)
        }
        return nil
    }

    private func safeName(_ provider: NSItemProvider, ext: String) -> String {
        let base = (provider.suggestedName ?? "Document").replacingOccurrences(of: "/", with: "-")
        let stem = (base as NSString).deletingPathExtension
        return "\(stem.isEmpty ? "Document" : String(stem.prefix(80))).\(ext)"
    }

    private func size(of url: URL) -> Int {
        (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
    }

    /// Copie immédiate de la représentation fichier (le fichier fourni est temporaire).
    private func copyRepresentation(_ provider: NSItemProvider, type: UTType, to target: URL) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, error in
                guard let url = url else { cont.resume(throwing: error ?? CocoaError(.fileReadUnknown)); return }
                do {
                    try FileManager.default.copyItem(at: url, to: target)
                    try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: target.path)
                    cont.resume()
                } catch { cont.resume(throwing: error) }
            }
        }
    }

    /// Conversion JPEG par ImageIO (API publique) : qualité maximale, orientation et métadonnées conservées.
    private func convertToJPEG(from source: URL, to target: URL) throws {
        guard let src = CGImageSourceCreateWithURL(source as CFURL, nil),
              let dest = CGImageDestinationCreateWithURL(target as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        let options: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 1.0]
        CGImageDestinationAddImageFromSource(dest, src, 0, options as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { throw CocoaError(.fileWriteUnknown) }
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: target.path)
    }
}
