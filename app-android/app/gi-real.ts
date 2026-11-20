// Real GI namespaces for the Curlew packages that import `gi://` (the Gio transport). Loaded by
// the `curlew-real-gi` plugin in vite.config.ts instead of the widget renderer's sparse arm.
import requireGi from "@gjsify/node-gi/gi";

export const gi = requireGi as (namespace: string, version?: string) => unknown;
