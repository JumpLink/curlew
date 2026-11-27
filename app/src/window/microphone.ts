/**
 * The composer's one microphone: an `Adw.SplitButton` whose main part runs the remembered mode
 * (a voice message, or dictation) and whose arrow chooses it. With one mode left it is a plain
 * button; while something records it is the stop control and the other mode is not offered.
 */

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import { configPath } from '@curlew/store';

import { loadConfig, saveConfig } from '../core/config.ts';
import { createDictation, type Dictation } from './dictation.ts';
import type { PickedFile } from './composer-files-model.ts';
import {
  activeMicMode,
  isMicMode,
  micLayout,
  micLook,
  micMenuLabel,
  offeredModes,
  type MicBusy,
  type MicMode,
} from './microphone-model.ts';
import { createVoiceRecorder, type VoiceRecorder } from './voice-recorder.ts';

export interface MicrophoneOptions {
  toast(text: string): void;
  /** A finished voice message, ready to be a chip in the composer. */
  onRecorded(file: PickedFile): void;
  /** The words dictated; the caller puts them into the entry and sends nothing. */
  insert(text: string): void;
}

export interface Microphone {
  /** The one control; hidden while no mode is offered. */
  widget: Gtk.Widget;
  /** Timer, level, cancel and finish of a voice message; visible only while recording. */
  bar: Gtk.Widget;
  /** Which modes this chat offers: voice notes by the protocol, dictation by the composer. */
  setAvailable(offer: { voice: boolean; dictate: boolean }): void;
}

const readMode = (): MicMode | undefined => {
  try {
    return loadConfig(configPath()).ui.micMode;
  } catch {
    return undefined;
  }
};

const writeMode = (mode: MicMode): void => {
  try {
    const config = loadConfig(configPath());
    config.ui.micMode = mode;
    saveConfig(config, configPath());
  } catch {
    // The choice is a convenience: an unwritable config must not break the microphone.
  }
};

export function createMicrophone(options: MicrophoneOptions): Microphone {
  let stored = readMode();
  let busyLook: MicBusy = null;
  let wantVoice = false;
  let wantDictate = false;

  // eslint-disable-next-line prefer-const -- both controllers call back into `refresh`, which needs them.
  let recorder: VoiceRecorder;
  // eslint-disable-next-line prefer-const
  let dictation: Dictation;

  const split = new Adw.SplitButton();
  const plain = new Gtk.Button();
  for (const part of [split, plain]) part.add_css_class('flat');
  split.set_dropdown_tooltip(micMenuLabel());

  const stack = new Gtk.Stack({ hhomogeneous: false, vhomogeneous: false, visible: false });
  stack.add_named(split, 'split');
  stack.add_named(plain, 'plain');
  stack.set_valign(Gtk.Align.END);

  const group = new Gio.SimpleActionGroup();
  const modeAction = Gio.SimpleAction.new_stateful(
    'mode',
    GLib.VariantType.new('s'),
    GLib.Variant.new_string('voice'),
  );
  group.add_action(modeAction);
  stack.insert_action_group('mic', group);

  const offered = (): MicMode[] =>
    offeredModes({ voice: wantVoice && recorder.offered(), dictate: wantDictate && dictation.offered() });

  const refresh = (): void => {
    const modes = offered();
    const layout = micLayout(modes);
    const mode = activeMicMode(stored, modes);
    stack.set_visible(layout !== 'none' && mode !== null);
    if (mode === null) return;
    const look = busyLook ?? micLook(mode);
    const label = busyLook ? busyLook.label : look.label;
    for (const part of [split, plain]) {
      part.set_tooltip_text(label);
      part.update_property([Gtk.AccessibleProperty.LABEL], [label]);
      if (busyLook?.suggested) part.add_css_class('suggested-action');
      else part.remove_css_class('suggested-action');
    }
    split.set_icon_name(look.icon);
    plain.set_icon_name(look.icon);
    modeAction.set_state(GLib.Variant.new_string(mode));
    const menu = new Gio.Menu();
    for (const one of modes) menu.append(micLook(one).choice, `mic.mode::${one}`);
    split.set_menu_model(menu);
    stack.set_visible_child_name(layout === 'split' && busyLook === null ? 'split' : 'plain');
  };

  recorder = createVoiceRecorder({
    toast: options.toast,
    onRecorded: options.onRecorded,
    onLook: (look) => {
      busyLook = look;
      refresh();
    },
    onOfferChange: refresh,
  });
  dictation = createDictation({
    toast: options.toast,
    insert: options.insert,
    onLook: (look) => {
      busyLook = look;
      refresh();
    },
    onOfferChange: refresh,
    anchor: () => stack,
  });

  const run = (mode: MicMode): void => (mode === 'voice' ? recorder.press() : dictation.press());

  const press = (): void => {
    if (recorder.busy()) recorder.press();
    else if (dictation.busy()) dictation.press();
    else {
      const mode = activeMicMode(stored, offered());
      if (mode !== null) run(mode);
    }
  };
  split.connect('clicked', press);
  plain.connect('clicked', press);

  const choose = (mode: MicMode): void => {
    if (recorder.busy() || dictation.busy() || !offered().includes(mode)) return;
    stored = mode;
    writeMode(mode);
    refresh();
  };
  modeAction.connect('activate', (_action, parameter) => {
    const value = parameter?.get_string()[0];
    if (isMicMode(value)) choose(value);
  });

  // Each mode keeps a key of its own: it chooses the mode and starts it in one go.
  const keys = new Gtk.ShortcutController({ scope: Gtk.ShortcutScope.GLOBAL });
  const shortcut = (trigger: string, mode: MicMode): void => {
    keys.add_shortcut(
      new Gtk.Shortcut({
        trigger: Gtk.ShortcutTrigger.parse_string(trigger),
        action: Gtk.CallbackAction.new(() => {
          if (recorder.busy() || dictation.busy() || !offered().includes(mode)) return false;
          choose(mode);
          run(mode);
          return true;
        }),
      }),
    );
  };
  shortcut('<Control><Shift>r', 'voice');
  shortcut('<Control><Shift>d', 'dictate');
  stack.add_controller(keys);

  const escape = new Gtk.EventControllerKey();
  escape.connect('key-pressed', (_c, keyval) => keyval === Gdk.KEY_Escape && dictation.escape());
  stack.add_controller(escape);

  return {
    widget: stack,
    bar: recorder.bar,
    setAvailable(offer) {
      wantVoice = offer.voice;
      wantDictate = offer.dictate;
      recorder.setAvailable(offer.voice);
      dictation.setAvailable(offer.dictate);
      refresh();
    },
  };
}
