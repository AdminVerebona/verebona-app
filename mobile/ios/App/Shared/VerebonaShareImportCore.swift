import Foundation
import Security
import CryptoKit
import UserNotifications

/// Lot 110A — partage natif vers Verebona : cœur PARTAGÉ entre l'extension de
/// partage (`ShareExtension`) et l'application (`App`). Compilé dans les deux
/// cibles ; API publiques Apple uniquement, toutes admises dans une extension
/// (APPLICATION_EXTENSION_API_ONLY = YES) : FileManager / NSFileCoordinator,
/// Keychain (groupe d'apps), URLSession d'ARRIÈRE-PLAN, CryptoKit,
/// UserNotifications.
///
/// ══════════════════════════════════════════════════════════════════════════
/// CONTRAT (mobile/config/environments.mjs › SHARE_IMPORT, src/lib/mobile/share-import-policy.ts)
///
///  · Un dossier par partage dans le conteneur du groupe d'apps :
///    `partages-v2/<id>/manifest.json` + fichiers. Protection « complète
///    jusqu'au premier déverrouillage », exclu des sauvegardes. Le manifeste
///    porte, par fichier, l'IDENTIFIANT D'IMPORT tiré sur l'appareil
///    (`operationId`, identique à chaque reprise → aucun doublon serveur) et
///    l'état FIDÈLE : queued / uploading / waiting_network / waiting_auth /
///    imported (accusé serveur seulement) / failed (+ cause).
///  · Envoi : URLSession en ARRIÈRE-PLAN (identifiant propre à chaque
///    processus, `sharedContainerIdentifier` = groupe d'apps) : le transfert
///    continue après la fermeture de l'interface de partage, application
///    principale fermée ; à la fin, le système réveille l'application en
///    arrière-plan (`handleEventsForBackgroundURLSession`) qui enregistre
///    l'accusé.
///  · Jeton d'IMPORT (jamais la session) dans le Keychain du groupe d'apps,
///    lisible après le premier déverrouillage, propre à l'appareil. Un partage
///    n'est envoyé qu'avec le jeton DU COMPTE auquel il est rattaché.
///  · Purge : fichier local effacé dès l'accusé serveur ou l'échec définitif ;
///    dossier effacé à l'acquittement par l'app, à l'annulation, ou après
///    7 jours.
/// ══════════════════════════════════════════════════════════════════════════
enum VBShareImport {
    static let folder = "partages-v2"
    static let manifestName = "manifest.json"
    /// Comme le dépôt de l'application (src/lib/upload-limits.ts).
    static let maxFiles = 10
    static let maxBytes = 25_000_000
    static let localTtl: TimeInterval = 7 * 24 * 3600
    /// Essais automatiques d'un fichier (incidents passagers) avant échec affiché.
    static let maxAttempts = 8
    static let keychainService = "fr.verebona.share-import"
    static let keychainAccount = "grant"
    static let hintKey = "vb.shareImport.accountHint"
    static let openRequestKey = "vb.shareImport.openRequest"
    static let changedNotification = Notification.Name("VBShareImportChanged")
    static let notificationShareKey = "vbShareId"

    static var appGroup: String { (Bundle.main.object(forInfoDictionaryKey: "VBAppGroup") as? String) ?? "" }
    /// Après arbitrage PO (option B) : notification locale « Document ajouté » après l'accusé serveur.
    static var completionNotice: Bool { flag("VBShareCompletionNotice") }
    /// Libellé du bouton d'import iOS (« Importer sans ouvrir » par défaut, libellé validé).
    static var importLabel: String {
        let v = (Bundle.main.object(forInfoDictionaryKey: "VBShareImportLabel") as? String ?? "").trimmingCharacters(in: .whitespaces)
        return v.isEmpty || v.hasPrefix("$(") ? VBShareLabels.importOnly : v
    }
    private static func flag(_ key: String) -> Bool {
        let v = ((Bundle.main.object(forInfoDictionaryKey: key) as? String) ?? "").uppercased()
        return v == "YES" || v == "TRUE" || v == "1"
    }
    static var defaults: UserDefaults? { appGroup.isEmpty ? nil : UserDefaults(suiteName: appGroup) }
}

