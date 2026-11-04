import Foundation
import UIKit
import Capacitor

/// Lot 108G — file technique des partages entrants iOS (lecture côté app).
///
/// L'extension de partage (`ShareExtension/ShareViewController.swift`) dépose
/// un dossier par partage dans le groupe d'apps : `partages-v1/<id>/` avec
/// `manifest.json` et les fichiers. Ce plugin local les rend à l'interface
/// (`src/lib/native/share-inbox.ts`), qui les propose dans le parcours d'ajout
/// habituel APRÈS Face ID / connexion, puis demande leur effacement une fois
/// l'ajout confirmé ou abandonné explicitement.
///
///   list({ maxAgeMs }) → { items: [{ id, createdAt, files: [{ uri, name, mimeType, size, convertedFrom? }], refused: [...] }], expired }
///   remove({ id })     → efface le dossier du partage (copies locales)
///   événement `inboxChanged` au retour au premier plan.
///
/// Purge : un partage plus ancien que `maxAgeMs` (7 jours par défaut, réglé
/// côté interface) est effacé à la lecture et compté dans `expired` (l'app le
/// signale). Dossiers provisoires `.tmp-*` abandonnés depuis plus d'une heure :
/// effacés. Aucune donnée n'est envoyée par ce plugin.
@objc(VerebonaShareInboxPlugin)
public class VerebonaShareInboxPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VerebonaShareInboxPlugin"
    public let jsName = "VerebonaShareInbox"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
    ]

    /// Mêmes constantes que l'extension (contrôlé par mobile/test/l108g-mode-distant.test.mjs).
    static let inboxFolder = "partages-v1"
    static let manifestName = "manifest.json"
    private static let defaultMaxAgeMs: Double = 7 * 24 * 3600 * 1000
    private static let idPattern = try! NSRegularExpression(pattern: "^[A-Fa-f0-9-]{8,64}$")

    override public func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(becameActive), name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    @objc private func becameActive() {
        notifyListeners("inboxChanged", data: [:])
    }

    private func inboxURL() -> URL? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "VBAppGroup") as? String, !group.isEmpty,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return nil }
        return container.appendingPathComponent(Self.inboxFolder, isDirectory: true)
    }

    @objc func list(_ call: CAPPluginCall) {
        guard let inbox = inboxURL() else { call.resolve(["items": [], "expired": 0, "available": false]); return }
        let fm = FileManager.default
        let maxAge = call.getDouble("maxAgeMs") ?? Self.defaultMaxAgeMs
        let now = Date().timeIntervalSince1970 * 1000
        var items: [[String: Any]] = []
        var expired = 0
        for name in (try? fm.contentsOfDirectory(atPath: inbox.path)) ?? [] {
            let dir = inbox.appendingPathComponent(name, isDirectory: true)
            if name.hasPrefix(".") {
                // Partage interrompu pendant l'écriture (extension fermée) : jamais proposé.
                let modified = (try? fm.attributesOfItem(atPath: dir.path)[.modificationDate] as? Date) ?? Date()
                if Date().timeIntervalSince(modified) > 3600 { try? fm.removeItem(at: dir) }
                continue
            }
            guard let data = try? Data(contentsOf: dir.appendingPathComponent(Self.manifestName)),
                  let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let id = manifest["id"] as? String, id == name else {
                try? fm.removeItem(at: dir)
                continue
            }
            let createdAt = (manifest["createdAt"] as? NSNumber)?.doubleValue ?? 0
            if now - createdAt > maxAge {
                try? fm.removeItem(at: dir)
                expired += 1
                continue
            }
            let files: [[String: Any]] = ((manifest["files"] as? [[String: Any]]) ?? []).compactMap { f in
                guard let path = f["path"] as? String, !path.contains("/"), !path.hasPrefix(".") else { return nil }
                let url = dir.appendingPathComponent(path)
                guard fm.fileExists(atPath: url.path) else { return nil }
                var out: [String: Any] = [
                    "uri": url.absoluteString,
                    "name": f["name"] as? String ?? path,
                    "mimeType": f["mimeType"] as? String ?? "",
                    "size": f["size"] as? Int ?? 0,
                ]
                if let c = f["convertedFrom"] as? String { out["convertedFrom"] = c }
                return out
            }
            items.append(["id": id, "createdAt": createdAt, "files": files, "refused": manifest["refused"] ?? []])
        }
        call.resolve(["items": items, "expired": expired, "available": true])
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let id = call.getString("id"),
              Self.idPattern.firstMatch(in: id, range: NSRange(id.startIndex..., in: id)) != nil,
              let inbox = inboxURL() else {
            call.reject("Identifiant de partage invalide")
            return
        }
        let dir = inbox.appendingPathComponent(id, isDirectory: true)
        if FileManager.default.fileExists(atPath: dir.path) {
            do { try FileManager.default.removeItem(at: dir) } catch { call.reject("Effacement impossible"); return }
        }
        call.resolve(["removed": true])
    }
}
