/** Selects the real GObject engine; imported first so it runs before any Adwaita module (see Steuererklärung shell). */
import requireGi from "@gjsify/node-gi/gi";
import { useRealGObjectEngine } from "@gjsify/adwaita-gobject-native";

useRealGObjectEngine(requireGi);