/// Libellés validés par le PO (04/11/2026) — identiques à src/lib/mobile/share-import-policy.ts.
/// « Importer et ouvrir Verebona » n'est PAS proposé sur iOS : aucune API
/// publique ne permet à une extension de partage d'ouvrir l'application
/// (Apple DTS, forum 776488) — voir docs/mobile/partage-natif-110a.md.
enum VBShareLabels {
    static let importAndOpen = "Importer et ouvrir Verebona"
    static let importOnly = "Importer sans ouvrir"
    static let cancel = "Annuler"
}

/// États fidèles (mêmes clés que SHARE_IMPORT_STATUS_LABELS).
enum VBShareState {
    static let queued = "queued"
    static let uploading = "uploading"
    static let waitingNetwork = "waiting_network"
    static let waitingAuth = "waiting_auth"
    static let imported = "imported"
    static let failed = "failed"
    static func isFinal(_ s: String) -> Bool { s == imported || s == failed }
}

// MARK: - Jeton d'import (Keychain du groupe d'apps)

struct VBShareGrant: Codable {
    let token: String
    let expiresAt: String
    let accountKey: String
    let uploadUrl: String

    var expiry: Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: expiresAt) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: expiresAt)
    }
    var isValid: Bool { (expiry ?? .distantPast) > Date() && URL(string: uploadUrl)?.scheme == "https" }

    /// Lot 111P : référence NON SECRÈTE du jeton — 12 premiers caractères
    /// hexadécimaux de SHA-256(jeton), identique à `token_hash` tronqué côté
    /// serveur (`shareImportGrantRef`). Sert au diagnostic et à la
    /// vérification serveur légère ; ne permet ni de retrouver ni d'utiliser le jeton.
    var ref: String {
        let digest = SHA256.hash(data: Data(token.utf8))
        return String(digest.map { String(format: "%02x", $0) }.joined().prefix(12))
    }
}

/// Lot 111P — code STABLE d'un retour du Keychain (diagnostic distingué :
/// jeton absent ≠ appareil verrouillé ≠ droit / groupe d'accès manquant ≠
/// donnée illisible). Jamais le contenu de l'élément.
enum VBKeychainCode {
    static func of(_ status: OSStatus) -> String {
        switch status {
        case errSecSuccess: return "OK"
        case errSecItemNotFound: return "NOT_FOUND"
        // Lecture refusée tant que l'appareil n'a pas été déverrouillé une première fois
        // (accessibilité « après le premier déverrouillage »), ou interaction interdite.
        case errSecInteractionNotAllowed: return "LOCKED"
        // Groupe d'accès absent des droits signés (App Group non coché sur l'identifiant de l'app ou de l'extension).
        case errSecMissingEntitlement: return "MISSING_ENTITLEMENT"
        case errSecDuplicateItem: return "DUPLICATE"
        case errSecAuthFailed: return "AUTH_FAILED"
        case errSecNotAvailable: return "NOT_AVAILABLE"
        case errSecParam: return "PARAM"
        default: return "OS_\(status)"
        }
    }
}

/// Lecture du Keychain : le jeton s'il est lisible, sinon le code de la cause.
struct VBGrantRead {
    let grant: VBShareGrant?
    /// OK | NOT_FOUND | LOCKED | MISSING_ENTITLEMENT | NO_APP_GROUP | DECODE | OS_<n>
    let code: String
}

