import SwiftUI
import UIKit

/// Lot 110A — interface native COMPACTE de l'extension de partage (SwiftUI).
///
/// Carte en bas d'écran : nom du ou des documents reçus, conversions et refus
/// signalés, puis EXACTEMENT les choix du contrat iOS : « Importer sans
/// ouvrir » et « Annuler » (« Importer et ouvrir Verebona » : non proposé
/// sur iOS, voir ShareViewController.swift). Plus de grande alerte « Document
/// prêt… OK » : le choix d'import EST l'import.
final class ShareImportModel: ObservableObject {
    enum Phase: Equatable { case preparing, ready, sending, error(String) }
    struct Refusal: Identifiable { let id = UUID(); let name: String; let reason: String }

    @Published var phase: Phase = .preparing
    @Published var accepted: [VBShareFile] = []
    @Published var refused: [Refusal] = []
    /// Jeton d'import valide présent : sinon, l'import se terminera à la prochaine ouverture de Verebona.
    @Published var signedIn = true
}

struct ShareImportView: View {
    @ObservedObject var model: ShareImportModel
    let onImport: () -> Void
    let onCancel: () -> Void

    private var title: String {
        switch model.phase {
        case .preparing: return "Préparation…"
        case .error: return "Import impossible"
        default:
            return model.accepted.count > 1 ? "\(model.accepted.count) documents pour Verebona" : "Document pour Verebona"
        }
    }

    private var errorMessage: String? {
        if case .error(let message) = model.phase { return message }
        return nil
    }

    var body: some View {
        VStack {
            Spacer(minLength: 0)
            VStack(alignment: .leading, spacing: 12) {
                Text(title).font(.headline).accessibilityAddTraits(.isHeader)
                if model.phase == .preparing {
                    ProgressView().frame(maxWidth: .infinity)
                }
                if let message = errorMessage {
                    Text(message).font(.subheadline).foregroundColor(.secondary)
                }
                ForEach(model.accepted.prefix(5), id: \.operationId) { f in
                    VStack(alignment: .leading, spacing: 2) {
                        Label(f.name, systemImage: "doc").font(.subheadline).lineLimit(1)
                        if let c = f.convertedFrom {
                            Text("Photo \(c) convertie en JPEG (qualité maximale).").font(.caption).foregroundColor(.secondary)
                        }
                    }
                }
                if model.accepted.count > 5 {
                    Text("et \(model.accepted.count - 5) autre(s)").font(.caption).foregroundColor(.secondary)
                }
                ForEach(model.refused) { r in
                    Text("Non repris — \(r.name) : \(r.reason)").font(.caption).foregroundColor(.secondary)
                }
                if model.phase == .ready && !model.signedIn {
                    Text("Vous n’êtes pas connecté à Verebona sur ce téléphone : l’import se terminera à la prochaine ouverture de l’application, sans rien resélectionner.")
                        .font(.caption).foregroundColor(.secondary)
                }
                if model.phase == .ready || model.phase == .sending {
                    Button(action: onImport) {
                        Text(VBShareImport.importLabel).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(model.phase != .ready)
                }
                Button(role: .cancel, action: onCancel) {
                    Text(VBShareLabels.cancel).frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .disabled(model.phase == .sending)
            }
            .padding(20)
            .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Color(UIColor.systemBackground)))
            .padding(.horizontal, 12)
            .padding(.bottom, 12)
        }
    }
}
