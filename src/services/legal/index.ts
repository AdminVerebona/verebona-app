/**
 * Documents légaux — CDC 7.
 *
 * Point d'entrée unique. Les routes HTTP (lot L2) et l'administration (lot L3)
 * s'appuient exclusivement sur ces fonctions : aucune n'écrit directement dans
 * les tables `legal_*`.
 */
export {
  DOCUMENT_TYPE_CGVU,
  LegalVersionError,
  createDraft,
  updateDraft,
  publishVersion,
  setCurrentVersion,
  getCurrentVersion,
  getVersionByCode,
  getVersionById,
  listVersions,
  verifyIntegrity,
  isValidVersionCode,
  buildPermalink,
  computeSha256,
} from './legal-versions.service';
export type {
  LegalVersion,
  VersionStatus,
  CreateDraftInput,
  UpdateDraftInput,
  PublishOptions,
  IntegrityIssue,
  IntegrityReport,
} from './legal-versions.service';

export {
  renderLegalVersionHtml,
  buildDownloadFilename,
  escapeHtml,
  formatFrenchDate,
  LEGAL_DOCUMENT_LABEL,
  LEGAL_DOCUMENT_SHORT_LABEL,
} from './legal-html.renderer';

export { recordLegalAudit, listLegalAudit } from './legal-audit.service';
export type { LegalAuditAction, LegalAuditEntry } from './legal-audit.service';

export {
  buildLegalStorageKey,
  isObjectStorageConfigured,
} from './legal-storage';

export {
  recordAcceptance,
  listUserAcceptances,
  getApplicableVersion,
  pseudonymizeAcceptances,
  isAcceptanceContext,
  ACCEPTANCE_CONTEXTS,
} from './legal-acceptances.service';
export type {
  AcceptanceContext,
  RecordAcceptanceInput,
  AcceptanceRecord,
  UserAcceptance,
  ApplicableVersion,
} from './legal-acceptances.service';

export { renderLegalErrorPage } from './legal-error-page';
