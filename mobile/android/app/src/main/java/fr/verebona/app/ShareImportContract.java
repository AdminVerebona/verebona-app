package fr.verebona.app;

/**
 * Lot 110A — contrat du partage natif Android, identique à iOS et au serveur
 * (src/lib/mobile/share-import-policy.ts ; contrôlé par mobile/test/l110a-partage-natif.test.mjs).
 */
final class ShareImportContract {
    private ShareImportContract() {}

    /** Libellés validés par le PO (04/11/2026). */
    static final String LABEL_IMPORT_AND_OPEN = "Importer et ouvrir Verebona";
    static final String LABEL_IMPORT_ONLY = "Importer sans ouvrir";
    static final String LABEL_CANCEL = "Annuler";

    /** Comme le dépôt de l'application (src/lib/upload-limits.ts). */
    static final int MAX_FILES = 10;
    static final long MAX_BYTES = 25_000_000L;
    static final long LOCAL_TTL_MS = 7L * 24 * 3600 * 1000;
    /** Essais automatiques d'un fichier (incidents passagers) avant échec affiché. */
    static final int MAX_ATTEMPTS = 8;

    /** États fidèles (mêmes clés que SHARE_IMPORT_STATUS_LABELS). */
    static final String QUEUED = "queued";
    static final String UPLOADING = "uploading";
    static final String WAITING_NETWORK = "waiting_network";
    static final String WAITING_AUTH = "waiting_auth";
    static final String IMPORTED = "imported";
    static final String FAILED = "failed";

    static boolean isFinal(String s) { return IMPORTED.equals(s) || FAILED.equals(s); }

    /** Formats acceptés tels quels : { type MIME, extension } — même liste que SHARE_IMPORT_TYPES. */
    static final String[][] TYPES = {
        { "application/pdf", "pdf" },
        { "image/jpeg", "jpg" },
        { "image/png", "png" },
        { "image/webp", "webp" },
        { "image/gif", "gif" },
        { "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx" },
        { "application/msword", "doc" },
        { "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx" },
        { "application/vnd.ms-excel", "xls" },
        { "text/plain", "txt" },
        { "text/csv", "csv" },
    };

    /** Photos HEIC / HEIF : converties en JPEG sur le téléphone (Android 9+), sinon refusées avec motif. */
    static final String[] HEIC = { "image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence" };

    static String extensionFor(String mime) {
        if (mime == null) return null;
        String m = mime.toLowerCase(java.util.Locale.ROOT);
        if ("text/comma-separated-values".equals(m)) m = "text/csv";
        for (String[] t : TYPES) if (t[0].equals(m)) return t[1];
        return null;
    }

    static String normalizeMime(String mime) {
        if (mime == null) return "";
        String m = mime.toLowerCase(java.util.Locale.ROOT);
        return "text/comma-separated-values".equals(m) ? "text/csv" : m;
    }

    static boolean isHeic(String mime) {
        if (mime == null) return false;
        String m = mime.toLowerCase(java.util.Locale.ROOT);
        for (String h : HEIC) if (h.equals(m)) return true;
        return false;
    }

    /**
     * Lot 111P — textes de l'interface de partage : mêmes clés et mêmes textes
     * qu'iOS et que SHARE_IMPORT_EXTENSION_NOTICES (contrôlé par
     * mobile/test/l111p-partage-ios-jeton.test.mjs). Jamais « Vous n'êtes pas
     * connecté » : le natif ne voit que le jeton d'import, pas la session.
     */
    static final String[][] NOTICES = {
        { "token_missing", "L’import se terminera à la prochaine ouverture de Verebona, sans rien resélectionner." },
        { "token_expired", "L’autorisation d’import de ce téléphone a expiré : l’import se terminera à la prochaine ouverture de Verebona, sans rien resélectionner." },
        { "token_refused", "L’autorisation d’import de ce téléphone doit être renouvelée : l’import se terminera à la prochaine ouverture de Verebona, sans rien resélectionner." },
        { "session_refused", "Verebona a fermé la session de ce téléphone : l’import se terminera après votre reconnexion, sans rien resélectionner." },
        { "mfa_required", "Verebona demande de confirmer votre connexion (double authentification) : l’import se terminera ensuite, sans rien resélectionner." },
        { "terms_required", "Ouvrez Verebona pour accepter les nouvelles conditions : l’import se terminera ensuite, sans rien resélectionner." },
        { "token_unreadable", "L’autorisation d’import n’a pas pu être lue sur ce téléphone : l’import se terminera à la prochaine ouverture de Verebona, sans rien resélectionner." },
        { "pending_auth", "Un import précédent attend aussi la prochaine ouverture de Verebona." },
        { "server_unavailable", "Le dernier envoi n’a pas abouti (réseau ou serveur indisponible) : il reprendra automatiquement." },
    };

