/**
 * Évaluation PURE de l'état CIL (lot 111U) — une seule projection pour
 * l'onglet Informations, la préparation et le blocage (`evaluateCilReadiness`),
 * le mappeur PDF et le diagnostic BO. Entrées chargées par `load.ts`.
 *
 * Règles (matrice `docs/cil/matrice-cil.md`, catalogue `lib/cil/cil-catalog.ts`) :
 *   · une donnée prouvée en base est RENSEIGNÉE avec sa source ouvrable ;
 *   · une donnée incomplète est PARTIELLE et liste ses seuls manques ;
 *   · une installation dont la présence n'est pas connue (gaz, climatisation,
 *     production d'énergie renouvelable) reste À CONFIRMER, hors dénominateur :
 *     jamais « non applicable » par déduction (un chauffage électrique ne
 *     prouve pas l'absence de gaz) ;
 *   · « Non applicable » = déclaration de l'utilisateur (bloc ou donnée
 *     autorisée) ou règle fondée sur le profil CIL validé ;
 *   · le DPE remplit la ligne « DPE disponible », pas les autres obligations ;
 *   · une recommandation de travaux n'est jamais une réalisation (B7).
 */
import {
  CIL_BLOCK_IDS, CIL_BLOCK_LABELS, CIL_CATALOG, REGULATORY_CATEGORIES, aggregateCilStatus, cilProgress,
  type CilBlockId, type CilCatalogItem, type CilItemStatus,
} from '@/lib/cil/cil-catalog';
import { classifyCilEnergyEquipment, type CilEnergyEquipmentInput, type CilEnergyUsage } from '@/lib/cil/energy-equipment';
import { CIL_STATE_VERSION, type CilState, type CilStateBlock, type CilStateItem, type CilStateWork, type CilValue, type CilValueSource } from '@/lib/cil/cil-state-types';
import { documentKind, type DocKind } from '@/services/exports/v12/data/documents';

// ── Entrées ─────────────────────────────────────────────────────────────────

export interface CilDocInput {
  id: number;
  title: string;
  date: string | null;
  documentType: string | null;
  documentTypeCode: string | null;
  retainedFunctionCode: string | null;
  cilRubricCodes: string[] | null;
  planState: string | null;
}

export interface CilFieldInput { value: unknown; origin: string | null }

export interface CilMaterialInput {
  id: number;
  category: string;
  materialNature: string | null;
  brand: string | null;
  reference: string | null;
  thermalResistanceR: number | null;
  lambda: number | null;
  thicknessMm: number | null;
  surfaceSqm: number | null;
  origin: string;
  installationState: string | null;
  sourceFileId: number | null;
  documentId: number | null;
  /** Lot 111U (1301) : coefficient U, W/(m²·K) ; jamais converti en R. */
  uValue?: number | null;
}

export interface CilEquipmentInput extends CilEnergyEquipmentInput {
  id: number;
  name: string;
  brand: string | null;
  model: string | null;
  powerKw: number | null;
  fieldOrigins: Record<string, string>;
}

export interface CilWorkInput { id: number; title: string; category: string; completedAt: string | null; companyName: string | null }

export interface CilJournalInput { projectionKey: string; status: string; reason: string | null; sourceFileIds: number[]; targetId: number | null }

export interface CilStateInput {
  asset: { id: number; address: string | null; postalCode: string | null; city: string | null; subtype: string | null };
  fields: Record<string, CilFieldInput>;
  /** Preuve documentaire principale d'un champ canonique (field_evidence active). */
  fieldSources: Record<string, { fileId: number; page: number | null }>;
  profile: { triggerType: string; triggerDate: string | null; authorizationType?: string | null; origin?: string; sourceFileId?: number | null } | null;
  /** B7 : Opérations d'intervention qualifiées « travaux énergétiques réalisés et prouvés » (journal de projection). */
  opWorks?: Array<{ operationId: number; title: string | null; provider: string | null; realizedDate: string | null; categories: string[]; fileIds: number[] }>;
  resolutions: Array<{ blockId: string; resolution: string; justification: string | null }>;
  documents: CilDocInput[];
  materials: CilMaterialInput[];
  equipments: CilEquipmentInput[];
  works: CilWorkInput[];
  journal: CilJournalInput[];
  now?: string;
}

