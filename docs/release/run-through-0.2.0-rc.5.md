# Run-through: v0.2.0-rc.5

The first pass of the [run-through](run-through.md), done by an agent on isolated state without
real accounts or a second device. Steps that need them are `skip` and wait for a person.

| Step | Host | Flatpak | Notes |
|---|---|---|---|
| 1. First start | ok | ok | Welcome screen hidden on GNOME with online accounts: fixed in #476 (#474). Next button on the edge: fixed in #475 |
| 2. Defaults (AI off, receipts off) | ok | ok | `ui.ai` and `sendReadReceipts` unset mean off; Delta Chat off for every account |
| 3a. Add mail | skip | skip | Needs a throwaway account |
| 3b. Add XMPP | skip | skip | Needs a throwaway account |
| 3c. Add Matrix | skip | skip | Needs a throwaway account |
| 3d. Add Telegram | skip | skip | Pages render, no CLI command shown; login needs a phone |
| 3e. Add Signal | skip | skip | Pages render; linking needs a phone |
| 3f. Add WhatsApp | skip | skip | Pages render; ToS link label ellipsized (#480); linking needs a phone |
| 4. Send and receive | skip | skip | Needs accounts |
| 5. Reactions, edits, deletes | skip | skip | Needs accounts |
| 6. Sent copy in Sent (R1) | skip | skip | Needs a mail account |
| 7. Picker, design preview, pause | skip | skip | Needs a conversation |
| 8. Background service / portal dialog (R15) | skip | skip | Needs the real session |
| 9. Dark mode, accent, 360 px | ok | ok | Headless at 360 px, light and dark; Delta Chat welcome page has a gap (#479) |
| 10. German | ok | fail #477 | The bundle carries no translations; fixed at the core in gjsify#2696 |
| 11. AI and MCP | ok | ok | With AI off `curlew mcp` refuses and names the setting; with AI on it lists 18 tools |
| 12. Read receipts | skip | skip | Needs a second device |
| 13. Quit and reopen | ok | skip | Settings and the welcome flag stay; no accounts to check |
| 14. Account removal | skip | skip | Needs accounts |

Build or commit: `v0.2.0-rc.5` (`7305c5e9`) · Date: 2026-11-18 · Desktop and session: GNOME 51.1,
Wayland (headless mutter for screenshots)

Startup warnings on the host: the known `g_value_get_string` critical (#469), GJS notes on the Goa
property setters, GTK frame-timing notes. In the Flatpak: the missing Goa typelib (#478); online
accounts still list over D-Bus.
