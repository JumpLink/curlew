/**
 * Widgets the two places that ask for a backend's terms share: the login page and the protocol
 * switch dialog.
 */

import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';
import { _ } from '@curlew/protocol';

/** The link to the full terms. A long URL is shortened in the middle instead of widening the page. */
export function termsLinkButton(uri: string, halign: Gtk.Align): Gtk.LinkButton {
  const label = new Gtk.Label({ label: uri, ellipsize: Pango.EllipsizeMode.MIDDLE });
  return new Gtk.LinkButton({ uri, child: label, halign, tooltipText: uri });
}

/**
 * The "I accept the risk" box. Its label wraps: a CheckButton's own label does not, and on a
 * 360 px phone it pushed the sheet to 423 px and cut the dialog off.
 */
export function riskCheckButton(): Gtk.CheckButton {
  const label = new Gtk.Label({
    label: _('I understand and accept the risk for my account'),
    wrap: true,
    xalign: 0,
  });
  return new Gtk.CheckButton({ child: label, halign: Gtk.Align.CENTER });
}
