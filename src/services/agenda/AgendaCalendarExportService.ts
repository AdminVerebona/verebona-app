/**
 * AgendaCalendarExportService — ICS calendar export
 * Per plan §2.6
 */
import type { AgendaItemFull } from './AgendaQueryService';

function escapeICS(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

function foldLine(line: string): string {
  // RFC 5545: fold lines longer than 75 octets
  const result: string[] = [];
  while (line.length > 75) {
    result.push(line.slice(0, 75));
    line = ' ' + line.slice(75);
  }
  result.push(line);
  return result.join('\r\n');
}

function formatDate(dateStr: string): string {
  return dateStr.replace(/-/g, '');
}

function formatDateTime(dateStr: string, timeStr: string): string {
  const time = timeStr.replace(/:/g, '').slice(0, 6);
  return `${formatDate(dateStr)}T${time}`;
}

function addOneDayToDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

export function computeICSContent(items: AgendaItemFull[], calendarName: string): string {
  const now = new Date();
  const dtstamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  const events: string[] = [];

  for (const item of items) {
    // Exclude: no startDate, or annule
    if (!item.startDate) continue;
    if (item.manualStatus === 'annule') continue;

    const assetNames = item.assetLinks.map(l => l.assetName).join(', ');
    const roomNames = item.roomLinks.map(l => l.name).join(', ');
    const equipNames = item.equipmentLinks.map(l => l.name).join(', ');

    // SUMMARY: prepend clock emoji if overdue
    let summary = item.effectiveStatus === 'en_retard' ? `🕒 ${item.title}` : item.title;
    if (assetNames) summary += ` | ${assetNames}`;

    // DESCRIPTION
    let desc = item.description ?? '';
    if (assetNames) desc += `\nBiens : ${assetNames}`;
    if (roomNames) desc += `\nPièces : ${roomNames}`;
    if (equipNames) desc += `\nÉquipements : ${equipNames}`;
    desc = desc.trim();

    // DTSTART
    let dtstart: string;
    if (item.startTime) {
      dtstart = `DTSTART;TZID=Europe/Paris:${formatDateTime(item.startDate, item.startTime)}`;
    } else {
      dtstart = `DTSTART;VALUE=DATE:${formatDate(item.startDate)}`;
    }

    // DTEND
    let dtend: string;
    if (item.endDate && item.endTime) {
      dtend = `DTEND;TZID=Europe/Paris:${formatDateTime(item.endDate, item.endTime)}`;
    } else if (item.endDate) {
      // All-day end: +1 day (RFC 5545)
      dtend = `DTEND;VALUE=DATE:${addOneDayToDate(item.endDate)}`;
    } else {
      // Single day or timed start
      if (item.startTime) {
        // Default 1 hour duration
        const end = new Date(`${item.startDate}T${item.startTime}`);
        end.setHours(end.getHours() + 1);
        const endTime = end.toTimeString().slice(0, 8).replace(/:/g, '');
        dtend = `DTEND;TZID=Europe/Paris:${formatDate(item.startDate)}T${endTime}`;
      } else {
        dtend = `DTEND;VALUE=DATE:${addOneDayToDate(item.startDate)}`;
      }
    }

    const uid = `agenda-${item.publicId}@verebona.com`;

    const lines = [
      'BEGIN:VEVENT',
      foldLine(`UID:${uid}`),
      foldLine(`DTSTAMP:${dtstamp}Z`),
      foldLine(dtstart),
      foldLine(dtend),
      foldLine(`SUMMARY:${escapeICS(summary)}`),
    ];

    if (desc) {
      lines.push(foldLine(`DESCRIPTION:${escapeICS(desc)}`));
    }

    lines.push('END:VEVENT');
    events.push(lines.join('\r\n'));
  }

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Verebona//Agenda//FR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    foldLine(`X-WR-CALNAME:${escapeICS(calendarName)}`),
    'X-WR-TIMEZONE:Europe/Paris',
    ...events,
    'END:VCALENDAR',
  ].join('\r\n');
}
