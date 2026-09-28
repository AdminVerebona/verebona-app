/**
 * Mappeurs par dossier : `ExportSource` + plan de sélection + fichiers résolus
 * → contrat de données du template (types.ts).
 */

import type { DossierCode } from '@/services/exports/catalog';
import type { DossierDataMap } from '../../types';
import type { MapInput } from './common';
import { mapCil } from './cil';
import { mapDossierComplet } from './dossier-complet';
import { mapVente } from './vente';
import { mapLocation } from './location';
import { mapSouscription } from './assurance-souscription';
import { mapSinistre } from './assurance-sinistre';

const MAPPERS: { [C in DossierCode]: (m: MapInput) => DossierDataMap[C] } = {
  CIL: mapCil,
  DOSSIER_COMPLET: mapDossierComplet,
  VENTE: mapVente,
  LOCATION: mapLocation,
  ASSURANCE_SOUSCRIPTION: mapSouscription,
  ASSURANCE_SINISTRE: mapSinistre,
};

export function mapDossierData<C extends DossierCode>(code: C, input: MapInput): DossierDataMap[C] {
  return (MAPPERS[code] as (m: MapInput) => DossierDataMap[C])(input);
}

export type { MapInput, GenerationMeta } from './common';
