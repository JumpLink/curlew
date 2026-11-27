/**
 * The GStreamer side of a voice note: microphone → Opus → Ogg file, with a level reading.
 * Generic and free of Curlew types, so it can move to gjsify (`@gjsify/media-capture` today has the
 * capture source but no recorder); nothing in `@gjsify/*` writes a file yet.
 * // gjsify gap (unfixed, gjsify/gjsify#2761): kept here until it lands.
 */

import Gst from 'gi://Gst?version=1.0';
import GLib from 'gi://GLib?version=2.0';

import { parseLevelDb } from './voice-recorder-model.ts';

export interface VoicePipeline {
  /** Ends the file cleanly (EOS, so the muxer writes its last page); resolves with the length in ms. */
  stop(): Promise<number>;
  /** Throws the recording away; the caller removes the file. */
  abort(): void;
}

export interface VoicePipelineOptions {
  path: string;
  /** Microphone sources in order of preference; each is tried until one starts. */
  sources?: readonly string[];
  /** RMS in dB roughly ten times a second, from the bus: keep the handler light. */
  onLevel(db: number): void;
  /** The pipeline failed after it had started. */
  onError(message: string): void;
}

export const MIC_SOURCES = ['pulsesrc', 'pipewiresrc'];

const make = (name: string): Gst.Element | null => Gst.ElementFactory.make(name, null);

export function startVoicePipeline(options: VoicePipelineOptions): VoicePipeline | null {
  Gst.init([]);
  for (const name of options.sources ?? MIC_SOURCES) {
    const chain = [
      make(name),
      make('audioconvert'),
      make('audioresample'),
      make('capsfilter'),
      make('level'),
      make('opusenc'),
      make('oggmux'),
      make('filesink'),
    ];
    if (chain.some((element) => element === null)) continue;
    const el = chain as Gst.Element[];
    if (name === 'audiotestsrc') el[0]!.set_property('is-live', true);
    el[3]!.set_property('caps', Gst.Caps.from_string('audio/x-raw,rate=48000,channels=1'));
    el[4]!.set_property('interval', 100_000_000);
    el[4]!.set_property('post-messages', true);
    el[5]!.set_property('bitrate', 32000);
    el[7]!.set_property('location', options.path);
    const pipeline = new Gst.Pipeline();
    for (const element of el) pipeline.add(element);
    let linked = true;
    for (let i = 0; i < el.length - 1; i++) linked = el[i]!.link(el[i + 1]!) && linked;
    if (!linked) continue;
    const bus = pipeline.get_bus()!;
    bus.add_signal_watch();
    bus.connect('message::element', (_bus: Gst.Bus, message: Gst.Message) => {
      const structure = message.get_structure();
      if (structure?.get_name() !== 'level') return;
      const db = parseLevelDb(structure.to_string() ?? '');
      if (db !== null) options.onLevel(db);
    });
    bus.connect('message::error', (_bus: Gst.Bus, message: Gst.Message) => {
      options.onError(message.parse_error()[0]?.message ?? '');
    });
    if (pipeline.set_state(Gst.State.PLAYING) === Gst.StateChangeReturn.FAILURE) {
      bus.remove_signal_watch();
      pipeline.set_state(Gst.State.NULL);
      continue;
    }
    const startedAt = GLib.get_monotonic_time();
    let ended = false;
    const close = (): void => {
      ended = true;
      bus.remove_signal_watch();
      pipeline.set_state(Gst.State.NULL);
    };
    return {
      stop() {
        if (ended) return Promise.resolve(0);
        const ms = (GLib.get_monotonic_time() - startedAt) / 1000;
        return new Promise<number>((resolve) => {
          // EOS rides the bus back after the muxer wrote its last page; no blocking pop on the main loop.
          const done = (): void => {
            close();
            resolve(ms);
          };
          bus.connect('message::eos', done);
          GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            if (!ended) done();
            return GLib.SOURCE_REMOVE;
          });
          pipeline.send_event(Gst.Event.new_eos());
        });
      },
      abort() {
        if (!ended) close();
      },
    };
  }
  return null;
}
