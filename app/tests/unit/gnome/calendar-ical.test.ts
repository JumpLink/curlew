import { describe, expect, it } from '@gjsify/unit';

import { eventFromIcal } from '../../../../packages/gnome/src/calendar.gjs.ts';
import { ical } from '../../../../packages/gnome/src/libs.gjs.ts';

// `@gjsify/pim` hands out iCalendar text: EDS the bare VEVENT, CalDAV a VCALENDAR around it.
const VEVENT = [
  'BEGIN:VEVENT',
  'UID:event-1@example.invalid',
  'DTSTART:20260105T090000Z',
  'DTEND:20260105T100000Z',
  'SUMMARY:Planning',
  'LOCATION:Room 2',
  'ORGANIZER:mailto:alice@example.invalid',
  'ATTENDEE:mailto:bob@example.invalid',
  'ATTENDEE:MAILTO:carol@example.invalid',
  'RRULE:FREQ=WEEKLY',
  'END:VEVENT',
].join('\r\n');

const ALL_DAY = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:day-1',
  'DTSTART;VALUE=DATE:20260110',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

export default async () => {
  // A host without the ICalGLib typelib has no EDS calendar either; listEvents reports that.
  let lib: Awaited<ReturnType<typeof ical.get>>;
  try {
    lib = await ical.get();
  } catch {
    return;
  }

  await describe('calendar event from iCalendar text', async () => {
    await it('maps a bare VEVENT', async () => {
      const dto = eventFromIcal(lib, VEVENT, 'cal-1');
      expect(dto?.uid).toBe('event-1@example.invalid');
      expect(dto?.summary).toBe('Planning');
      expect(dto?.start).toBe('2026-01-05T09:00:00.000Z');
      expect(dto?.end).toBe('2026-01-05T10:00:00.000Z');
      expect(dto?.allDay).toBe(false);
      expect(dto?.location).toBe('Room 2');
      expect(dto?.organizer).toBe('alice@example.invalid');
      expect(dto?.attendees).toEqualArray(['bob@example.invalid', 'carol@example.invalid']);
      expect(dto?.recurring).toBe(true);
      expect(dto?.calendarUid).toBe('cal-1');
    });

    await it('finds the VEVENT inside a VCALENDAR and marks a date as all-day', async () => {
      const dto = eventFromIcal(lib, ALL_DAY, 'cal-2');
      expect(dto?.uid).toBe('day-1');
      expect(dto?.allDay).toBe(true);
      expect(dto?.recurring).toBe(false);
    });

    await it('skips text without an event start', async () => {
      expect(eventFromIcal(lib, 'BEGIN:VEVENT\r\nUID:x\r\nEND:VEVENT', 'cal-1')).toBeNull();
      expect(eventFromIcal(lib, 'BEGIN:VTODO\r\nUID:t\r\nEND:VTODO', 'cal-1')).toBeNull();
    });
  });
};