// ── Documents ───────────────────────────────────────────────────────────────

export interface ClassifiedDoc extends CilDocInput { kind: DocKind; codes: string[] }

export function classifyCilDocs(docs: readonly CilDocInput[]): ClassifiedDoc[] {
  return docs.map((d) => ({
    ...d,
    kind: documentKind({ id: d.id, documentType: d.documentType, documentTypeCode: d.documentTypeCode, retainedFunctionCode: d.retainedFunctionCode, cilRubricCodes: d.cilRubricCodes }),
    codes: [d.documentType, d.retainedFunctionCode, d.documentTypeCode, ...(d.cilRubricCodes ?? [])]
      .filter((c): c is string => typeof c === 'string' && c.length > 0).map((c) => c.toUpperCase()),
  }));
}

/** Codes V2 équivalents aux rubriques V1 (référentiel `documents.ts`). */
const V2_EQUIV: Record<string, string[]> = {
  RE2020: ['RE2020_CERTIFICATE'],
  LABEL_CERTIFICATION: ['BUILDING_LABEL_CERTIFICATE'],
  PLAN_CONSTRUCTION: ['WORKS_PLAN', 'ASSET_REFERENCE_PLAN'],
};

const hasCode = (d: ClassifiedDoc, code: string) => d.codes.includes(code) || (V2_EQUIV[code] ?? []).some((c) => d.codes.includes(c));

const fmtDate = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
};

function docSource(d: { id: number; title: string; date: string | null }, page: number | null = null): CilValueSource {
  const date = fmtDate(d.date);
  return { kind: 'document', fileId: d.id, title: d.title, date: d.date, page, label: date ? `${d.title} · ${date}` : d.title };
}

function originSource(origin: string | null): CilValueSource {
  if (origin === 'ADMIN') return { kind: 'admin', label: 'Saisie de l’équipe Verebona' };
  if (!origin || origin === 'USER' || origin === 'IMPORT') return { kind: 'user', label: 'Saisie' };
  return { kind: 'automatic', label: 'Analyse des documents' };
}

const filled = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== '';
const fmtNum = (n: number, d = 2) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: d }).format(n);

// ── Évaluation ──────────────────────────────────────────────────────────────

const TRIGGER_LABELS: Record<string, string> = {
  construction: 'Construction neuve', renovation_energetique: 'Rénovation énergétique', volontaire: 'Démarche volontaire',
};

const ENUM_VALUE_LABEL = (key: string, v: unknown): string => {
  if (key === 'energyConsumption') return `${fmtNum(Number(v), 0)} kWh/m²/an`;
  if (key === 'gesEmissions') return `${fmtNum(Number(v), 1)} kg CO₂/m²/an`;
  if (key === 'livingArea') return `${fmtNum(Number(v), 2)} m²`;
  if (key === 'dpeDate' || key === 'dpeExpiryDate') return fmtDate(String(v)) ?? String(v);
  return String(v);
};

const WORK_LABELS: Record<string, string> = {
  isolation_toiture: 'isolation de la toiture', isolation_murs: 'isolation des murs', isolation_parois: 'menuiseries / vitrages',
  isolation_planchers: 'isolation des planchers', chauffage: 'chauffage', refroidissement: 'climatisation', ecs: 'eau chaude sanitaire',
  ventilation: 'ventilation', enr: 'énergie renouvelable',
};

const USAGE_OF_ITEM: Record<string, CilEnergyUsage> = {
  'B6.chauffage': 'chauffage', 'B6.ecs': 'ecs', 'B6.ventilation': 'ventilation', 'B6.refroidissement': 'refroidissement', 'B6.enr': 'enr',
};

