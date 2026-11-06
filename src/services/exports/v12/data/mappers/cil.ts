/**
 * Mappeur CIL (CDC §8, §20 ; contrat `maquettes/cil/README.md`).
 *
 * Blocs B1-B9 : statuts de `evaluateCilReadiness` (même règle que l'écran de
 * préparation et le blocage CIL-RULE-002), B2 calculé depuis le profil CIL
 * (« unknown si absent », non bloquant). Un bloc non applicable porte la
 * justification saisie par l'utilisateur.
 */

import { dot, fmt } from '../../html/components';
import type { CilData, CilBlockStatus } from '../../types';
import type { SourceDocument } from '../source';
import { cilBlockPillStatus } from '@/lib/cil/cil-block-pill';
import { REGULATORY_CATEGORIES } from '@/lib/cil/cil-catalog';
import { cilEnergyEquipments, equipmentEnergyUsageLabel, normalizeEquipmentEnergyUsage } from '@/lib/cil/energy-equipment';
import {
  type MapInput, exportInfo, kc, kcNum, str, humanize, categoryName, categoryLabel, titleLines,
  toDocItem, sortedDocuments, docRef, equipmentSpecs, energyConsumptionLabel,
} from './common';

const TRIGGER_LABELS: Record<string, string> = {
  construction: 'Construction neuve',
  renovation_energetique: 'Rénovation énergétique',
  volontaire: 'Démarche volontaire',
};

const MATERIAL_POSTS: Record<string, string> = {
  toiture: 'Toiture / combles',
  murs_exterieurs: 'Murs extérieurs',
  parois_vitrees: 'Parois vitrées',
  planchers_bas: 'Planchers bas',
};

const NETWORKS: Array<{ code: string; label: string }> = [
  { code: 'RESEAU_EAU', label: 'Eau' },
  { code: 'RESEAU_ELECTRICITE', label: 'Électricité' },
  { code: 'RESEAU_GAZ', label: 'Gaz' },
  { code: 'RESEAU_AERATION', label: 'Aération' },
];

