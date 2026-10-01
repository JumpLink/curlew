/**
 * Calendar via Evolution Data Server (GJS-only).
 *
 * Reads CalDAV/local calendars EDS exposes (a Nextcloud GOA account yields a
 * CalDAV calendar here). Returns plain CalendarEventDTOs for events occurring in
 * a time window. Recurring events are returned as their series definition (the
 * occur-in-time-range filter selects series with an occurrence in the window);
 * per-occurrence expansion (generate_instances) is a possible future addition.
 */

import type ECal from 'gi://ECal?version=2.0';
import type EDataServer from 'gi://EDataServer?version=1.2';
import type ICalGLib from 'gi://ICalGLib?version=3.0';

import { extractList, getRegistry, sourceGoaAccountId } from './eds.gjs.ts';
import { cal, eds } from './libs.gjs.ts';
import { errorMessage, GnomeError } from '@postbote/protocol';
import type { CalendarEventDTO, ListEventsOptions } from '@postbote/protocol';

const DEFAULT_LIMIT = 100;
const CONNECT_WAIT_SECONDS = 15;

/** Promise wrapper around the static async ECal.Client.connect (callback-only in @girs). */
function connectCalendar(lib: typeof ECal, source: EDataServer.Source): Promise<ECal.Client> {
  return new Promise((resolve, reject) => {
    lib.Client.connect(source, lib.ClientSourceType.EVENTS, CONNECT_WAIT_SECONDS, null, (_src, res) => {
      try {
        const client = lib.Client.connect_finish(res);
        if (!client) {
          reject(new Error('ECal.Client.connect_finish returned null'));
          return;
        }
        resolve(client as ECal.Client);
      } catch (err) {
        reject(err);
      }
    });
  });
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

function mapComponent(lib: typeof ICalGLib, comp: ECal.Component, calendarUid: string): CalendarEventDTO | null {
  const ical = comp.get_icalcomponent();
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

/**
 * List events occurring in [from, to] across enabled calendars (optionally one
 * calendar or one GOA account). Calendars that fail to open are skipped; if none
 * open, the last error is surfaced. Results are sorted by start ascending.
 */
export async function listEvents(options: ListEventsOptions): Promise<CalendarEventDTO[]> {
  const { from, to, calendarUid, accountId, limit = DEFAULT_LIMIT } = options;
  const { ECal: ecal, ICalGLib: icalLib } = await cal.get();
  const EDS = await eds.get();
  const startIso = ecal.isodate_from_time_t(toEpochSeconds(from));
  const endIso = ecal.isodate_from_time_t(toEpochSeconds(to));
  const sexp = `(occur-in-time-range? (make-time "${startIso}") (make-time "${endIso}"))`;

  const reg = await getRegistry();
  let sources: EDataServer.Source[];
  try {
    sources = reg.list_enabled(EDS.SOURCE_EXTENSION_CALENDAR);
  } catch (err) {
    throw new GnomeError(`list calendars: ${errorMessage(err)}`);
  }
  if (calendarUid) sources = sources.filter((s) => s.get_uid() === calendarUid);
  if (accountId) sources = sources.filter((s) => sourceGoaAccountId(EDS, reg, s) === accountId);

  const events: CalendarEventDTO[] = [];
  let opened = 0;
  let lastError: unknown = null;

  for (const source of sources) {
    if (events.length >= limit) break;
    let client: ECal.Client;
    try {
      client = await connectCalendar(ecal, source);
      opened++;
    } catch (err) {
      lastError = err;
      continue;
    }
    try {
      const comps = extractList<ECal.Component>(await client.get_object_list_as_comps(sexp, null));
      for (const comp of comps) {
        const dto = mapComponent(icalLib, comp, source.get_uid());
        if (dto) events.push(dto);
        if (events.length >= limit) break;
      }
    } catch (err) {
      throw new GnomeError(`get_object_list_as_comps(${source.get_display_name()}): ${errorMessage(err)}`);
    }
  }

  if (opened === 0 && sources.length > 0 && lastError) {
    throw new GnomeError(`connect calendar: ${errorMessage(lastError)}`);
  }
  events.sort((a, b) => a.start.localeCompare(b.start));
  return events;
}
