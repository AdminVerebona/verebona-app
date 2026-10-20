/**
 * GET /api/admin/communications/preview?eventCode=…&channel=email|push|in_app
 * — CDC Back-Office V1 COM-006 à COM-009.
 *
 * Rendu du modèle selon le canal, avec les SEULES données du propre compte de
 * l'administrateur connecté (COM-007, SEC-005). Une donnée absente est
 * remplacée par une mention explicite et la prévisualisation est déclarée
 * incomplète (COM-009) — jamais de donnée fictive ni d'un autre compte.
 *
 * COM-008 : `assetId`, `documentId`, `deadlineId`, `paymentId` (facture) et
 * `withdrawalId` (rétractation) optionnels désignent le
 * contexte à utiliser, choisi parmi les objets du compte de l'administrateur
 * (`GET …/preview-context`). Un identifiant hors de ce compte est ignoré et
 * signalé (`rejected`), jamais utilisé.
 *
 * E-mail (lot 74A, point 2) : rendu par `renderListEmail` — même chemin que
 * l'envoi réel (`EmailService.renderTemplate`, valeurs neutralisées) ; pour un
 * e-mail de notification (`notif_*`), message réel de l'événement.
 *
 * Push / in-app : le contenu est rendu par le catalogue avec le payload
 * construit depuis ce contexte ; s'il manque une donnée requise, la
 * prévisualisation est déclarée impossible ou incomplète (COM-009).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, getSession, sessionErrorResponse } from '@/lib/auth-guards';
import { getCatalogEntry } from '@/lib/notifications/catalog';
import {
  findChannelDefinition,
  findEmailTemplate,
  isCommunicationChannel,
  listEventDefinitions,
  loadEmailTemplateCodes,
  loadPreviewContextOptions,
  selectPreviewContext,
  contextPayload,
} from '@/services/admin/communications.service';
import { renderListEmail } from '@/services/admin/email-template-editor.service';

function optionalId(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export async function GET(request: NextRequest) {
  let adminId: number;
  let currentAccountId: number | undefined;
  try {
    adminId = await requireAdmin(request);
    currentAccountId = (await getSession(request)).currentAccountId;
  } catch (error) {
    return sessionErrorResponse(error);
  }

  const url = new URL(request.url);
  const eventCode = url.searchParams.get('eventCode') ?? '';
  const channel = url.searchParams.get('channel');
  if (!eventCode || !isCommunicationChannel(channel)) {
    return NextResponse.json({ code: 'INVALID_QUERY', message: 'Paramètres eventCode et channel requis.' }, { status: 400 });
  }

  try {
    const defs = listEventDefinitions(await loadEmailTemplateCodes());
    const found = findChannelDefinition(defs, eventCode, channel);
    if (!found) {
      return NextResponse.json({ code: 'UNKNOWN_CHANNEL', message: 'Canal inconnu pour cet événement.' }, { status: 404 });
    }

    const options = await loadPreviewContextOptions(adminId, currentAccountId);
    const selected = selectPreviewContext(options, {
      assetId: optionalId(url.searchParams.get('assetId')),
      documentId: optionalId(url.searchParams.get('documentId')),
      deadlineId: optionalId(url.searchParams.get('deadlineId')),
      paymentId: optionalId(url.searchParams.get('paymentId')),
      withdrawalId: optionalId(url.searchParams.get('withdrawalId')),
    });
    const rejected = selected.rejected;

    if (channel === 'email') {
      const template = found.event.emailTemplateCode ? await findEmailTemplate(found.event.emailTemplateCode) : null;
      if (!template) {
        return NextResponse.json({
          channel,
          available: false,
          message: 'Aucun gabarit e-mail n’est enregistré pour ce modèle : prévisualisation impossible.',
        });
      }
      // Lot 74A (point 2) : même rendu que l'envoi réel et que l'e-mail de test
      // (renderTemplate : valeurs neutralisées, objet sur une ligne, enveloppe
      // de la charte) ; e-mail d'une notification : message réel de l'événement.
      const { rendered, missingCount, recipient } = await renderListEmail({
        template, eventCode: found.event.code, eventKind: found.event.kind, selected,
        accountId: options.accountId, adminId, sessionAccountId: currentAccountId,
      });
      return NextResponse.json({
        channel,
        available: true,
        subject: rendered.subject,
        body: rendered.html,
        isHtml: true,
        recipient,
        incomplete: missingCount > 0,
        missingCount,
        rejected,
      });
    }

    const entry = found.event.kind === 'notification' ? getCatalogEntry(found.event.code) : undefined;
    if (!entry) {
      return NextResponse.json({ channel, available: false, message: 'Aucun rendu disponible pour ce canal.' });
    }
    const payload = contextPayload(selected, options.accountId);
    const parsed = entry.payloadSchema.safeParse(payload);
    let rendered: ReturnType<typeof entry.render> | null = null;
    try {
      rendered = entry.render((parsed.success ? parsed.data : payload) as never);
    } catch {
      rendered = null;
    }
    if (!rendered) {
      return NextResponse.json({
        channel,
        available: false,
        needsContext: true,
        rejected,
        message:
          'Ce modèle dépend d’un contexte (bien, document, échéance…) : choisissez-le dans votre compte. Si votre compte n’en contient pas, la prévisualisation est impossible.',
      });
    }
    const title = channel === 'push' ? rendered.pushTitle : rendered.bellTitle;
    const body = channel === 'push' ? rendered.pushBody : rendered.bellBody;
    const incomplete = !parsed.success || /undefined|null|NaN/.test(`${title} ${body}`);
    return NextResponse.json({
      channel,
      available: true,
      title: title.replace(/undefined|null|NaN/g, '[donnée indisponible]'),
      body: body.replace(/undefined|null|NaN/g, '[donnée indisponible]'),
      incomplete,
      needsContext: !parsed.success,
      rejected,
    });
  } catch (error) {
    console.error('[admin/communications/preview] GET :', error);
    return NextResponse.json({ code: 'PREVIEW_FAILED', message: 'Prévisualisation impossible.' }, { status: 500 });
  }
}
