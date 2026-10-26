/**
 * Documents légaux — CDC 7.
 *
 * Point d'entrée unique. Les routes HTTP (lot L2) et l'administration (lot L3)
 * s'appuient exclusivement sur ces fonctions : aucune n'écrit directement dans
 * les tables `legal_*`.
 */
export {
  LegalVersionError,
  createDraft,
  publishVersion,
  setCurrentVersion,
  getCurrentVersion,
  getVersionByCode,
  verifyIntegrity,
  isValidVersionCode,
} from './legal-versions.service';

export { buildDownloadFilename, LEGAL_DOCUMENT_LABEL } from './legal-html.renderer';