enum VBShareGrantStore {
    private static func query() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: VBShareImport.keychainService,
            kSecAttrAccount as String: VBShareImport.keychainAccount,
            // Groupe d'apps = groupe d'accès Keychain partagé app ↔ extension
            // (droit com.apple.security.application-groups des DEUX cibles ;
            // contrôlé sur le binaire signé par .github/workflows/mobile-ios.yml).
            kSecAttrAccessGroup as String: VBShareImport.appGroup,
        ]
    }

    /// Lot 111P : lecture DISTINGUÉE (absent, verrouillé, droit manquant, décodage).
    static func load() -> VBGrantRead {
        guard !VBShareImport.appGroup.isEmpty else { return VBGrantRead(grant: nil, code: "NO_APP_GROUP") }
        var q = query()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        guard status == errSecSuccess else { return VBGrantRead(grant: nil, code: VBKeychainCode.of(status)) }
        guard let data = out as? Data, let grant = try? JSONDecoder().decode(VBShareGrant.self, from: data) else {
            return VBGrantRead(grant: nil, code: "DECODE")
        }
        return VBGrantRead(grant: grant, code: "OK")
    }

    static func read() -> VBShareGrant? { load().grant }

    /// Lot 111P : écriture VÉRIFIÉE. Mise à jour EN PLACE (l'extension ne voit
    /// jamais un instant « sans jeton »), sinon ajout ; puis relecture du même
    /// jeton. Rend "OK" ou le code de l'échec (rejet du plugin `KEYCHAIN_<code>`).
    static func write(_ grant: VBShareGrant) -> String {
        guard !VBShareImport.appGroup.isEmpty else { return "NO_APP_GROUP" }
        guard let data = try? JSONEncoder().encode(grant) else { return "ENCODE" }
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            // Lisible par l'envoi de fond et l'extension après le premier déverrouillage ; jamais sauvegardé ni migré.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(query() as CFDictionary, attributes as CFDictionary)
        if status != errSecSuccess && status != errSecItemNotFound {
            // Élément antérieur non modifiable (attributs d'une ancienne version) : remplacé.
            VBShareDiag.log("KEYCHAIN_UPDATE_\(VBKeychainCode.of(status))", .app)
            SecItemDelete(query() as CFDictionary)
            status = errSecItemNotFound
        }
        if status == errSecItemNotFound {
            var q = query()
            for (k, v) in attributes { q[k] = v }
            status = SecItemAdd(q as CFDictionary, nil)
        }
        guard status == errSecSuccess else { return VBKeychainCode.of(status) }
        let check = load()
        guard check.grant?.token == grant.token else { return "VERIFY_\(check.code)" }
        VBShareImport.defaults?.set(grant.accountKey, forKey: VBShareImport.hintKey)
        VBShareRefusals.clear()
        return "OK"
    }

    static func clear() {
        guard !VBShareImport.appGroup.isEmpty else { return }
        SecItemDelete(query() as CFDictionary)
        VBShareRefusals.clear()
    }

    /// Dernier compte connu de l'appareil (non secret) : rattachement d'un partage fait sans jeton valide.
    static var accountHint: String? { VBShareImport.defaults?.string(forKey: VBShareImport.hintKey) }
}

/// Lot 111P — dernier refus du SERVEUR pour UN jeton (par sa référence non
/// secrète), écrit par l'envoi de fond : l'extension et l'app savent qu'il ne
/// sert plus, sans attendre son échéance. Effacé par l'écriture d'un nouveau jeton.
enum VBShareRefusals {
    static let key = "vb.shareImport.grantRefusal"
    /// Mêmes codes que SHARE_IMPORT_RENEWABLE_REFUSALS (src/lib/mobile/share-import-policy.ts).
    static let renewable: Set<String> = ["GRANT_INVALID", "GRANT_EXPIRED", "GRANT_REVOKED", "GRANT_EXHAUSTED", "SESSION_REVOKED", "MFA_REQUIRED", "CGUV_REACCEPTANCE_REQUIRED"]

    static func mark(ref: String, code: String) {
        guard renewable.contains(code) else { return }
        VBShareImport.defaults?.set(["ref": ref, "code": code], forKey: key)
    }
    static func code(for ref: String) -> String? {
        guard let d = VBShareImport.defaults?.dictionary(forKey: key), d["ref"] as? String == ref else { return nil }
        return d["code"] as? String
    }
    static func clear() { VBShareImport.defaults?.removeObject(forKey: key) }
}

/// Lot 111P — journal technique NATIF (30 derniers événements, conteneur du
/// groupe d'apps) : codes seuls — jamais de jeton, compte, nom de fichier ni
/// contenu. Repris par la vue (`getState().diagnostics`) dans son journal.
enum VBShareDiag {
    static let key = "vb.shareImport.diag"
    static let max = 30

    static func log(_ code: String, _ role: VBShareRole) {
        guard let d = VBShareImport.defaults,
              code.range(of: "^[A-Z0-9_-]{1,48}$", options: .regularExpression) != nil else { return }
        var list = (d.array(forKey: key) as? [[String: Any]]) ?? []
        list.append(["t": (Date().timeIntervalSince1970 * 1000).rounded(), "c": code, "s": role.rawValue])
        d.set(Array(list.suffix(max)), forKey: key)
    }

    static func entries() -> [[String: Any]] { (VBShareImport.defaults?.array(forKey: key) as? [[String: Any]]) ?? [] }

