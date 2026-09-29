/**
 * Mappeur « Assurance — souscription / mise à jour » (CDC §12 ;
 * `maquettes/assurance-souscription/README.md`).
 *
 * RULE-001 : objectif recommandé, non bloquant (bloc masqué s'il manque).
 * Valeurs : prix d'achat de la fiche (justifié par la facture d'acquisition
 * si elle est retenue), valeur à assurer et montant souhaité SAISIS — jamais
 * d'estimation (« Verebona ne procède à aucune estimation », page finale).
 * RULE-004 : protections dans une section décochable (`protections`) :
 * liste détaillée de la fiche (`insurance.protectionItems`, titre + précision),
 * sinon texte libre ligne à ligne (protections, éléments particuliers).
 * Accessoires et éléments à assurer (`insurance.insuredItems`) : valeur
 * DÉCLARÉE, justificatif cité seulement s'il est retenu dans le dossier.
 * Le design est maquetté sur un objet : pour un bien immobilier ou un
 * véhicule, `asset.infoRows` porte les lignes de la famille.
 */

import { dot, fmt } from '../../html/components';
import type { SouscriptionData } from '../../types';
import { INSURANCE_OBJECTIVE_OPTIONS } from '@/lib/assets/additional-infos';
import {
  type MapInput, exportInfo, kc, str, info, infoCents, infoList, cellIds, textLines, humanize, categoryName, categoryLabel, titleLines,
  conditionLabel, usageLabel, familyInfoRows, toDocItem, sortedDocuments, toPhotoItem, plannedPhotos, selectedEvents,
  sectionOn, docRef,
} from './common';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;

