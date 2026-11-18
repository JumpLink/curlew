/**
 * The width of the conversation list beside an open chat. Pure: the window feeds it the pointer
 * position and the window width; nothing here touches GTK.
 */

export const SIDEBAR_DEFAULT_MIN = 320;
export const SIDEBAR_DEFAULT_MAX = 400;
const SIDEBAR_FLOOR = 280;
const SIDEBAR_CEILING = 600;
/** The chat needs this much beside the list, or its composer and bubbles are clipped. */
const CONTENT_FLOOR = 360;
/** One arrow-key press on the handle moves the edge this far. */
export const SIDEBAR_STEP = 16;

/**
 * The sidebar width for a wanted one: inside the floor and ceiling, and never so wide that the
 * chat falls below its floor. A window too narrow for both keeps the floor for the list.
 */
export function clampSidebarWidth(wanted: number, windowWidth: number): number {
  const room = windowWidth > 0 ? windowWidth - CONTENT_FLOOR : SIDEBAR_CEILING;
  const most = Math.max(SIDEBAR_FLOOR, Math.min(SIDEBAR_CEILING, room));
  return Math.round(Math.min(most, Math.max(SIDEBAR_FLOOR, wanted)));
}
