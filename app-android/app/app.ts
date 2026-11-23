import "@gjsify/native-secret-store-bridge";
import "./engine";
import { Application } from "@nativescript/core";
import { registerAdwaita } from "@gjsify/adwaita-nativescript";

registerAdwaita();
Application.run({ moduleName: "app-root" });
