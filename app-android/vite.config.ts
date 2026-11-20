import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defineNativescriptConfig } from "@gjsify/nativescript-vite";

// The shell imports Curlew's own packages from source. They are not dependencies of this
// project (it is not a workspace member, so `gjsify install --immutable` in CI never sees it),
// hence the aliases instead of node_modules links.
const pkg = (p: string) => fileURLToPath(new URL(`../packages/${p}`, import.meta.url));

// fixed upstream in gjsify: sync node:fs bridge (openSync/readSync); drop this stub after the bump.
// GAP (report to gjsify): `node:fs` is `none` for NativeScript beyond fs/promises, and
// protocol's media-probe.ts needs openSync/readSync. The IMAP probe never calls it, so the shell
// swaps the module for a stub that throws. Remove when gjsify has a sync fs bridge.
function stubMediaProbe(): Plugin {
  const stub = fileURLToPath(new URL("./app/media-probe-stub.ts", import.meta.url));
  return {
    name: "curlew-stub-media-probe",
    enforce: "pre",
    resolveId(source, importer) {
      if (/(^|\/)media-probe\.ts$/.test(source) && importer?.includes("/protocol/src/")) return stub;
      return null;
    },
  };
}

// fixed upstream in gjsify: a real-Gio switch for the nativescript preset; drop this plugin after the bump.
// GAP (report to gjsify): the vite preset maps `gi://Gio` / `gi://GLib` to the widget renderer's
// sparse arm (no SocketClient) under `giRenderer`, and to an empty module without it. A package
// that needs REAL Gio on Android has no switch for it, so the shell resolves those two itself.
const REAL_GI = "\0curlew-real-gi:";
function realGi(namespaces: string[]): Plugin {
  const real = fileURLToPath(new URL("./app/gi-real.ts", import.meta.url));
  return {
    name: "curlew-real-gi",
    enforce: "pre",
    resolveId: {
      order: "pre",
      handler(source) {
        const m = /^gi:\/\/(\w+)(?:\?version=([\d.]+))?$/.exec(source);
        if (!m || !namespaces.includes(m[1])) return null;
        return `${REAL_GI}${m[1]}:${m[2] ?? ""}`;
      },
    },
    load(id) {
      if (!id.startsWith(REAL_GI)) return null;
      const [ns, version] = id.slice(REAL_GI.length).split(":");
      return `import { gi } from ${JSON.stringify(real)};\nexport default gi(${JSON.stringify(ns)}${version ? `, ${JSON.stringify(version)}` : ""});\n`;
    },
  };
}

export default defineNativescriptConfig(
  { giRenderer: true },
  {
    plugins: [realGi(["Gio", "GLib"]), stubMediaProbe()],
    resolve: {
      alias: {
        "@curlew/protocol": pkg("protocol/src/index.ts"),
        "@curlew/imap/stream": pkg("imap/src/stream-entry.gjs.ts"),
      },
    },
  }
);