const MATERIAL_ATTR_LABELS = {
  nature: 'Matériau / composition', perf: 'Performance thermique (R, U, épaisseur ou λ)',
};

export function evaluateCilState(input: CilStateInput): CilState {
  const docs = classifyCilDocs(input.documents);
  const docById = new Map(docs.map((d) => [d.id, d]));
  const cited = new Map<number, { id: number; title: string; date: string | null; kind: string }>();
  const cite = (d: ClassifiedDoc | undefined) => { if (d) cited.set(d.id, { id: d.id, title: d.title, date: d.date, kind: d.kind }); };

  const resBlock = new Map<string, { resolution: string; justification: string | null }>();
  for (const r of input.resolutions) resBlock.set(r.blockId, { resolution: r.resolution, justification: r.justification });
  const profile = input.profile;
  const trigger = profile?.triggerType ?? 'inconnu';
  const journalByKey = new Map(input.journal.map((j) => [j.projectionKey, j]));

  const dpeDocs = docs.filter((d) => d.kind === 'DPE').sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
  const hasDpe = dpeDocs.length > 0;

  // B6 : classification partagée (aucun repli « tous les équipements »).
  const classified = input.equipments.map((e) => ({ e, c: classifyCilEnergyEquipment(e) }));
  const energyEquipmentIds = classified.filter((x) => x.c !== null).map((x) => x.e.id);

  const gasKnown = input.equipments.some((e) => /\bgaz\b/i.test(`${e.energyType ?? ''}`))
    || ['mainEnergy', 'heatingType'].some((k) => /\bgaz\b/i.test(String(input.fields[k]?.value ?? '')));

  const fieldValue = (key: string, label: string): CilValue | null => {
    const f = input.fields[key];
    if (!f || !filled(f.value)) return null;
    const src = input.fieldSources[key];
    const d = src ? docById.get(src.fileId) : undefined;
    if (d) cite(d);
    return { label, value: ENUM_VALUE_LABEL(key, f.value), source: d && f.origin !== 'USER' && f.origin !== 'ADMIN' ? docSource(d, src?.page ?? null) : originSource(f.origin) };
  };

  const base = (c: CilCatalogItem): CilStateItem => ({
    id: c.id, block: c.block, label: c.label, category: c.category, status: 'manquant', counted: true, values: [], missing: [],
    reason: null, notApplicable: null, naAllowed: c.naAllowed, blocking: !!c.blocking,
    action: { kind: c.action, label: c.actionLabel, target: c.target ?? null },
  });

  // B7 : travaux saisis (`energy_works`) + Opérations réalisées et prouvées (une seule fois chacune).
  const allWorks: CilStateWork[] = [
    ...input.works.map((w) => ({ kind: 'energy_works' as const, id: w.id, title: w.title, date: w.completedAt, company: w.companyName, categories: [w.category], fileIds: [] as number[] })),
    ...(input.opWorks ?? []).map((o) => ({
      kind: 'operation' as const, id: o.operationId, title: o.title ?? `Travaux : ${o.categories.map((x) => WORK_LABELS[x] ?? x).join(', ')}`,
      date: o.realizedDate, company: o.provider, categories: o.categories, fileIds: o.fileIds,
    })),
  ];

  const items: CilStateItem[] = [];
  const notices = new Map<CilBlockId, string>();

  for (const c of CIL_CATALOG) {
    const it = base(c);
    const set = (status: CilItemStatus, o: Partial<CilStateItem> = {}) => Object.assign(it, { status }, o);

    switch (c.id) {
      case 'B1.address': case 'B1.postalCode': case 'B1.city': {
        const v = c.id === 'B1.address' ? input.asset.address : c.id === 'B1.postalCode' ? input.asset.postalCode : input.asset.city;
        if (filled(v)) set('renseigne', { values: [{ label: c.label, value: String(v), source: { kind: 'user', label: 'Fiche du bien' } }] });
        else set('manquant', { missing: [c.label] });
        break;
      }
      case 'B1.nature':
        if (filled(input.asset.subtype)) set('renseigne', { values: [{ label: c.label, value: String(input.asset.subtype), source: { kind: 'user', label: 'Fiche du bien' } }] });
        else set('manquant', { missing: [c.label] });
        break;
      case 'B1.livingArea': case 'B1.constructionYear': {
        const v = fieldValue(c.id.slice(3), c.label);
        if (v) set('renseigne', { values: [v] }); else set('manquant', { missing: [c.label] });
        break;
      }
      case 'B2.trigger':
        if (profile && trigger !== 'inconnu') {
          const d = profile.origin === 'DOCUMENT' ? docById.get(profile.sourceFileId ?? -1) : undefined;
          if (d) cite(d);
          set(profile.triggerDate ? 'renseigne' : 'partiel', {
            values: [{ label: c.label, value: [TRIGGER_LABELS[trigger] ?? trigger, fmtDate(profile.triggerDate)].filter(Boolean).join(' · '), source: d ? docSource(d) : { kind: 'user', label: 'Profil du carnet' } }],
            missing: profile.triggerDate ? [] : ['Date de constitution'],
          });
        } else {
          const pj = journalByKey.get('cil:profile');
          set(pj?.status === 'CONFLICT' ? 'a_confirmer' : 'manquant', {
            missing: [c.label],
            reason: pj?.status === 'CONFLICT' ? 'Les documents indiquent des contextes différents : précisez-le.'
              : profile?.authorizationType ? `Autorisation connue (${profile.authorizationType.replace(/_/g, ' ')}) : précisez le motif de constitution.` : null,
          });
        }
        break;
      case 'B3.plans': {
        const plans = docs.filter((d) => d.kind === 'PLAN_CONSTRUCTION' || hasCode(d, 'PLAN_CONSTRUCTION'));
        plans.forEach(cite);
        if (plans.length) set('renseigne', { values: plans.map((d) => ({ label: 'Plan', value: d.title, source: docSource(d) })) });
        else set('manquant', { missing: [c.label] });
        break;
      }
      case 'B3.planState': {
        const plans = docs.filter((d) => d.kind === 'PLAN_CONSTRUCTION' || hasCode(d, 'PLAN_CONSTRUCTION'));
        const withState = plans.filter((d) => d.planState === 'conception' || d.planState === 'execution');
        if (!plans.length) set('manquant', { missing: ['Aucun plan'] });
        else if (withState.length === plans.length) set('renseigne', { values: withState.map((d) => ({ label: d.title, value: d.planState === 'execution' ? 'Exécution' : 'Conception', source: docSource(d) })) });
        else set('partiel', { missing: plans.filter((d) => !withState.includes(d)).map((d) => `État non précisé : ${d.title}`) });
        break;
      }
      case 'B4.eau': case 'B4.electricite': case 'B4.gaz': case 'B4.aeration': {
        const code = `RESEAU_${c.id.slice(3).toUpperCase()}`;
        const found = docs.filter((d) => d.codes.includes(code));
        found.forEach(cite);
        if (found.length) set('renseigne', { values: found.map((d) => ({ label: 'Plan / schéma', value: d.title, source: docSource(d) })) });
        else if (c.applicability === 'IF_PRESENT' && !gasKnown) {
          set('a_confirmer', { counted: false, reason: 'Présence d’une installation de gaz non connue : ajoutez son plan ou déclarez-la non applicable.' });
        } else set('manquant', { missing: [c.label] });
        break;
      }
      case 'B5.toiture': case 'B5.murs_exterieurs': case 'B5.parois_vitrees': case 'B5.planchers_bas': {
        const post = c.id.slice(3);
        const rows = input.materials.filter((m) => m.category === post);
        const j = journalByKey.get(`cil:mat:${post}`);
        if (!rows.length) {
          if (j && (j.status === 'AMBIGUOUS' || j.status === 'CONFLICT')) {
            set('a_confirmer', { counted: true, reason: j.status === 'CONFLICT' ? 'Les documents se contredisent sur ce poste : vérifiez et complétez.' : 'Plusieurs descriptions dans un même document : vérifiez et complétez.' });
            j.sourceFileIds.forEach((id) => cite(docById.get(id)));
          } else set('manquant', { missing: [c.label] });
          break;
        }
        const values: CilValue[] = [];
        let hasNature = false; let hasPerf = false;
        for (const m of rows) {
          const d = m.origin === 'DOCUMENT' ? docById.get(m.sourceFileId ?? m.documentId ?? -1) : undefined;
          if (d) cite(d);
          const src: CilValueSource = d ? docSource(d) : originSource(m.origin);
          const spec = [
            m.thermalResistanceR != null ? `R = ${fmtNum(m.thermalResistanceR)} m²·K/W` : '',
            m.thicknessMm != null ? `${fmtNum(m.thicknessMm, 0)} mm` : '',
            m.lambda != null ? `λ = ${fmtNum(m.lambda, 3)} W/(m·K)` : '',
            m.uValue != null ? `U = ${fmtNum(m.uValue)} W/(m²·K)` : '',
            m.surfaceSqm != null ? `${fmtNum(m.surfaceSqm)} m²` : '',
          ].filter(Boolean).join(' · ');
          if (m.materialNature) hasNature = true;
          if (m.thermalResistanceR != null || m.thicknessMm != null || m.lambda != null || m.uValue != null) hasPerf = true;
          const nature = [m.materialNature, m.brand, m.reference].filter(Boolean).join(' · ');
          const state = m.installationState === 'constate' ? ' (décrit par un diagnostic)' : m.installationState === 'prevu' ? ' (prévu)' : '';
          values.push({ label: `${nature || 'Matériau'}${state}`, value: spec || '—', source: src });
        }
        const missing = [!hasNature ? MATERIAL_ATTR_LABELS.nature : '', !hasPerf ? MATERIAL_ATTR_LABELS.perf : ''].filter(Boolean)
          .map((m) => `${c.label} : ${m.charAt(0).toLowerCase()}${m.slice(1)}`);
        // Valeur DOCUMENT contredite par une autre source de même date : conservée, mais à confirmer.
        if (rows.every((m) => m.origin === 'DOCUMENT') && j && (j.status === 'CONFLICT' || j.status === 'AMBIGUOUS')) {
          j.sourceFileIds.forEach((id) => cite(docById.get(id)));
          set('a_confirmer', { values, missing, reason: 'Les documents se contredisent sur ce poste : la valeur affichée reste à confirmer.' });
          break;
        }
        set(missing.length ? 'partiel' : 'renseigne', { values, missing,
          reason: j?.status === 'CONFLICT' || (j?.status === 'PROTECTED' && j.reason === 'USER_VALUE_DIFFERS') ? 'Un document décrit ce poste autrement que votre saisie : votre saisie est conservée.' : null });
        break;
      }
      case 'B6.chauffage': case 'B6.ecs': case 'B6.ventilation': case 'B6.refroidissement': case 'B6.enr': {
        const usage = USAGE_OF_ITEM[c.id];
        const list = classified.filter((x) => x.c?.usage === usage).map((x) => x.e);
        const j = journalByKey.get(`cil:eq:${usage}`);
        const jDoc = j ? docById.get(j.sourceFileIds[0] ?? -1) : undefined;
        if (!list.length) {
          if (j && (j.status === 'AMBIGUOUS' || j.status === 'CONFLICT')) {
            set('a_confirmer', { reason: 'Plusieurs équipements possibles pour cet usage : précisez lequel est concerné.' });
            cite(jDoc);
          } else if (c.applicability === 'IF_PRESENT') {
            set('a_confirmer', { counted: false, reason: 'Présence non connue : ajoutez l’équipement ou déclarez-le non applicable.' });
          } else set('manquant', { missing: [`Équipement de ${c.label.toLowerCase()}`] });
          break;
        }
        const values: CilValue[] = [];
        const missing: string[] = [];
        for (const e of list) {
          const fromDoc = Object.values(e.fieldOrigins ?? {}).includes('DOCUMENT') || (j?.targetId === e.id && j.status !== 'PROTECTED');
          if (fromDoc) cite(jDoc);
          const src: CilValueSource = fromDoc && jDoc ? docSource(jDoc) : { kind: 'user', label: 'Fiche de l’équipement' };
          const spec = [e.type, e.energyType ? `énergie : ${e.energyType}` : '', e.powerKw != null ? `${fmtNum(e.powerKw)} kW` : '', [e.brand, e.model].filter(Boolean).join(' ')]
            .filter(Boolean).join(' · ');
          values.push({ label: e.name, value: spec || '—', source: src });
          if ((usage === 'chauffage' || usage === 'ecs') && !filled(e.energyType)) missing.push(`Énergie utilisée : ${e.name}`);
        }
        set(missing.length ? 'partiel' : 'renseigne', { values, missing });
        break;
      }
      case 'B7.works': {
        const rec = input.journal.filter((x) => x.status === 'RECOMMENDATION_ONLY');
        const recNote = rec.length ? 'Les recommandations de travaux des diagnostics ne sont pas des travaux réalisés : elles ne figurent pas ici.' : null;
        const envisages = input.journal.filter((x) => x.projectionKey.startsWith('cil:work:') && x.status === 'ABSTAINED');
        const note = [recNote, envisages.length ? `${envisages.length} intervention(s) énergétique(s) envisagée(s) ou sans facture / attestation : non comptée(s) comme réalisée(s).` : null].filter(Boolean).join(' ') || null;
        if (allWorks.length) {
          const sansDate = allWorks.filter((w) => !w.date);
          for (const w of allWorks) w.fileIds.forEach((id) => cite(docById.get(id)));
          set(sansDate.length ? 'partiel' : 'renseigne', {
            values: allWorks.map((w) => {
              const d = docById.get(w.fileIds[0] ?? -1);
              return { label: w.title, value: [fmtDate(w.date) ?? 'date manquante', w.company].filter(Boolean).join(' · '), source: d ? docSource(d) : { kind: 'user', label: 'Travaux enregistrés' } };
            }),
            missing: sansDate.map((w) => `Date de réalisation : ${w.title}`), reason: note,
          });
        } else if (trigger === 'renovation_energetique') set('manquant', { missing: [c.label], reason: note });
        else set('a_confirmer', { counted: false, reason: note ?? 'Aucun travaux enregistré : ajoutez ceux réalisés, ou déclarez ce bloc non applicable.' });
        break;
      }
      case 'B8.dpeDocument':
        dpeDocs.forEach(cite);
        if (hasDpe) {
          set('renseigne', { values: dpeDocs.map((d) => ({ label: 'DPE', value: d.title, source: docSource(d) })) });
          if (dpeDocs.length > 1) notices.set('B8', `${dpeDocs.length} DPE sont rattachés : le plus récent (${fmtDate(dpeDocs[0].date) ?? 'date inconnue'}) fait foi ; les autres restent consultables.`);
        } else set('manquant', { missing: [c.label] });
        break;
      case 'B8.dpeClass': case 'B8.gesClass': case 'B8.dpeDate': case 'B8.energyConsumption': case 'B8.gesEmissions':
      case 'B8.dpeAdemeNumber': case 'B8.dpeExpiryDate': {
        const v = fieldValue(c.id.slice(3), c.label);
        if (v) set('renseigne', { values: [v] });
        else if (!hasDpe) set('manquant', { counted: false, reason: 'Disponible avec le DPE.' });
        else set('manquant', { missing: [c.label], reason: c.id === 'B8.dpeExpiryDate' ? 'Jamais déduite : seulement si le document l’indique.' : null });
        break;
      }
      case 'B8.re2020': {
        const found = docs.filter((d) => hasCode(d, 'RE2020'));
        found.forEach(cite);
        if (found.length) set('renseigne', { values: found.map((d) => ({ label: 'Attestation', value: d.title, source: docSource(d) })) });
        else if (trigger === 'construction') set('manquant', { missing: [c.label] });
        else if (trigger === 'renovation_energetique' || trigger === 'volontaire') {
          set('non_applicable', { counted: false, notApplicable: { by: 'rule', justification: `Propre aux constructions neuves (profil : ${TRIGGER_LABELS[trigger]}).` } });
        } else set('a_confirmer', { counted: false, reason: 'Dépend du contexte de constitution du carnet (B2).' });
        break;
      }
      case 'B8.audit': case 'B8.label': {
        const found = docs.filter((d) => (c.id === 'B8.audit' ? d.kind === 'AUDIT_ENERGETIQUE' : hasCode(d, 'LABEL_CERTIFICATION')));
        found.forEach(cite);
        if (found.length) set('renseigne', { values: found.map((d) => ({ label: c.label, value: d.title, source: docSource(d) })) });
        else set('manquant', { missing: [c.label] });
        break;
      }
      case 'B9.annexes': {
        const annexes = docs.filter((d) => !['PLAN_CONSTRUCTION', 'RESEAU', 'DPE', 'AUDIT_ENERGETIQUE', 'AUTRE', 'PHOTO'].includes(d.kind));
        annexes.forEach(cite);
        if (annexes.length) set('renseigne', { values: annexes.slice(0, 50).map((d) => ({ label: d.title, value: d.date ? fmtDate(d.date) ?? '' : '', source: docSource(d) })) });
        else set('manquant', { missing: [c.label] });
        break;
      }
      default: break;
    }

    // « Non applicable » : déclaration de l'utilisateur sur la donnée (autorisée) ou sur son bloc.
    const own = c.naAllowed ? resBlock.get(c.id) : undefined;
    const block = resBlock.get(c.block);
    const na = own?.resolution === 'not_applicable' ? own : block?.resolution === 'not_applicable' ? block : undefined;
    if (na && it.status !== 'renseigne' && it.status !== 'partiel' && (c.naAllowed || (block === na && !c.blocking))) {
      // B6 : un équipement énergétique retenu neutralise la déclaration de bloc (lot 75A) — pris en compte ci-dessus (donnée renseignée).
      it.status = 'non_applicable';
      it.counted = false;
      it.missing = [];
      it.notApplicable = { by: 'user', justification: na.justification };
      it.reason = null;
    }
    items.push(it);
  }

  // B6 : déclaration de bloc contredite par des équipements énergétiques (lot 75A).
  if (resBlock.get('B6')?.resolution === 'not_applicable' && energyEquipmentIds.length > 0) {
    notices.set('B6', 'Une déclaration « Non applicable » existe pour ce bloc, mais des équipements à incidence énergétique sont identifiés : elle est conservée et ne s’applique plus aux usages couverts par ces équipements.');
  }

  const blocks: CilStateBlock[] = CIL_BLOCK_IDS.map((id) => {
    const its = items.filter((i) => i.block === id);
    const reg = its.filter((i) => REGULATORY_CATEGORIES.has(i.category));
    // Statut du bloc : ses données réglementaires (à défaut, toutes).
    return { id, label: CIL_BLOCK_LABELS[id], status: aggregateCilStatus((reg.length ? reg : its).map((i) => i.status)), items: its, notice: notices.get(id) ?? null };
  });

  const recommendations = input.journal.filter((j) => j.status === 'RECOMMENDATION_ONLY');
  return {
    version: CIL_STATE_VERSION,
    assetId: input.asset.id,
    computedAt: input.now ?? new Date().toISOString(),
    regulatory: cilProgress(items.filter((i) => REGULATORY_CATEGORIES.has(i.category))),
    complement: cilProgress(items.filter((i) => !REGULATORY_CATEGORIES.has(i.category))),
    blocks,
    energyEquipmentIds,
    recommendations: { count: recommendations.length, sourceFileIds: [...new Set(recommendations.flatMap((r) => r.sourceFileIds))] },
    documents: [...cited.values()],
    works: allWorks,
  };
}