    /** Mêmes codes que SHARE_IMPORT_RENEWABLE_REFUSALS : refus serveur d'un jeton qui justifient son renouvellement. */
    static final String[] RENEWABLE_REFUSALS = {
        "GRANT_INVALID", "GRANT_EXPIRED", "GRANT_REVOKED", "GRANT_EXHAUSTED", "SESSION_REVOKED", "MFA_REQUIRED", "CGUV_REACCEPTANCE_REQUIRED",
    };

    /** États CONSTATÉS du jeton local (mêmes valeurs qu'iOS et que `NativeGrantStatus`). */
    static final String GRANT_PRESENT = "present";
    static final String GRANT_MISSING = "missing";
    static final String GRANT_EXPIRED = "expired";
    static final String GRANT_REFUSED = "refused";
    static final String GRANT_UNREADABLE = "unreadable";

    static boolean isRenewableRefusal(String code) {
        if (code == null) return false;
        for (String c : RENEWABLE_REFUSALS) if (c.equals(code)) return true;
        return false;
    }

    static String notice(String key) {
        if (key == null) return null;
        for (String[] n : NOTICES) if (n[0].equals(key)) return n[1];
        return null;
    }

    /** Clé du texte principal pour un état du jeton ; null = jeton prêt (même règle qu'iOS). */
    static String noticeKey(String grantStatus, String refusedCode) {
        if (GRANT_PRESENT.equals(grantStatus)) return null;
        if (GRANT_MISSING.equals(grantStatus)) return "token_missing";
        if (GRANT_EXPIRED.equals(grantStatus)) return "token_expired";
        if (GRANT_REFUSED.equals(grantStatus)) {
            if ("SESSION_REVOKED".equals(refusedCode)) return "session_refused";
            if ("MFA_REQUIRED".equals(refusedCode)) return "mfa_required";
            if ("CGUV_REACCEPTANCE_REQUIRED".equals(refusedCode)) return "terms_required";
            return "token_refused";
        }
        return "token_unreadable";
    }

    /** Code serveur ramené à un jeton de diagnostic sûr (majuscules, chiffres, `_`). */
    static String safeCode(String code) {
        if (code == null) return "NONE";
        StringBuilder b = new StringBuilder();
        for (char ch : code.toUpperCase(java.util.Locale.ROOT).toCharArray()) {
            if ((ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_') b.append(ch);
            if (b.length() >= 32) break;
        }
        return b.length() == 0 ? "NONE" : b.toString();
    }

    /**
     * Catégorie d'une réponse du serveur (mêmes règles qu'iOS et que
     * `classifyDepotStatus`) : seul un 2xx avec accusé vaut « imported ».
     */
    static String outcome(int status, String bodyOutcome, boolean transportError) {
        if (transportError) return "retry";
        if (bodyOutcome != null && (bodyOutcome.equals("imported") || bodyOutcome.equals("refused") || bodyOutcome.equals("auth") || bodyOutcome.equals("retry"))) {
            if (bodyOutcome.equals("imported")) return status >= 200 && status < 300 ? "imported" : "retry";
            return bodyOutcome;
        }
        if (status >= 200 && status < 300) return "retry";
        if (status == 401) return "auth";
        if (status == 408 || status == 429 || status >= 500 || status == 0) return "retry";
        return "refused";
    }
}
