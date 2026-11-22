/**
 * Calendar via Evolution Data Server, through the EDS driver of `@gjsify/pim`.
 *
 * Reads CalDAV/local calendars EDS exposes (a Nextcloud GOA account yields a CalDAV calendar
 * here). The driver hands out iCalendar text; this file projects it into CalendarEventDTOs.
 * Recurring events are returned as their series definition (the occur-in-time-range filter
 * selects series with an occurrence in the window). Runs unchanged on GJS and on Node/Bun via
 * `@gjsify/node-gi` — see `index.ts`.
 */

import type ICalGLib from 'gi://ICalGLib?version=3.0';

import { BackendUnavailableError, PimError, setPimTranslator, type CalendarBackend } from '@gjsify/pim';
import { createEdsBackend } from '@gjsify/pim/eds';

import { gnomeError, isGnomeFailure } from './errors.ts';
import { ical } from './libs.gjs.ts';
import { _, _n, GnomeError, GnomeUnavailableError } from '@curlew/protocol';
import type { CalendarEventDTO, ListEventsOptions } from '@curlew/protocol';

const DEFAULT_LIMIT = 100;

let backend: CalendarBackend | null = null;

function eds(): CalendarBackend {
  if (!backend) {
    // pim's messages ("no enabled calendar …") reach the user through curlew's catalogue.
    setPimTranslator({ gettext: _, ngettext: _n });
    backend = createEdsBackend();
  }
  return backend;
}

/** pim's errors → the ones every curlew frontend already reports (`GnomeUnavailableError` = no EDS here). */
function fromPim(err: unknown): unknown {
  if (err instanceof BackendUnavailableError) return new GnomeUnavailableError(err.message);
  if (err instanceof PimError) {
    const { domain, code } = err as { domain?: string; code?: number };
    return new GnomeError(err.message, domain, code);
  }
  return err;
}

/** Parse an ISO date/datetime to epoch seconds. Bare YYYY-MM-DD is treated as UTC midnight. */
function toEpochSeconds(value: string): number {
  const ms = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(ms)) throw new GnomeError(`invalid date: ${value}`);
  return Math.floor(ms / 1000);
}

function stripMailto(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/^mailto:/i, '') || null;
}

/** An ICalGLib.Time → ISO-8601 (UTC), or null for an absent/empty time. */
function timeToIso(time: ICalGLib.Time | null): string | null {
  if (!time) return null;
  const epoch = time.as_timet();
  if (!epoch || epoch <= 0) return null;
  return new Date(epoch * 1000).toISOString();
}

/** iCalendar text → the VEVENT in it. EDS hands out the bare component, CalDAV a VCALENDAR. */
function parseEvent(lib: typeof ICalGLib, text: string): ICalGLib.Component | null {
  const comp = lib.Component.new_from_string(text);
  if (!comp) return null;
  if (comp.isa() === lib.ComponentKind.VEVENT_COMPONENT) return comp;
  return comp.get_first_component(lib.ComponentKind.VEVENT_COMPONENT);
}

/** One iCalendar text (bare VEVENT or a VCALENDAR around one) → the DTO, or null without a start. */
export function eventFromIcal(
  lib: typeof ICalGLib,
  text: string,
  calendarUid: string,
): CalendarEventDTO | null {
  const ical = parseEvent(lib, text);
  if (!ical) return null;
  const dtstart = ical.get_dtstart();
  const start = timeToIso(dtstart);
  if (!start) return null;

  const orgProp = ical.get_first_property(lib.PropertyKind.ORGANIZER_PROPERTY);
  const organizer = orgProp ? stripMailto(orgProp.get_organizer()) : null;

  const attendees: string[] = [];
  let attProp = ical.get_first_property(lib.PropertyKind.ATTENDEE_PROPERTY);
  while (attProp) {
    const attendee = stripMailto(attProp.get_attendee());
    if (attendee) attendees.push(attendee);
    attProp = ical.get_next_property(lib.PropertyKind.ATTENDEE_PROPERTY);
  }

  return {
    uid: ical.get_uid() || '',
    summary: ical.get_summary() || null,
    start,
    end: timeToIso(ical.get_dtend()),
    allDay: dtstart.is_date(),
    location: ical.get_location() || null,
    organizer,
    attendees,
    recurring: ical.get_first_property(lib.PropertyKind.RRULE_PROPERTY) !== null,
    calendarUid,
  };
}

/** Do the work. Everything here may raise a native error; `listEvents` owns the boundary. */
async function listEventsImpl(options: ListEventsOptions): Promise<CalendarEventDTO[]> {
  const { from, to, calendarUid, accountId, limit = DEFAULT_LIMIT } = options;
  const window = {
    from: new Date(toEpochSeconds(from) * 1000).toISOString(),
    to: new Date(toEpochSeconds(to) * 1000).toISOString(),
  };
  const lib = await ical.get();

  let allowed: Set<string> | null = null;
  if (accountId) {
    const calendars = await eds().listCalendars('event');
    allowed = new Set(calendars.filter((c) => c.accountId === accountId).map((c) => c.uid));
    if (allowed.size === 0) return [];
  }

  // The driver skips calendars that fail to open and raises only when none opens.
  const items = await eds().listItems({ kind: 'event', calendarUid, ...window });
  const events: CalendarEventDTO[] = [];
  for (const item of items) {
    if (allowed && !allowed.has(item.calendarUid)) continue;
    const dto = eventFromIcal(lib, item.ical, item.calendarUid);
    if (dto) events.push(dto);
  }
  events.sort((a, b) => a.start.localeCompare(b.start));
  return events.slice(0, limit);
}

/**
 * List events occurring in [from, to] across enabled calendars (optionally one
 * calendar or one GOA account). Calendars that fail to open are skipped; if none
 * open, the last error is surfaced. Results are sorted by start ascending.
 *
 * The boundary for the whole EDS calendar path: an unwrapped GLib.Error on GJS is a boxed
 * GObject that JSON-serializes to `{}`, so everything leaves as `GnomeError` /
 * `GnomeUnavailableError`.
 */
export async function listEvents(options: ListEventsOptions): Promise<CalendarEventDTO[]> {
  try {
    return await listEventsImpl(options);
  } catch (err) {
    const mapped = fromPim(err);
    if (isGnomeFailure(mapped)) throw mapped;
    throw gnomeError('listEvents', err);
  }
}
