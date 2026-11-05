import Foundation
import UIKit
import UserNotifications
import Capacitor

/// Lot 110A — plugin local « VerebonaShareImport » (côté application).
///
/// Pont entre la vue web (`src/lib/native/share-import.ts`) et le cœur
/// partagé avec l'extension (`Shared/VerebonaShareImportCore.swift`) :
///
///   getState()            → { available, grant: { accountKey, expiresAt, ref, refusedCode? } | null, items: [...],
///                             grantStatus, storeCode, diagnostics } (lot 111P)
///                           (le jeton n'est JAMAIS rendu à la vue : `ref` = 12 hex de son empreinte)
///   setGrant({ token, expiresAt, accountKey, uploadUrl }) → Keychain du groupe d'apps,
///                           puis reprise des imports « En attente de connexion » du compte
///   clearGrant()          → jeton retiré du téléphone (déconnexion, changement d'espace)
///   acknowledge({ id })   → partage TERMINÉ affiché : dossier purgé
///   resume()              → reprise des imports non terminés
///   consumeOpenRequest()  → { id } d'un partage dont la notification « Document
///                           ajouté » a été touchée (option B d'arbitrage), sinon {}
///   événement `stateChanged` (premier plan, fin d'un envoi, notification touchée).
@objc(VerebonaShareImportPlugin)
public class VerebonaShareImportPlugin: CAPPlugin, CAPBridgedPlugin, NotificationHandlerProtocol {
    public let identifier = "VerebonaShareImportPlugin"
    public let jsName = "VerebonaShareImport"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setGrant", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearGrant", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acknowledge", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "consumeOpenRequest", returnType: CAPPluginReturnPromise),
    ]

    override public func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(changed), name: VBShareImport.changedNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(becameActive), name: UIApplication.didBecomeActiveNotification, object: nil)
        // Notifications LOCALES uniquement (le push reste à son plugin).
        bridge?.notificationRouter.localNotificationHandler = self
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    @objc private func changed() {
        DispatchQueue.main.async { self.notifyListeners("stateChanged", data: [:]) }
    }

    @objc private func becameActive() {
        VBShareUploader.shared.resumeAll(role: .app)
        changed()
    }

    @objc func getState(_ call: CAPPluginCall) {
        let gs = VBGrantState.current()
        let items: [[String: Any]] = VBShareStore.list().map { m in
            var o: [String: Any] = [
                "id": m.id,
                "createdAt": m.createdAt,
                "files": m.files.map { f -> [String: Any] in
                    var d: [String: Any] = ["operationId": f.operationId, "name": f.name, "size": f.size, "mimeType": f.mimeType, "state": f.state]
                    if let v = f.code { d["code"] = v }
                    if let v = f.message { d["message"] = v }
                    if let v = f.fileId { d["fileId"] = v }
                    if let v = f.convertedFrom { d["convertedFrom"] = v }
                    return d
                },
                "refused": m.refused.map { ["name": $0.name, "reason": $0.reason] },
            ]
            if let k = m.accountKey { o["accountKey"] = k }
            if let h = m.accountHint { o["accountHint"] = h }
            return o
        }
        // Lot 111P : état DISTINGUÉ du jeton (present / missing / expired / refused / unreadable),
        // code du Keychain, référence non secrète, dernier refus serveur, journal natif (codes seuls).
        var out: [String: Any] = [
            "available": !VBShareImport.appGroup.isEmpty, "items": items,
            "grantStatus": gs.status, "storeCode": gs.storeCode, "diagnostics": VBShareDiag.entries(),
        ]
        if let g = gs.raw, g.isValid {
            var gd: [String: Any] = ["accountKey": g.accountKey, "expiresAt": g.expiresAt, "ref": g.ref]
            if let c = gs.refusedCode { gd["refusedCode"] = c }
            out["grant"] = gd
        }
        call.resolve(out)
    }

    @objc func setGrant(_ call: CAPPluginCall) {
        guard let token = call.getString("token"), token.hasPrefix("vbsi_"),
              let expiresAt = call.getString("expiresAt"), let accountKey = call.getString("accountKey"),
              let uploadUrl = call.getString("uploadUrl"), let u = URL(string: uploadUrl), u.scheme == "https",
              let appOrigin = bridge?.config.serverURL, u.host == appOrigin.host else {
            VBShareDiag.log("APP_SETGRANT_INVALID", .app)
            call.reject("Jeton d’import invalide", "INVALID_GRANT")
            return
        }
        let grant = VBShareGrant(token: token, expiresAt: expiresAt, accountKey: accountKey, uploadUrl: uploadUrl)
        // Lot 111P : écriture VÉRIFIÉE, motif rendu à la vue (KEYCHAIN_LOCKED, KEYCHAIN_MISSING_ENTITLEMENT…).
        let written = VBShareGrantStore.write(grant)
        VBShareDiag.log("APP_SETGRANT_\(written)", .app)
        guard written == "OK" else { call.reject("Enregistrement impossible", "KEYCHAIN_\(written)"); return }
        VBShareUploader.shared.resumeAll(role: .app)
        call.resolve(["ok": true])
    }

    @objc func clearGrant(_ call: CAPPluginCall) {
        VBShareGrantStore.clear()
        VBShareDiag.log("APP_CLEARGRANT", .app)
        call.resolve(["ok": true])
    }

    @objc func acknowledge(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), VBShareStore.isValidId(id) else { call.reject("Identifiant invalide"); return }
        if let m = VBShareStore.read(id), m.isSettled { VBShareStore.remove(id) }
        call.resolve(["ok": true])
    }

    @objc func resume(_ call: CAPPluginCall) {
        VBShareUploader.shared.resumeAll(role: .app)
        call.resolve(["ok": true])
    }

    @objc func consumeOpenRequest(_ call: CAPPluginCall) {
        let d = VBShareImport.defaults
        if let id = d?.string(forKey: VBShareImport.openRequestKey) {
            d?.removeObject(forKey: VBShareImport.openRequestKey)
            call.resolve(["id": id])
        } else {
            call.resolve([:])
        }
    }

    // MARK: NotificationHandlerProtocol (notifications locales)

    public func willPresent(notification: UNNotification) -> UNNotificationPresentationOptions {
        // Application au premier plan : la carte d'état suffit.
        return []
    }

    public func didReceive(response: UNNotificationResponse) {
        guard let id = response.notification.request.content.userInfo[VBShareImport.notificationShareKey] as? String,
              VBShareStore.isValidId(id) else { return }
        VBShareImport.defaults?.set(id, forKey: VBShareImport.openRequestKey)
        changed()
    }
}