export function mapSouscription(m: MapInput): SouscriptionData {
  const s = m.source;
  const ins = s.additionalInfo.insurance;
  const objectiveCode = info(ins, 'insuranceObjective');
  const objectiveLabel = objectiveCode ? INSURANCE_OBJECTIVE_OPTIONS.find((o) => o.value === objectiveCode)?.label ?? humanize(objectiveCode) : null;
  const objectiveDetail = info(ins, 'objectiveDetail');
  const valueToInsure = infoCents(ins, 'valueToInsureCents');
  const desired = infoCents(ins, 'desiredInsuredAmountCents');

  const docs = sortedDocuments(m);
  // Justificatif du prix d'achat : facture retenue la plus ancienne (acquisition).
  const acquisitionInvoice = docs.find((pd) => pd.doc.kind === 'FACTURE');
  const items: NonNullable<SouscriptionData['items']> = [];
  if (s.asset.purchasePriceCents != null) {
    items.push({
      id: 'main', kind: 'main', label: s.asset.name, valueCents: s.asset.purchasePriceCents,
      docId: acquisitionInvoice ? docRef(acquisitionInvoice.doc.id) : null,
      proofLabel: acquisitionInvoice ? 'Facture' : 'Déclaratif · sans facture',
      proofDate: acquisitionInvoice?.doc.date ?? s.asset.purchaseDate,
      selected: true,
    });
  }
  // Accessoires et éléments déclarés (fiche) : justificatif renvoyé vers son annexe s'il est retenu.
  const plannedDocs = new Map(docs.map((pd) => [pd.doc.id, pd.doc]));
  infoList(ins, 'insuredItems').forEach((it, i) => {
    const label = str(it.label);
    if (!label) return;
    const proof = cellIds(it.documentId).map((id) => plannedDocs.get(id)).find(Boolean);
    items.push({
      id: `acc-${str(it.id) ?? i + 1}`, kind: 'accessory', label,
      valueCents: typeof it.valueCents === 'number' ? it.valueCents : null,
      docId: proof ? docRef(proof.id) : null,
      proofLabel: proof ? (proof.kind === 'FACTURE' ? 'Facture' : proof.typeLabel || 'Justificatif') : 'Déclaratif · sans facture',
      proofDate: proof?.date ?? null,
      selected: true,
    });
  });
  const accessoryCount = items.filter((x) => x.kind === 'accessory').length;
  if (valueToInsure != null) {
    items.push({ id: 'declared', kind: 'declared', label: 'Valeur à assurer déclarée', valueCents: valueToInsure, proofLabel: "Déclaré par l'assuré", selected: true });
  }

  const detailed = infoList(ins, 'protectionItems')
    .map((p, i) => ({ id: `pr-${str(p.id) ?? i + 1}`, title: str(p.title) ?? '', text: str(p.text), selected: true }))
    .filter((p) => p.title);
  const protections = sectionOn(m, 'protections')
    ? detailed.length
      ? detailed
      : [...textLines(ins?.protections), ...textLines(ins?.specialItems)].map((t, i) => ({ id: `pr${i + 1}`, title: t, selected: true }))
    : [];
  const condition = sectionOn(m, 'condition')
    ? selectedEvents(m).map((e) => ({ id: e.key, date: e.date, title: e.title, aside: str(e.provider), selected: true }))
    : [];
  const photos = plannedPhotos(m);

  const proofCount = docs.filter((pd) => pd.mode === 'PDF').length;
  const summary: NonNullable<SouscriptionData['summary']> = [
    { label: 'Bien', value: dot(s.asset.name, categoryName(s), s.asset.purchaseDate ? `acheté le ${fmt.date(s.asset.purchaseDate)}` : '') },
    { label: 'Objectif', value: objectiveLabel },
    {
      label: 'Valeur',
      value: dot(
        s.asset.purchasePriceCents != null ? `Prix d'achat ${fmt.money(s.asset.purchasePriceCents)}` : '',
        valueToInsure != null ? `valeur à assurer déclarée ${fmt.money(valueToInsure)}` : '',
      ) || null,
    },
    { label: 'État', value: conditionLabel(s) },
    { label: 'Protections', value: protections.length ? protections.slice(0, 3).map((p) => p.title).join(', ') : null },
    {
      label: 'Justificatifs',
      value: dot(proofCount ? plural(proofCount, 'pièce jointe', 'pièces jointes') : '', photos.length ? plural(photos.length, 'photo') : '') || null,
      strong: false,
    },
  ];

  const insurer = kc(s, 'insurer');
  const contractNo = kc(s, 'insuranceContractNumber');

  return {
    export: exportInfo(m, 'ASSURANCE_SOUSCRIPTION'),
    asset: {
      id: s.asset.id,
      family: s.family,
      name: s.asset.name,
      shortName: s.asset.name,
      titleLines: titleLines(s),
      categoryLabel: categoryLabel(s),
      ...(s.family === 'OBJET'
        ? {
          fields: {
            categoryLabel: categoryLabel(s),
            serialNumber: kc(s, 'serialNumber'), // masqué au rendu (design)
            brand: kc(s, 'brand'),
            model: kc(s, 'modelName'),
            purchaseDate: s.asset.purchaseDate,
            purchaseCondition: null,
            dimensions: kc(s, 'dimensions') ?? s.asset.dimensions,
            seller: s.asset.purchaseLocation,
            usageLabel: usageLabel(s),
            storageLabel: kc(s, 'storageLocation'),
            conditionLabel: conditionLabel(s),
            transportLabel: null,
          },
        }
        : { infoRows: [...familyInfoRows(s), { label: 'Usage', value: usageLabel(s) }] }),
    },
    insurance: {
      objective: objectiveLabel ? { code: objectiveCode, headline: objectiveLabel, detail: objectiveDetail ? (/[.!?]$/.test(objectiveDetail) ? objectiveDetail : `${objectiveDetail}.`) : null } : null,
      desiredInsuredAmountCents: desired,
      insuredName: m.meta.preparedBy,
      contractLabel: dot(insurer, contractNo ? `n° ${contractNo}` : '') || null,
      accessoriesLabel: accessoryCount ? plural(accessoryCount, 'élément déclaré', 'éléments déclarés') : null,
    },
    summary,
    items,
    protections,
    condition,
    documents: docs.map((pd) => toDocItem(pd, 'proofs', m)),
    photos: photos.map((pp) => toPhotoItem(pp, m)),
  };
}
