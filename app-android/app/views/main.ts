import type { EventData, Page } from "@nativescript/core";
import { buildWindow } from "../window.ts";

export function onLoaded(args: EventData): void {
  (args.object as Page).content = buildWindow();
}
