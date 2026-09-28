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
import {
  type MapInput, exportInfo, kc, kcNum, str, humanize, categoryName, categoryLabel, titleLines,
  toDocItem, sortedDocuments, docRef,
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

const ENERGY_EQUIPMENT = /chauff|chaudi|pompe [àa] chaleur|pac\b|ecs|eau chaude|ballon|ventil|vmc|climati|refroidiss|po[eê]le|radiateur|insert|solaire/i;

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
  const resolution = (id: string) => str(cil?.resolutions.find((r) => r.blockId === id)?.justification);
  const p = cil?.profile;
  const b2Complete = !!p && (p.triggerType !== 'inconnu' || !!p.triggerDate || !!p.authorizationType || !!p.voluntaryReason);

  const networkDocs = allDocs.filter((d) => cilSection(d) === 'B4');
  const planDocs = allDocs.filter((d) => d.kind === 'PLAN_CONSTRUCTION');
  const dpeDoc = allDocs.filter((d) => d.kind === 'DPE').sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))[0];
  const energyEquip = s.equipments.filter((e) => ENERGY_EQUIPMENT.test(`${e.name} ${e.type ?? ''} ${e.category ?? ''} ${e.energyType ?? ''}`));
  const b6List = energyEquip.length ? energyEquip : s.equipments;
  const b9Docs = allDocs.filter((d) => cilSection(d) === 'B9' && d.kind !== 'AUTRE');

  const blocks: CilData['cil']['blocks'] = [
    { code: 'B1', status: status('B1'), source: status('B1') === 'complete' ? 'Fiche bien · adresse, type' : null },
    { code: 'B2', status: b2Complete ? 'complete' : 'unknown', source: b2Complete ? 'Profil CIL du bien' : null },
    { code: 'B3', status: status('B3'), source: planDocs.length ? plural(planDocs.length, 'plan') : null, resolution: resolution('B3') },
    { code: 'B4', status: status('B4'), source: networkDocs.length ? plural(networkDocs.length, 'schéma réseau', 'schémas réseaux') : null, resolution: resolution('B4') },
    { code: 'B5', status: status('B5'), source: cil?.materials.length ? plural(cil.materials.length, 'matériau', 'matériaux') : null, resolution: resolution('B5') },
    { code: 'B6', status: status('B6'), source: s.equipments.length ? plural(b6List.length, 'équipement') : null, resolution: resolution('B6') },
    { code: 'B7', status: status('B7'), source: cil?.works.length ? plural(cil.works.length, 'travail', 'travaux') : null, resolution: resolution('B7') },
    { code: 'B8', status: status('B8'), source: dpeDoc ? dot('DPE', dpeDoc.date ? `du ${fmt.date(dpeDoc.date)}` : '') : null },
    { code: 'B9', status: status('B9'), source: b9Docs.length ? plural(b9Docs.length, 'document') : null, resolution: resolution('B9') },
  ];

  // ── B4 : réseaux documentés (renvoi d'annexe calculé par le template).
  const selectedIds = new Set(docs.map((pd) => pd.doc.id));
  const networks: NonNullable<CilData['cil']['networks']> = networkDocs.length
    ? NETWORKS.map((n) => {
      const d = networkDocs.find((x) => x.codes.includes(n.code));
      return { network: n.label, element: d ? d.title : null, docId: d && selectedIds.has(d.id) ? docRef(d.id) : null, status: d ? 'complete' : 'unknown' };
    })
    : [];

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
      materials: (cil?.materials ?? []).map((mt) => ({
        post: MATERIAL_POSTS[mt.category] ?? humanize(mt.category) ?? mt.category,
        material: dot(humanize(mt.materialNature), mt.brand, mt.reference) || null,
        spec: dot(
          mt.thermalResistanceR != null ? `R = ${fmt.number(mt.thermalResistanceR, 2)} m²·K/W` : '',
          mt.lambda != null ? `λ = ${fmt.number(mt.lambda, 3)}` : '',
          mt.thicknessMm != null ? `${fmt.number(mt.thicknessMm)} mm` : '',
        ) || null,
        source: mt.documentId ? 'Document importé' : 'Saisie',
      })),
      equipments: b6List.map((e) => ({
        usage: humanize(e.category) ?? humanize(e.type) ?? 'Équipement',
        equipment: e.name,
        model: dot(e.brand, e.model) || null,
        installed: null,
      })),
      works: (cil?.works ?? []).map((w) => ({
        date: w.completedAt,
        title: w.title,
        description: str(w.description),
        company: str(w.companyName),
      })),
      energy: {
        dpe: kc(s, 'dpeClass'),
        ges: kc(s, 'gesClass'),
        consumption: kc(s, 'energyConsumption') ?? kc(s, 'dpeConsumption'),
        emissions: kc(s, 'gesEmissions') ?? kc(s, 'dpeEmissions'),
        date: kc(s, 'dpeDate') ?? dpeDoc?.date ?? null,
        validUntil: kc(s, 'dpeValidUntil'),
      },
    },
    documents: docItems,
    photos: [],
  };
}
