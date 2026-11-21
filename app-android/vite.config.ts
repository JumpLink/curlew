import { fileURLToPath } from "node:url";
import { defineNativescriptConfig } from "@gjsify/nativescript-vite";

// The shell imports Curlew's own packages from source. They are not dependencies of this
// project (it is not a workspace member, so `gjsify install --immutable` in CI never sees it),
// hence the aliases instead of node_modules links.
const pkg = (p: string) => fileURLToPath(new URL(`../packages/${p}`, import.meta.url));

export default defineNativescriptConfig(
  { giRenderer: true, giReal: ["Gio", "GLib"] },
  {
    resolve: {
      alias: {
        "@curlew/protocol": pkg("protocol/src/index.ts"),
        "@curlew/store/index-db": pkg("store/src/index-db-entry.ts"),
        "@curlew/imap/stream": pkg("imap/src/stream-entry.gjs.ts"),
      },
    },
  }
);
