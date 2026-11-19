/**
 * Widgets the two places that ask for a backend's terms share: the login page and the protocol
 * switch dialog.
 */

import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';
import { _, fmt } from '@curlew/protocol';

/** The link to the full terms, under a short name; the URL stays in the tooltip. */
export function termsLinkButton(uri: string, protocol: string, halign: Gtk.Align): Gtk.LinkButton {
  const label = new Gtk.Label({
    label: fmt(_('{protocol} Terms of Service'), { protocol }),
    ellipsize: Pango.EllipsizeMode.END,
  });
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
