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
