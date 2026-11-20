import type { NativeScriptConfig } from "@nativescript/core";

export default {
  id: "eu.jumplink.curlew",
  appPath: "app",
  appResourcesPath: "data",
  bundler: "vite",
  bundlerConfigPath: "vite.config.ts",
  android: {
    v8Flags: "--expose_gc",
    gradleVersion: "8.14.3",
    markingMode: "none",
    codeCache: true,
  },
  cssParser: "rework",
} as NativeScriptConfig;
