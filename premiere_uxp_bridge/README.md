# Gospelo Premiere Bridge (UXP panel)

This is the Premiere-side companion for `gospelo-premiere-mcp`. It is a UXP
panel, not a standalone application. The panel establishes an authenticated
outbound WSS connection to the local Python MCP server and currently supports
only one read-only operation: recursively listing the active project's assets.

## Prerequisites

- Adobe Premiere Pro `25.6.0` or later.
- Adobe UXP Developer Tool `2.2` or later.
- A trusted local TLS certificate for `127.0.0.1`.

Premiere UXP permits WebSocket *clients*, not servers. On macOS, UXP blocks
insecure HTTP connections, so this project deliberately uses
`wss://127.0.0.1:47653` rather than an unencrypted local socket.

## One-time local setup

1. Generate a localhost certificate, then trust its certificate in macOS
   Keychain Access (or use an organisation-provided development certificate).

   ```bash
   bash scripts/create_premiere_bridge_cert.sh
   ```

2. Start the MCP server with the same random token that will be entered in the
   panel. The certificate and key paths below are the defaults from the script.

   ```bash
   export GOSPELO_PREMIERE_BRIDGE_TOKEN="replace-with-a-random-32-plus-character-token"
   export GOSPELO_PREMIERE_BRIDGE_CERT="$PWD/.premiere-bridge-tls/cert.pem"
   export GOSPELO_PREMIERE_BRIDGE_KEY="$PWD/.premiere-bridge-tls/key.pem"
   gospelo-premiere-mcp
   ```

3. In UXP Developer Tool, add and load the `premiere_uxp_bridge/` directory.
   Open **Window → UXP Plugins → Gospelo Premiere Bridge** in Premiere, enter
   the same token, and select **Connect**.

4. Call `premiere_bridge_status`, then `premiere_list_project_assets` from the
   MCP host.

The UXP manifest intentionally allow-lists only
`wss://127.0.0.1:47653`. If the endpoint changes, update both
`manifest.json` and the Python bridge configuration together.

## Result shape

```json
{
  "ok": true,
  "project": {"id": "…", "name": "Edit", "path": "/…/Edit.prproj"},
  "assets": [
    {"id": "…", "parentId": "…", "name": "Interviews", "kind": "bin"},
    {"id": "…", "parentId": "…", "name": "A001.mov", "kind": "media", "mediaPath": "/…/A001.mov", "offline": false}
  ]
}
```

All future editing features should be introduced as explicit, separately
reviewed methods. Do not turn this bridge into an arbitrary code-execution or
GUI-automation channel.
