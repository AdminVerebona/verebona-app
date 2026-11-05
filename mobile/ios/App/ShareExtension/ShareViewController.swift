import UIKit
import SwiftUI
import UniformTypeIdentifiers
import ImageIO

/// Extension de partage iOS « Verebona » — lot 95, réécrite au lot 108G puis
/// au lot 110A (décision PO du 04/11/2026 : le partage LANCE l'import).
///
/// ══════════════════════════════════════════════════════════════════════════
/// CE QUE FAIT L'EXTENSION
///
///  1. prépare les éléments partagés dans un dossier PROVISOIRE du groupe
///     d'apps (rien n'est envoyé) : formats documentaires acceptés par le
///     serveur (`src/lib/mobile/share-import-policy.ts`), photo HEIC / HEIF
///     CONVERTIE en JPEG (signalé), 10 fichiers et 25 Mo par fichier au plus,
///     tout refus affiché avec le nom et le motif ;
///  2. affiche une interface native COMPACTE (`ShareImportView`) : nom des
///     documents et EXACTEMENT les choix du contrat. Sur iOS :
///       « Importer dans Verebona » (libellé de l'arbitrage PO du 05/11) et « Annuler ».
///     « Importer et ouvrir Verebona » n'est PAS proposé : une extension de
///     partage ne peut pas ouvrir son application (Apple DTS, forum 776488 ;
///     `NSExtensionContext.open` est réservé aux widgets / iMessage) — aucun
///     contournement (chaîne de répondeurs, `UIApplication.open`) ;
///  3. au choix d'import : publication du partage (un identifiant d'import
///     par fichier, tiré ICI), envoi par URLSession d'ARRIÈRE-PLAN avec le
///     jeton d'import du compte (`VerebonaShareImportCore.swift`), puis
///     fermeture immédiate — l'envoi continue, application fermée. Aucune
///     seconde confirmation, aucun écran « Ajouter un document » ensuite ;
///  4. « Annuler » : copies provisoires effacées, AUCUN envoi.
/// ══════════════════════════════════════════════════════════════════════════
class ShareViewController: UIViewController {
    private let model = ShareImportModel()
    private var stagingURL: URL?
    private let shareId = UUID().uuidString

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        let host = UIHostingController(rootView: ShareImportView(model: model,
            onImport: { [weak self] in self?.commit() },
            onCancel: { [weak self] in self?.cancel() }))
        host.view.backgroundColor = .clear
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        host.didMove(toParent: self)
        Task { await prepare() }
    }

    // MARK: - Choix

    private func commit() {
        guard model.phase == .ready, let staging = stagingURL, !model.accepted.isEmpty else { return }
        model.phase = .sending // double toucher : un seul import
        // Lot 111P : rattachement au compte du jeton seulement s'il est utilisable (valide, non refusé).
        let grant = VBGrantState.current().usable
        let manifest = VBShareManifest(
            version: 2, id: shareId, createdAt: Date().timeIntervalSince1970 * 1000,
            accountKey: grant?.accountKey,
            accountHint: VBShareGrantStore.accountHint, notified: false,
            files: model.accepted, refused: model.refused.map { VBShareRefusal(name: $0.name, reason: $0.reason) })
        do {
            try VBShareStore.publish(staging: staging, manifest: manifest)
            stagingURL = nil
        } catch {
            try? FileManager.default.removeItem(at: staging)
            stagingURL = nil
            model.phase = .error("Le document n’a pas pu être préparé. Rien n’a été importé : partagez-le de nouveau.")
            return
        }
        // Envoi de fond lancé AVANT la fermeture ; il se poursuit sans l'extension.
        VBShareUploader.shared.start(shareId: shareId, role: .ext)
        extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
    }

    private func cancel() {
        if let s = stagingURL { try? FileManager.default.removeItem(at: s) }
        stagingURL = nil
        extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
    }

    // MARK: - Préparation (aucun envoi)

    @MainActor
    private func prepare() async {
        guard let inbox = VBShareStore.inboxURL() else {
            model.phase = .error("Verebona ne peut pas recevoir ce document sur ce téléphone (groupe d’apps absent). Ajoutez-le depuis l’application.")
            return
        }
        let staging = inbox.appendingPathComponent(".tmp-\(shareId)", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true,
                                                    attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        } catch {
            model.phase = .error("Le document n’a pas pu être préparé (espace de stockage du téléphone ?). Rien n’a été importé.")
            return
        }
        stagingURL = staging
        var accepted: [VBShareFile] = []
        var refused: [(name: String, reason: String)] = []
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        for (index, provider) in providers.enumerated() {
            let fallbackName = provider.suggestedName ?? "Document \(index + 1)"
            if accepted.count >= VBShareImport.maxFiles {
                refused.append((fallbackName, "\(VBShareImport.maxFiles) fichiers au plus par partage."))
                continue
            }
            do {
                if let f = try await receive(provider, index: index, into: staging) {
                    if f.size > VBShareImport.maxBytes {
                        try? FileManager.default.removeItem(at: staging.appendingPathComponent(f.path))
                        refused.append((f.name, "Fichier trop volumineux (25 Mo au plus)."))
                    } else if f.size == 0 {
                        refused.append((f.name, "Fichier vide."))
                    } else {
                        accepted.append(f)
                    }
                } else {
                    refused.append((fallbackName, "Format non pris en charge : PDF, image, Word, Excel, texte ou CSV uniquement."))
                }
            } catch {
                refused.append((fallbackName, "Fichier illisible."))
            }
        }
        model.accepted = accepted
        model.refused = refused.map { ShareImportModel.Refusal(name: $0.name, reason: $0.reason) }
        // Lot 111P : l'extension ne voit PAS la session de l'application ; elle
        // constate seulement l'état du jeton d'import local (absent, échu,
        // refusé par le serveur, illisible) et l'annonce tel quel — jamais
        // « Vous n'êtes pas connecté ». Code expurgé dans le journal natif.
        let grantState = VBGrantState.current()
        model.notice = VBShareNotice.text(for: grantState)
        model.infoLines = VBShareNotice.infoLines(excluding: shareId)
        VBShareDiag.log("EXT_SHOWN_\(grantState.status.uppercased())_\(grantState.storeCode)", .ext)
        if accepted.isEmpty {
            try? FileManager.default.removeItem(at: staging)
            stagingURL = nil
            model.phase = .error("Aucun document importable.")
        } else {
            model.phase = .ready
        }
    }

    /// Types acceptés tels quels — même liste que SHARE_IMPORT_TYPES (contrôlé par test).
    private static let direct: [(String, String, String)] = [
        ("com.adobe.pdf", "application/pdf", "pdf"),
        ("public.jpeg", "image/jpeg", "jpg"),
        ("public.png", "image/png", "png"),
        ("org.webmproject.webp", "image/webp", "webp"),
        ("com.compuserve.gif", "image/gif", "gif"),
        ("org.openxmlformats.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"),
        ("com.microsoft.word.doc", "application/msword", "doc"),
        ("org.openxmlformats.spreadsheetml.sheet", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"),
        ("com.microsoft.excel.xls", "application/vnd.ms-excel", "xls"),
        ("public.comma-separated-values-text", "text/csv", "csv"),
        ("public.plain-text", "text/plain", "txt"),
    ]

    private func receive(_ provider: NSItemProvider, index: Int, into dir: URL) async throws -> VBShareFile? {
        for (uti, mime, ext) in Self.direct where provider.hasItemConformingToTypeIdentifier(uti) {
            let path = "\(index)-\(safeName(provider, ext: ext))"
            let target = dir.appendingPathComponent(path)
            try await copyRepresentation(provider, typeIdentifier: uti, to: target)
            return try record(path: path, url: target, mime: mime, convertedFrom: nil)
        }
        // HEIC / HEIF (photos iPhone) ou autre image : conversion JPEG signalée (SHARE_IMPORT_HEIC_STRATEGY).
        if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            let source = dir.appendingPathComponent(".src-\(index)")
            try await copyRepresentation(provider, typeIdentifier: UTType.image.identifier, to: source)
            defer { try? FileManager.default.removeItem(at: source) }
            let label = provider.hasItemConformingToTypeIdentifier(UTType.heic.identifier) ? "HEIC"
                : provider.hasItemConformingToTypeIdentifier(UTType.heif.identifier) ? "HEIF" : "image"
            let path = "\(index)-\(safeName(provider, ext: "jpg"))"
            let target = dir.appendingPathComponent(path)
            try convertToJPEG(from: source, to: target)
            return try record(path: path, url: target, mime: "image/jpeg", convertedFrom: label)
        }
        return nil
    }

    private func record(path: String, url: URL, mime: String, convertedFrom: String?) throws -> VBShareFile {
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
        let name = String(path.drop(while: { $0 != "-" }).dropFirst())
        return VBShareFile(operationId: UUID().uuidString.lowercased(), path: path, name: name.isEmpty ? "Document" : name,
                           mimeType: mime, size: size, sha256: try VBShareStore.sha256(of: url), convertedFrom: convertedFrom,
                           state: VBShareState.queued, code: nil, message: nil, fileId: nil, attempts: 0, startedAt: nil)
    }

    private func safeName(_ provider: NSItemProvider, ext: String) -> String {
        let base = (provider.suggestedName ?? "Document").replacingOccurrences(of: "/", with: "-")
        let stem = (base as NSString).deletingPathExtension
        return "\(stem.isEmpty ? "Document" : String(stem.prefix(80))).\(ext)"
    }

    /// Copie immédiate de la représentation fichier (le fichier fourni est temporaire).
    private func copyRepresentation(_ provider: NSItemProvider, typeIdentifier: String, to target: URL) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            _ = provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { url, error in
                guard let url = url else { cont.resume(throwing: error ?? CocoaError(.fileReadUnknown)); return }
                do {
                    try FileManager.default.copyItem(at: url, to: target)
                    try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: target.path)
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
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: target.path)
    }
}
