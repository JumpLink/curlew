import { Adw, Gtk } from "@gjsify/adwaita-nativescript";
import { _ } from "@curlew/protocol";
import { runProbes } from "./probe.ts";

/** One label per probe line; the shell has no other job yet. */
export function buildWindow(): Adw.ToolbarView {
  const list = new Gtk.Box();
  list.orientation = "vertical";
  const append = (text: string) => {
    const label = new Gtk.Label();
    label.label = text;
    label.wrap = true;
    label.selectable = true;
    list.append(label);
  };
  const header = new Adw.HeaderBar();
  const title = new Adw.WindowTitle();
  title.title = _("Curlew");
  title.subtitle = _("IMAP over TLS probe");
  header.set_title_widget(title);
  const scroll = new Gtk.ScrolledWindow();
  scroll.set_child(list);
  const view = new Adw.ToolbarView();
  view.add_top_bar(header);
  view.set_content(scroll);
  void runProbes(append);
  return view;
}
