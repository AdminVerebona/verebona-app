/**
 * Garde-fou serveur sur la sortie T1 — capacités du compte (Pièces,
 * Équipements).
 *
 * Le prompt reçoit les capacités et un contexte filtré, mais le modèle n'est
 * pas une garantie : après validation du schéma et AVANT vérification des
 * identifiants, projection et persistance, le serveur applique ici la règle.
 *
 * Fait ciblé sur une pièce / un équipement non autorisé :
 *   · REQUALIFIÉ en connaissance générique (cible GENERIC, sans identifiant) ;
 *   · rien n'est perdu : libellé de cible, clé (canonique d'origine en
 *     `rawKey`), sujet, attribut, valeurs, preuve, provenance, confiance et
 *     sémantique d'événement conservés ;
 *   · JAMAIS rabattu sur le bien (« Chaudière — N° de série ABC123 » ne
 *     devient pas `ASSET.serialNumber`) : `canonicalKey` est vidé, la cible
 *     GENERIC n'est acceptée par aucun champ de bien ni par T4.
 * Entités : `entities.rooms` / `entities.equipments` vidées (aucun
 * rattachement proposé à une pièce ou un équipement).
 *
 * Fonction PURE.
 */
import type { AccountCapabilities } from '@/services/account-capabilities.service';
import { isTargetForbidden } from '@/services/account-capabilities.service';
import type { T1AnalyzeDocumentOutput, T1Fact } from './t1-contract';

export interface T1CapabilityCounters {
  /** Faits renvoyés par le modèle sur une cible interdite. */
  forbiddenTargetsReturned: number;
  /** Faits requalifiés en connaissance générique (= renvoyés : aucun n'est perdu). */
  forbiddenTargetsRequalified: number;
  /** Entités pièce / équipement détectées par le modèle et écartées. */
  forbiddenEntitiesDropped: number;
}

/** Requalifie un fait ciblé sur une entité interdite (pure). */
export function requalifyAsGeneric(fact: T1Fact): T1Fact {
  const label = fact.target.rawLabel?.trim() || null;
  return {
    ...fact,
    canonicalKey: null,
    rawKey: fact.rawKey ?? fact.canonicalKey ?? null,
    subject: fact.subject ?? label,
    attribute: fact.attribute ?? fact.canonicalKey ?? fact.label ?? null,
    target: {
      ...fact.target,
      type: 'GENERIC',
      entityId: null,
      rawLabel: label,
      evidenceSignals: [...fact.target.evidenceSignals],
    },
  };
}

export function enforceT1Capabilities(
  out: T1AnalyzeDocumentOutput,
  caps: AccountCapabilities,
): { output: T1AnalyzeDocumentOutput; counters: T1CapabilityCounters } {
  let returned = 0;
  const facts = out.facts.map((f) => {
    if (!isTargetForbidden(f.target.type, caps)) return f;
    returned++;
    return requalifyAsGeneric(f);
  });
  const droppedRooms = caps.rooms ? 0 : out.entities.rooms.length;
  const droppedEquipments = caps.equipments ? 0 : out.entities.equipments.length;
  return {
    output: {
      ...out,
      facts,
      entities: {
        ...out.entities,
        rooms: caps.rooms ? out.entities.rooms : [],
        equipments: caps.equipments ? out.entities.equipments : [],
      },
    },
    counters: {
      forbiddenTargetsReturned: returned,
      forbiddenTargetsRequalified: returned,
      forbiddenEntitiesDropped: droppedRooms + droppedEquipments,
    },
  };
}