    /// Code serveur ramené à un jeton de diagnostic sûr (majuscules, chiffres, `_`).
    static func safe(_ code: String?) -> String {
        let c = (code ?? "NONE").uppercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_") }
        return c.isEmpty ? "NONE" : String(c.prefix(32))
    }
}

/// Lot 111P — état du jeton tel que le natif peut le CONSTATER. Le natif ne
/// voit pas la session de l'application : il n'affirme jamais une déconnexion.
///   present · missing · expired · refused (par le serveur) · unreadable
struct VBGrantState {
    let raw: VBShareGrant?
    let status: String
    let storeCode: String
    let refusedCode: String?

    /// Jeton utilisable pour un envoi : présent, valide localement, non refusé.
    var usable: VBShareGrant? { status == "present" ? raw : nil }

    static func current() -> VBGrantState {
        let r = VBShareGrantStore.load()
        guard let g = r.grant else {
            return VBGrantState(raw: nil, status: r.code == "NOT_FOUND" ? "missing" : "unreadable", storeCode: r.code, refusedCode: nil)
        }
        if !g.isValid { return VBGrantState(raw: g, status: "expired", storeCode: r.code, refusedCode: nil) }
        if let c = VBShareRefusals.code(for: g.ref) { return VBGrantState(raw: g, status: "refused", storeCode: r.code, refusedCode: c) }
        return VBGrantState(raw: g, status: "present", storeCode: r.code, refusedCode: nil)
    }
}

/// Lot 111P — textes de l'interface de partage (mêmes clés et textes que
/// SHARE_IMPORT_EXTENSION_NOTICES et que l'Android ; contrôlé par test).
enum VBShareNotice {
    static let texts: [String: String] = [
        "token_missing": "L’import se terminera à la prochaine ouverture de Verebona, sans rien resélectionner.",
        "token_expired": "L’autorisation d’import de ce téléphone a expiré : l’import se terminera à la prochaine ouverture de Verebona, sans rien resélectionner.",
        "token_refused": "L’autorisation d’import de ce téléphone doit être renouvelée : l’import se terminera à la prochaine ouverture de Verebona, sans rien resélectionner.",
        "session_refused": "Verebona a fermé la session de ce téléphone : l’import se terminera après votre reconnexion, sans rien resélectionner.",
        "mfa_required": "Verebona demande de confirmer votre connexion (double authentification) : l’import se terminera ensuite, sans rien resélectionner.",
        "terms_required": "Ouvrez Verebona pour accepter les nouvelles conditions : l’import se terminera ensuite, sans rien resélectionner.",
        "token_unreadable": "L’autorisation d’import n’a pas pu être lue sur ce téléphone : l’import se terminera à la prochaine ouverture de Verebona, sans rien resélectionner.",
        "pending_auth": "Un import précédent attend aussi la prochaine ouverture de Verebona.",
        "server_unavailable": "Le dernier envoi n’a pas abouti (réseau ou serveur indisponible) : il reprendra automatiquement.",
    ]

    /// Clé du texte principal ; nil = jeton prêt, aucun texte.
    static func key(for s: VBGrantState) -> String? {
        switch s.status {
        case "present": return nil
        case "missing": return "token_missing"
        case "expired": return "token_expired"
        case "refused":
            switch s.refusedCode {
            case "SESSION_REVOKED": return "session_refused"
            case "MFA_REQUIRED": return "mfa_required"
            case "CGUV_REACCEPTANCE_REQUIRED": return "terms_required"
            default: return "token_refused"
            }
        default: return "token_unreadable"
        }
    }

    static func text(for s: VBGrantState) -> String? { key(for: s).flatMap { texts[$0] } }

    /// Lignes d'information sur les imports PRÉCÉDENTS encore sur le téléphone.
    static func infoLines(excluding id: String) -> [String] {
        let files = VBShareStore.list().filter { $0.id != id }.flatMap { $0.files }
        var out: [String] = []
        if files.contains(where: { $0.state == VBShareState.waitingAuth }), let t = texts["pending_auth"] { out.append(t) }
        if files.contains(where: { $0.state == VBShareState.waitingNetwork }), let t = texts["server_unavailable"] { out.append(t) }
        return out
    }
}

// MARK: - Manifeste d'un partage

struct VBShareRefusal: Codable { var name: String; var reason: String }