/** Bloc CIL du document retenu (carte dans le bloc, bannière « type · bloc · date »). */
export function cilSection(d: SourceDocument): string {
  if (d.kind === 'PLAN_CONSTRUCTION') return 'B3';
  if (d.kind === 'RESEAU' || d.codes.some((c) => c.startsWith('RESEAU_'))) return 'B4';
  if (d.kind === 'DPE' || d.kind === 'AUDIT_ENERGETIQUE') return 'B8';
  return 'B9';
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;

export function mapCil(m: MapInput): CilData {
  const s = m.source;
  const cil = s.cil;
  const docs = sortedDocuments(m);
  const docItems = docs.map((pd) => toDocItem(pd, cilSection(pd.doc), m));
  const allDocs = s.documents;

  // ── Blocs (B2 calculé ici ; B1, B3-B9 : évaluation partagée avec la génération).
  const readiness = cil?.readiness.blocks ?? [];
  const status = (id: string): CilBlockStatus => (readiness.find((b) => b.id === id)?.status as CilBlockStatus) ?? 'unknown';
  // Lot 112A : pastille du PDF = MÊME règle que l'écran de préparation (statut de bloc + statut
  // granulaire du service commun d'état CIL, `cilStatus`) — « Partiel » quand une partie des données manque.
  const pill = (id: string): CilBlockStatus => {
    const b = readiness.find((x) => x.id === id);
    return b ? cilBlockPillStatus(b.status, b.cilStatus) : 'unknown';
  };
  // Justification d'une résolution « non applicable » : seulement si le bloc
  // l'est EFFECTIVEMENT (lot 75A : une déclaration B6 neutralisée par un
  // équipement énergétique retenu n'apparaît pas au PDF).
  const resolution = (id: string) => (status(id) === 'not_applicable' ? str(cil?.resolutions.find((r) => r.blockId === id)?.justification) : null);
  const p = cil?.profile;
  const b2Complete = !!p && (p.triggerType !== 'inconnu' || !!p.triggerDate || !!p.authorizationType || !!p.voluntaryReason);

  const networkDocs = allDocs.filter((d) => cilSection(d) === 'B4');
  const planDocs = allDocs.filter((d) => d.kind === 'PLAN_CONSTRUCTION');
  const dpeDoc = allDocs.filter((d) => d.kind === 'DPE').sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))[0];
  // B6 (lot 69) : EXACTEMENT les équipements retenus par l'évaluation CIL
  // (règle partagée `classifyCilEnergyEquipment`, données structurées) ;
  // état antérieur sans la liste : même règle réappliquée. Plus de liste de
  // mots sur le nom, plus de repli « tous les équipements ».
  const b6Ids = cil?.readiness.energyEquipmentIds;
  const b6List = b6Ids ? s.equipments.filter((e) => b6Ids.includes(e.id)) : cilEnergyEquipments(s.equipments);
  const b9Docs = allDocs.filter((d) => cilSection(d) === 'B9' && d.kind !== 'AUTRE');
  // Lot 111U : même état granulaire que l'onglet Informations (service commun) — les seules données
  // réellement manquantes d'un bloc partiellement renseigné sont citées dans sa source.
  const cilState = cil?.readiness.state;
  // B7 (lot 111U) : travaux RÉALISÉS de l'état commun (saisis + Opérations prouvées) ; état antérieur : `energy_works`.
  const workList = cilState?.works
    ? cilState.works.map((w) => ({ completedAt: w.date, title: w.title, description: null as string | null, companyName: w.company }))
    : (cil?.works ?? []).map((w) => ({ completedAt: w.completedAt, title: w.title, description: w.description, companyName: w.companyName }));
  // Lot 112A : toute pastille « Partiel » cite ses manques (données du statut de bloc : réglementaires, à défaut toutes).
  const withGaps = (id: string, src: string | null): string | null => {
    const b = cilState?.blocks.find((x) => x.id === id);
    if (!b || pill(id) !== 'partial' || !src) return src;
    const reg = b.items.filter((i) => REGULATORY_CATEGORIES.has(i.category));
    const gaps = (reg.length ? reg : b.items).filter((i) => i.counted && (i.status === 'manquant' || i.status === 'partiel')).map((i) => i.label);
    return gaps.length ? `${src} · à compléter : ${gaps.slice(0, 3).join(', ')}${gaps.length > 3 ? '…' : ''}` : src;
  };

  const blocks: CilData['cil']['blocks'] = [
    { code: 'B1', status: pill('B1'), source: status('B1') === 'complete' ? 'Fiche bien · adresse, type' : null },
    { code: 'B2', status: b2Complete ? 'complete' : 'unknown', source: b2Complete ? 'Profil CIL du bien' : null },
    { code: 'B3', status: pill('B3'), source: planDocs.length ? plural(planDocs.length, 'plan') : null, resolution: resolution('B3') },
    { code: 'B4', status: pill('B4'), source: withGaps('B4', networkDocs.length ? plural(networkDocs.length, 'schéma réseau', 'schémas réseaux') : null), resolution: resolution('B4') },
    { code: 'B5', status: pill('B5'), source: withGaps('B5', cil?.materials.length ? plural(cil.materials.length, 'matériau', 'matériaux') : null), resolution: resolution('B5') },
    { code: 'B6', status: pill('B6'), source: withGaps('B6', b6List.length ? plural(b6List.length, 'équipement') : null), resolution: resolution('B6') },
    { code: 'B7', status: pill('B7'), source: withGaps('B7', workList.length ? plural(workList.length, 'travail', 'travaux') : null), resolution: resolution('B7') },
    { code: 'B8', status: pill('B8'), source: withGaps('B8', dpeDoc ? dot('DPE', dpeDoc.date ? `du ${fmt.date(dpeDoc.date)}` : '') : null) },
    { code: 'B9', status: pill('B9'), source: b9Docs.length ? plural(b9Docs.length, 'document') : null, resolution: resolution('B9') },
  ];

  // ── B4 : réseaux documentés (renvoi d'annexe calculé par le template).
  const selectedIds = new Set(docs.map((pd) => pd.doc.id));
  const networks: NonNullable<CilData['cil']['networks']> = networkDocs.length
    ? NETWORKS.map((n) => {
      const d = networkDocs.find((x) => x.codes.includes(n.code));
      return { network: n.label, element: d ? d.title : null, docId: d && selectedIds.has(d.id) ? docRef(d.id) : null, status: d ? 'complete' : 'unknown' };
    })
    : [];

  // Lot 112F : pose prouvée par une intervention réalisée (facture / attestation) — mention « posé », date de
  // pose et intervention source, comme l'onglet Informations (date manquante = « à compléter », pastille Partiel 112A).
  const opLabel = (id: number | null | undefined) => (id != null ? str(cil?.installationOperations?.[id]?.label) : null);
  const poseMention = (inst: { at: string | null; operationId: number | null }) => dot(
    inst.at ? `Posé le ${fmt.date(inst.at)}` : 'Posé · date de pose à compléter',
    opLabel(inst.operationId) ? `intervention « ${opLabel(inst.operationId)} »` : '',
  );
  // Posés d'abord (du plus récent au plus ancien), puis constats et saisies — même ordre que l'état commun.
  const materialRows = [...(cil?.materials ?? [])].sort((a, b) => Number(!!b.installed) - Number(!!a.installed)
    || String(b.installed?.at ?? '').localeCompare(String(a.installed?.at ?? '')));

  const naNotes = blocks.filter((b) => b.status === 'not_applicable').map((b) => b.resolution).filter(Boolean);

  return {
    export: exportInfo(m, 'CIL'),
    asset: {
      id: s.asset.id,
      family: s.family,
      name: s.asset.name,
      titleLines: titleLines(s),
      categoryLabel: categoryLabel(s),
      typeLabel: dot(categoryName(s), kcNum(s, 'roomCount') != null ? `T${kcNum(s, 'roomCount')}` : ''),
      location: { address1: s.asset.address, postalCode: s.asset.postalCode, city: s.asset.city },
      livingAreaSqm: kcNum(s, 'livingArea'),
      floorLotLabel: dot(kc(s, 'floor'), kc(s, 'lotNumber') ? `lot n° ${kc(s, 'lotNumber')}` : '') || null,
      constructionYear: kcNum(s, 'constructionYear'),
    },
    cil: {
      blocks,
      notApplicableNote: naNotes.length ? naNotes.join(' ; ') : null,
      profile: p ? {
        triggerLabel: TRIGGER_LABELS[p.triggerType ?? ''] ?? null,
        triggerDate: p.triggerDate,
        authorization: humanize(p.authorizationType),
        reason: str(p.voluntaryReason),
      } : undefined,
      networks,
      materials: materialRows.map((mt) => ({
        post: MATERIAL_POSTS[mt.category] ?? humanize(mt.category) ?? mt.category,
        material: dot(humanize(mt.materialNature), mt.brand, mt.reference) || null,
        spec: dot(
          mt.thermalResistanceR != null ? `R = ${fmt.number(mt.thermalResistanceR, 2)} m²·K/W` : '',
          mt.lambda != null ? `λ = ${fmt.number(mt.lambda, 3)}` : '',
          // Lot 111U (1301) : coefficient U, lu tel quel (jamais converti en R).
          mt.uValue != null ? `U = ${fmt.number(mt.uValue, 2)} W/(m²·K)` : '',
          mt.thicknessMm != null ? `${fmt.number(mt.thicknessMm)} mm` : '',
        ) || null,
        // Lot 111U : source OUVRABLE (pièce du dossier), sinon saisie.
        source: (() => {
          const d = mt.documentId ? allDocs.find((x) => x.id === mt.documentId) : undefined;
          const doc = !d ? (mt.documentId ? 'Document importé' : 'Saisie') : dot(d.typeLabel || 'Document', d.date ? `du ${fmt.date(d.date)}` : '') || 'Document importé';
          return mt.installed ? dot(poseMention(mt.installed), doc) : doc;
        })(),
      })),
      equipments: b6List.map((e) => ({
        // Lot 70B : usage DÉCLARÉ dans le tiroir en priorité (même règle que B6).
        usage: (normalizeEquipmentEnergyUsage(e.energyUsage) ? equipmentEnergyUsageLabel(e.energyUsage) : null)
          ?? humanize(e.category) ?? humanize(e.type) ?? 'Équipement',
        equipment: e.name,
        // D-N : caractéristiques de la fiche de l'équipement, dans la cellule existante.
        // Lot 112F : équipement posé — mention et intervention source sous le nom ; date de pose dans la colonne « Installation ».
        specs: (() => {
          const inst = cil?.equipmentInstallations?.[e.id];
          return (inst ? dot(equipmentSpecs(s, e), inst.at ? `posé · intervention « ${opLabel(inst.operationId) ?? 'réalisée'} »` : 'posé · date de pose à compléter') : equipmentSpecs(s, e)) || null;
        })(),
        model: dot(e.brand, e.model) || null,
        installed: cil?.equipmentInstallations?.[e.id]?.at ?? null,
      })),
      works: workList.map((w) => ({
        date: w.completedAt,
        title: w.title,
        description: str(w.description),
        company: str(w.companyName),
      })),
      energy: {
        dpe: kc(s, 'dpeClass'),
        ges: kc(s, 'gesClass'),
        consumption: energyConsumptionLabel(s),
        // Lot 111U : clé canonique `gesEmissions` (registre), unité affichée.
        emissions: (() => {
          const v = kcNum(s, 'gesEmissions') ?? kcNum(s, 'dpeEmissions');
          return v != null ? `${fmt.number(v, 1)} kg CO₂/m²/an` : kc(s, 'gesEmissions') ?? kc(s, 'dpeEmissions');
        })(),
        date: kc(s, 'dpeDate') ?? dpeDoc?.date ?? null,
        // Clé canonique (éditable sur la fiche, D-E) ; repli sur l'ancien alias.
        validUntil: kc(s, 'dpeExpiryDate') ?? kc(s, 'dpeValidUntil'),
      },
    },
    documents: docItems,
    photos: [],
  };
}