struct VBShareFile: Codable {
    var operationId: String
    var path: String
    var name: String
    var mimeType: String
    var size: Int
    var sha256: String
    var convertedFrom: String?
    var state: String
    var code: String?
    var message: String?
    var fileId: Int?
    var attempts: Int
    /// Début du dernier envoi (reprise d'un envoi perdu : fermeture forcée, redémarrage).
    var startedAt: Double?
}

struct VBShareManifest: Codable {
    var version: Int
    var id: String
    var createdAt: Double
    var accountKey: String?
    var accountHint: String?
    var notified: Bool?
    var files: [VBShareFile]
    var refused: [VBShareRefusal]

    var isSettled: Bool { !files.isEmpty && files.allSatisfy { VBShareState.isFinal($0.state) } }
}

enum VBShareStore {
    static func inboxURL() -> URL? {
        guard !VBShareImport.appGroup.isEmpty,
              let c = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: VBShareImport.appGroup) else { return nil }
        let u = c.appendingPathComponent(VBShareImport.folder, isDirectory: true)
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true,
                                                 attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        return u
    }

    static func dir(_ id: String) -> URL? {
        guard isValidId(id) else { return nil }
        return inboxURL()?.appendingPathComponent(id, isDirectory: true)
    }

    static func isValidId(_ id: String) -> Bool {
        id.count >= 8 && id.count <= 64 && id.allSatisfy { $0.isHexDigit || $0 == "-" }
    }

    private static func decode(_ url: URL) -> VBShareManifest? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(VBShareManifest.self, from: data)
    }

    private static func encode(_ m: VBShareManifest, to url: URL) throws {
        let data = try JSONEncoder().encode(m)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    /// Partages présents (dossiers provisoires abandonnés et partages de plus de 7 jours : effacés).
    static func list() -> [VBShareManifest] {
        guard let inbox = inboxURL() else { return [] }
        let fm = FileManager.default
        var out: [VBShareManifest] = []
        for name in (try? fm.contentsOfDirectory(atPath: inbox.path)) ?? [] {
            let d = inbox.appendingPathComponent(name, isDirectory: true)
            if name.hasPrefix(".") {
                let modified = (try? fm.attributesOfItem(atPath: d.path)[.modificationDate] as? Date) ?? Date()
                if Date().timeIntervalSince(modified) > 3600 { try? fm.removeItem(at: d) }
                continue
            }
            guard let m = decode(d.appendingPathComponent(VBShareImport.manifestName)), m.id == name else {
                try? fm.removeItem(at: d)
                continue
            }
            if Date().timeIntervalSince1970 * 1000 - m.createdAt > VBShareImport.localTtl * 1000 {
                try? fm.removeItem(at: d)
                continue
            }
            out.append(m)
        }
        return out.sorted { $0.createdAt < $1.createdAt }
    }

    static func read(_ id: String) -> VBShareManifest? {
        guard let d = dir(id) else { return nil }
        return decode(d.appendingPathComponent(VBShareImport.manifestName))
    }

    /// Lecture-modification-écriture coordonnée ENTRE PROCESSUS (extension / application).
    @discardableResult
    static func update(_ id: String, _ mutate: (inout VBShareManifest) -> Void) -> VBShareManifest? {
        guard let d = dir(id) else { return nil }
        let url = d.appendingPathComponent(VBShareImport.manifestName)
        var result: VBShareManifest?
        var coordError: NSError?
        NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: url, options: .forMerging, error: &coordError) { u in
            guard var m = decode(u) else { return }
            mutate(&m)
            // Purge immédiate des copies dont l'import est terminé (accusé ou échec définitif).
            for f in m.files where VBShareState.isFinal(f.state) {
                try? FileManager.default.removeItem(at: d.appendingPathComponent(f.path))
            }
            if (try? encode(m, to: u)) != nil { result = m }
        }
        if result != nil { NotificationCenter.default.post(name: VBShareImport.changedNotification, object: nil) }
        return result
    }

    /// Publication d'un partage préparé (manifeste puis renommage atomique du dossier).
    static func publish(staging: URL, manifest: VBShareManifest) throws {
        guard let final = dir(manifest.id) else { throw CocoaError(.fileWriteInvalidFileName) }
        try encode(manifest, to: staging.appendingPathComponent(VBShareImport.manifestName))
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var s = staging
        try? s.setResourceValues(values)
        try FileManager.default.moveItem(at: staging, to: final)
    }

    static func remove(_ id: String) {
        guard let d = dir(id) else { return }
        try? FileManager.default.removeItem(at: d)
        NotificationCenter.default.post(name: VBShareImport.changedNotification, object: nil)
    }

    static func fileURL(_ id: String, _ path: String) -> URL? {
        guard !path.contains("/"), !path.hasPrefix(".") else { return nil }
        return dir(id)?.appendingPathComponent(path)
    }

    /// Empreinte SHA-256 en flux (fichiers jusqu'à 25 Mo, mémoire bornée).
    static func sha256(of url: URL) throws -> String {
        let h = try FileHandle(forReadingFrom: url)
        defer { try? h.close() }
        var hasher = SHA256()
        while true {
            let chunk = try h.read(upToCount: 1 << 20) ?? Data()
            if chunk.isEmpty { break }
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

// MARK: - Envoi en arrière-plan

/// Rôle du processus : chaque processus a SA session d'arrière-plan
/// (une session d'arrière-plan n'est utilisable que par un processus à la fois).
enum VBShareRole: String { case ext, app }

final class VBShareUploader: NSObject, URLSessionDataDelegate {
    static let shared = VBShareUploader()

    private let lock = NSLock()
    private var sessions: [String: URLSession] = [:]
    private var completions: [String: () -> Void] = [:]
    private var bodies: [String: Data] = [:]
    private let queue: OperationQueue = {
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1
        q.name = "fr.verebona.share-import"
        return q
    }()

    static func identifier(_ role: VBShareRole) -> String { "\(VBShareImport.appGroup).share-import.\(role.rawValue)" }
    static func isOurs(_ identifier: String) -> Bool { identifier.hasPrefix("\(VBShareImport.appGroup).share-import.") }

    private func session(_ identifier: String) -> URLSession {
        lock.lock(); defer { lock.unlock() }
        if let s = sessions[identifier] { return s }
        let cfg = URLSessionConfiguration.background(withIdentifier: identifier)
        cfg.sharedContainerIdentifier = VBShareImport.appGroup
        cfg.sessionSendsLaunchEvents = true
        cfg.isDiscretionary = false
        cfg.httpCookieAcceptPolicy = .never
        cfg.httpShouldSetCookies = false
        cfg.urlCache = nil
        let s = URLSession(configuration: cfg, delegate: self, delegateQueue: queue)
        sessions[identifier] = s
        return s
    }

    /// Application réveillée par le système à la fin d'un envoi (y compris ceux de l'extension).
    func handleEvents(identifier: String, completion: @escaping () -> Void) -> Bool {
        guard Self.isOurs(identifier) else { return false }
        lock.lock(); completions[identifier] = completion; lock.unlock()
        _ = session(identifier)
        return true
    }

    /// Lance l'envoi des fichiers en attente d'un partage, avec le jeton DE SON compte.
    func start(shareId: String, role: VBShareRole, delay: TimeInterval = 0) {
        // Lot 111P : jeton « utilisable » = présent, valide localement ET non refusé par le serveur
        // (un jeton déjà refusé n'est pas renvoyé en boucle ; il attend le renouvellement par l'app).
        let state = VBGrantState.current()
        let grant = state.usable
        let s = session(Self.identifier(role))
        var tasks: [URLSessionUploadTask] = []
        var waiting = false
        VBShareStore.update(shareId) { m in
            if m.accountKey == nil, let g = grant, g.isValid, m.accountHint == nil || m.accountHint == g.accountKey {
                m.accountKey = g.accountKey
            }
            let usable = grant.flatMap { g in g.isValid && g.accountKey == m.accountKey ? g : nil }
            for i in m.files.indices where !VBShareState.isFinal(m.files[i].state) && m.files[i].state != VBShareState.uploading {
                guard let g = usable else {
                    m.files[i].state = VBShareState.waitingAuth
                    // Cause CONSTATÉE (jamais « vous n'êtes pas connecté ») ; jeton d'un autre compte : en attente du bon.
                    m.files[i].code = state.refusedCode ?? (grant != nil ? "LOCAL_OTHER_ACCOUNT" : "LOCAL_\(state.status.uppercased())")
                    m.files[i].message = VBShareNotice.text(for: state) ?? VBShareNotice.texts["token_missing"]
                    waiting = true
                    continue
                }
                guard let file = VBShareStore.fileURL(m.id, m.files[i].path), FileManager.default.fileExists(atPath: file.path),
                      let url = URL(string: g.uploadUrl) else {
                    m.files[i].state = VBShareState.failed
                    m.files[i].message = "Fichier plus disponible sur ce téléphone : partagez-le de nouveau."
                    continue
                }
                var req = URLRequest(url: url)
                req.httpMethod = "POST"
                req.setValue("Bearer \(g.token)", forHTTPHeaderField: "Authorization")
                req.setValue(m.files[i].mimeType, forHTTPHeaderField: "Content-Type")
                req.setValue(m.files[i].operationId, forHTTPHeaderField: "X-Verebona-Operation-Id")
                req.setValue(m.files[i].name.addingPercentEncoding(withAllowedCharacters: Self.headerSafe) ?? "document", forHTTPHeaderField: "X-Verebona-File-Name")
                req.setValue(m.files[i].sha256, forHTTPHeaderField: "X-Verebona-Sha256")
                req.setValue("IOS", forHTTPHeaderField: "X-Verebona-Share-Client")
                let task = s.uploadTask(with: req, fromFile: file)
                // Lot 111P : référence NON secrète du jeton utilisé (refus serveur attribué au BON jeton).
                task.taskDescription = "\(m.id)|\(m.files[i].operationId)|\(g.ref)"
                if delay > 0 { task.earliestBeginDate = Date().addingTimeInterval(delay) }
                m.files[i].state = VBShareState.uploading
                m.files[i].message = nil
                // Envoi différé (reprise) : compté à partir de son début prévu.
                m.files[i].startedAt = Date().timeIntervalSince1970 + delay
                tasks.append(task)
            }
        }
        tasks.forEach { $0.resume() }
        if waiting { VBShareDiag.log("UPLOAD_WAIT_\(state.status.uppercased())_\(state.storeCode)", role) }
        if !tasks.isEmpty { VBShareDiag.log("UPLOAD_START", role) }
    }

    /// Envoi réputé perdu au-delà de ce délai sans accusé (fermeture forcée, redémarrage du téléphone).
    static let staleUploadAfter: TimeInterval = 15 * 60

    /// ASCII sûr pour un en-tête HTTP (nom de fichier encodé en pourcentage UTF-8).
    static let headerSafe = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.")

    /// Reprise de tous les partages non terminés (nouveau jeton, retour au premier plan).
    /// Un envoi « en cours » sans accusé depuis 15 min est relancé : l'identifiant
    /// d'import rend la reprise sans risque de doublon (le serveur rend le document existant).
    func resumeAll(role: VBShareRole) {
        let now = Date().timeIntervalSince1970
        for m in VBShareStore.list() where !m.isSettled {
            if m.files.contains(where: { $0.state == VBShareState.uploading && now - ($0.startedAt ?? 0) > Self.staleUploadAfter }) {
                VBShareStore.update(m.id) { mm in
                    for i in mm.files.indices where mm.files[i].state == VBShareState.uploading && now - (mm.files[i].startedAt ?? 0) > Self.staleUploadAfter {
                        mm.files[i].state = VBShareState.queued
                    }
                }
            }
            start(shareId: m.id, role: role)
        }
    }

    // MARK: URLSessionDataDelegate

    private func key(_ session: URLSession, _ task: URLSessionTask) -> String {
        "\(session.configuration.identifier ?? "")#\(task.taskIdentifier)"
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let k = key(session, dataTask)
        lock.lock(); bodies[k, default: Data()].append(data); lock.unlock()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let k = key(session, task)
        lock.lock(); let body = bodies.removeValue(forKey: k); lock.unlock()
        guard let parts = task.taskDescription?.split(separator: "|").map(String.init), parts.count >= 2 else { return }
        let (shareId, operationId) = (parts[0], parts[1])
        let usedRef: String? = parts.count > 2 ? parts[2] : nil
        let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        let json = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        let outcome = Self.outcome(status: status, json: json, transportError: error)
        let role: VBShareRole = session.configuration.identifier == Self.identifier(.ext) ? .ext : .app
        let serverCode = json["code"] as? String
        // Lot 111P : trace expurgée (catégorie + code serveur ou statut HTTP ; jamais le jeton ni le nom du fichier).
        switch outcome {
        case "imported": VBShareDiag.log("UPLOAD_OK", role)
        case "auth": VBShareDiag.log("UPLOAD_AUTH_\(VBShareDiag.safe(serverCode))", role)
        case "refused": VBShareDiag.log("UPLOAD_REFUSED_\(VBShareDiag.safe(serverCode))", role)
        default: VBShareDiag.log(error != nil ? "UPLOAD_RETRY_NETWORK" : "UPLOAD_RETRY_HTTP_\(status)", role)
        }
        // Jeton refusé par le serveur : marqué (par sa référence) pour l'extension et l'app, qui le renouvelle.
        if outcome == "auth", let ref = usedRef, let code = serverCode { VBShareRefusals.mark(ref: ref, code: code) }
        var retryDelay: TimeInterval? = nil
        let updated = VBShareStore.update(shareId) { m in
            guard let i = m.files.firstIndex(where: { $0.operationId == operationId }) else { return }
            switch outcome {
            case "imported":
                m.files[i].state = VBShareState.imported
                m.files[i].fileId = json["fileId"] as? Int
                m.files[i].code = nil
                m.files[i].message = nil
            case "refused":
                m.files[i].state = VBShareState.failed
                m.files[i].code = json["code"] as? String
                m.files[i].message = (json["message"] as? String) ?? "Le document n’a pas pu être importé."
            case "auth":
                m.files[i].state = VBShareState.waitingAuth
                m.files[i].code = serverCode
                m.files[i].message = (json["message"] as? String) ?? VBShareNotice.texts["token_refused"]
            default:
                m.files[i].attempts += 1
                if m.files[i].attempts >= VBShareImport.maxAttempts {
                    m.files[i].state = VBShareState.failed
                    m.files[i].message = "Import impossible après plusieurs essais : partagez de nouveau le document."
                } else {
                    m.files[i].state = error != nil ? VBShareState.waitingNetwork : VBShareState.queued
                    m.files[i].message = error != nil ? "En attente de réseau." : nil
                    retryDelay = min(pow(2.0, Double(m.files[i].attempts)) * 15, 3600)
                }
            }
        }
        if let delay = retryDelay {
            start(shareId: shareId, role: role, delay: delay)
        } else if outcome == "auth", let fresh = VBGrantState.current().usable, fresh.ref != usedRef {
            // Un jeton PLUS RÉCENT est déjà là (renouvelé pendant l'envoi) : reprise immédiate avec lui.
            // Sans boucle : un refus de ce nouveau jeton le marque à son tour, et il n'est plus « utilisable ».
            start(shareId: shareId, role: role)
        }
        if let done = updated, done.isSettled { notifyIfEnabled(done) }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        guard let id = session.configuration.identifier else { return }
        lock.lock(); let c = completions.removeValue(forKey: id); lock.unlock()
        if let c = c { DispatchQueue.main.async { c() } }
    }

    /// Catégorie d'une réponse (mêmes règles que `classifyDepotStatus` côté serveur).
    static func outcome(status: Int, json: [String: Any], transportError: Error?) -> String {
        if transportError != nil { return "retry" }
        if let o = json["outcome"] as? String, ["imported", "refused", "auth", "retry"].contains(o) {
            // Seul un 2xx vaut accusé d'enregistrement, quel que soit le corps.
            if o == "imported" { return (200..<300).contains(status) ? "imported" : "retry" }
            return o
        }
        if (200..<300).contains(status) { return "retry" } // 2xx sans accusé lisible : jamais un faux succès
        if status == 401 { return "auth" }
        if status == 408 || status == 429 || status >= 500 || status == 0 { return "retry" }
        return "refused"
    }

    /// Option B (arbitrage PO) : notification locale SANS nom de fichier.
    private func notifyIfEnabled(_ m: VBShareManifest) {
        guard VBShareImport.completionNotice, m.notified != true, m.files.contains(where: { $0.state == VBShareState.imported }) else { return }
        VBShareStore.update(m.id) { $0.notified = true }
        let content = UNMutableNotificationContent()
        let n = m.files.filter { $0.state == VBShareState.imported }.count
        content.title = n > 1 ? "\(n) documents ajoutés à Verebona" : "Document ajouté à Verebona"
        content.body = "Touchez pour l’ouvrir."
        content.userInfo = [VBShareImport.notificationShareKey: m.id]
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "vb-share-\(m.id)", content: content, trigger: nil))
    }
}
