# Thinr — ThinRemote CLI

<p align="center">
  <img src='https://s3.us-east-1.amazonaws.com/thinremote.io.files/share-image.svg' alt="Thinger">
</p>

A command-line tool for managing remote IoT devices on the ThinRemote
platform, and an MCP server that lets AI assistants drive those
devices programmatically.

Two operating modes:

- **CLI** — interactive or scripted device management from a shell.
- **MCP server** — a stdio [Model Context Protocol][mcp] server that
  exposes the same operations as typed tools for AI clients like
  Claude Code.

Both modes share the same auth, profiles, and device API layer, so
you configure the tool once and use it in whichever mode fits the
task at hand.

[mcp]: https://modelcontextprotocol.io/

## Table of contents

- [Installation](#installation)
- [Initial setup](#initial-setup)
- [Global options and environment variables](#global-options-and-environment-variables)
- [Part 1 — CLI](#part-1--cli)
  - [JSON output](#json-output)
  - [`thinr device <action> [<deviceId>]`](#thinr-device-action-deviceid)
  - [`thinr product <action> <productId>`](#thinr-product-action-productid)
  - [`thinr profile`](#thinr-profile)
  - [`thinr logout`](#thinr-logout)
- [Part 2 — MCP server](#part-2--mcp-server)
  - [Starting the server](#starting-the-server)
  - [Tool catalog](#tool-catalog)
  - [Per-call controls](#per-call-controls)
  - [Integrating with Claude Code](#integrating-with-claude-code)
- [Profiles and multi-account use](#profiles-and-multi-account-use)
- [Development](#development)
- [License](#license)

## Installation

### From NPM (recommended)

```bash
npm install -g @thinremote/thinr-cli
```

### From source

```bash
git clone https://github.com/Thin-Remote/thinr-cli.git
cd thinr-cli
npm install
npm link
```

Requires Node.js ≥ 14.16.

## Initial setup

Run the CLI once with no arguments to authenticate:

```bash
thinr
```

You'll be prompted for the ThinRemote server, and can authenticate
with either username/password (OAuth 2.0 device flow) or a pre-issued
token. On success a profile is created at
`~/.config/thinr-cli/config.json`, named after the server hostname,
and marked as the default.

Every later command reads that profile automatically. Logging into a
second server creates a second profile side-by-side; see
[Profiles and multi-account use](#profiles-and-multi-account-use).

## Global options and environment variables

These apply to every subcommand:

| Flag | Env var | Meaning |
| --- | --- | --- |
| `--profile <name>` | `THINR_PROFILE` | Use a non-default profile for this invocation. |
| `-u, --user <name>` | — | Admin impersonation: act on behalf of another user (requires admin privileges on the server). |
| — | `THINR_INSECURE=1` | Accept self-signed TLS certificates globally. Localhost / 127.0.0.1 are always accepted; this flag extends the relaxation to any host, useful for LAN dev servers. |

---

## Part 1 — CLI

All device- and product-scoped actions follow a **subcommand-first**
shape: the action comes before the target id, matching patterns like
`kubectl describe pod <name>` or `git remote add <name> <url>`.

```
thinr device <action>  <deviceId>  [args…] [options]
thinr product <action> <productId> [args…] [options]
```

### JSON output

Every data-producing command accepts `-j, --json` and writes a single
envelope to stdout so scripts can pipe it to `jq`:

```json
{ "ok": true, "data": <payload> }
{ "ok": false, "error": { "message": "...", "code": "<code>" } }
```

Process exit codes always reflect success (`0`) or failure (non-zero),
independently of the envelope.

Emitted error `code` values:

| code | meaning |
| --- | --- |
| `not_configured` | CLI has no saved profile — run `thinr` to set up. |
| `not_found` | Device, property, resource or profile not found. |
| `unauthorized` | Token expired or insufficient permissions. |
| `server_error` | Non-success HTTP response from the server. |
| `network_error` | No response from the server. |
| `input_error` | Bad or missing CLI argument. |
| `timeout` | Command timed out on the device (`exec`). |
| `cancelled` | User interrupted with Ctrl+C (`exec`). |
| `error` | Fallback for anything uncategorised. |

Spinners and progress messages are suppressed in JSON mode so the
output is valid JSON without wrappers. Interactive commands
(`console`, `tcp`/`tls`/`http`) accept `--json` silently but
don't change their behaviour — they don't produce a discrete result.
`exec` buffers stdout/stderr when `--json` is set and emits a single
envelope on exit.

### `thinr device <action> [<deviceId>]`

Most actions take a `<deviceId>` as their first positional. The `list`
action is the exception — it operates on the fleet, with an optional
`<pattern>` to filter results.

#### `list`

List every device visible to the active profile, or filter with a
case-insensitive regex (matched against device id and name on the
server side):

```bash
thinr device list                    # every device
thinr device list supermicro         # only ids/names containing "supermicro"
thinr device list "^revpi|jetson"    # regex alternation works too
thinr device list --json             # JSON envelope with the raw API records
```

Combine with the global `-u, --user` flag for admin impersonation.

#### `console`

Open an interactive terminal on the device:

```bash
thinr device console <deviceId>
```

#### Proxies — `tcp` / `tls` / `http`

Create a TCP, TLS, or HTTP proxy to a remote endpoint reachable from
the device:

```bash
thinr device tcp  <deviceId> [target] [options]
thinr device tls  <deviceId> [target] [options]
thinr device http <deviceId> [target] [options]
```

`target` is the remote address and port on the device side. Defaults
when omitted: `tcp` → 22, `tls` → 443, `http` → 80, against
localhost.

Options:

- `-p, --port <port>`: Local port to bind (default: random in 50000–51000)
- `--no-open`: Do not open the browser automatically (http only)

Examples:

```bash
# TCP proxy to SSH
thinr device tcp RevPi20679 22

# HTTP proxy to a specific port
thinr device http RevPi20679 8080

# HTTP proxy to a specific address behind the device
thinr device http RevPi20679 http://192.168.1.45:8080
```

#### `status`

```bash
thinr device status <deviceId> [-j, --json]
```

Returns the device's connection stats (uptime, tx/rx, last-seen).

#### `property`

List every property of a device, or read one by id:

```bash
thinr device property <deviceId>                                # list
thinr device property <deviceId> <propertyId> [options]         # read
```

Options:

- `-j, --json`: Output as JSON
- `-f, --field <path>`: Extract a sub-field via dot path (`-f data.value`)

#### `resource`

List the resources exposed by the device (with their `in`/`out`
schemas when advertised), or call one:

```bash
thinr device resource <deviceId>                                # list
thinr device resource <deviceId> <resourceId> [options]         # call
```

Options:

- `-i, --input <key=value>`: Resource input (repeatable)
- `-j, --json`: Output as JSON
- `-f, --field <path>`: Extract a sub-field from the result (dot path)

#### `exec`

Run a shell command on the device and stream stdout/stderr back:

```bash
thinr device exec <deviceId> "<command>" [options]
```

Options:

- `-j, --json`: Buffer output and emit a single envelope
  `{stdout, stderr, exitCode}` on exit
- `--legacy`: Use the non-streaming one-shot API (older agents)

The process exits with the remote command's exit code.

#### `update`

Check for or apply an agent update on the device:

```bash
thinr device update check <deviceId> [options]
thinr device update apply <deviceId> [options]
```

Options:

- `--channel <name>`: Update channel (default: `latest`)
- `-j, --json`: Output as JSON

### `thinr product <action> <productId>`

Fan out an operation across every device that belongs to a product.

#### `property`

```bash
thinr product property <productId> <propertyId> [options]
```

Options:

- `-j, --json`: Output as JSON. Emits one envelope with a `results[]`
  array, one entry per device, each with its own `ok` flag.
- `-f, --field <path>`: Extract a sub-field from each property (dot path)
- `-a, --all`: Include offline devices (default: only active)
- `-g, --group <group>`: Filter devices by asset group

#### `resource`

```bash
thinr product resource <productId> <resource> [options]
```

Options:

- `-j, --json`: Output as JSON (`results[]` array, same shape as above)
- `-f, --field <path>`: Extract a sub-field from each result (dot path)
- `-g, --group <group>`: Filter devices by asset group
- `-i, --input <key=value>`: Resource input (repeatable)

Offline devices are skipped for `resource` — the server would reject
the call anyway.

### `thinr profile`

Manage the profile store (see [Profiles and multi-account
use](#profiles-and-multi-account-use)):

```bash
thinr profile list          [--json]
thinr profile current       [--json]
thinr profile use    <name> [--json]
thinr profile delete <name> [--json]
```

### `thinr logout`

Remove the active profile's credentials and config:

```bash
thinr logout
```

Other profiles are left untouched.

---

## Part 2 — MCP server

`thinr` ships an [MCP][mcp] server that exposes the CLI's device
operations as a set of typed tools. AI clients (Claude Code, Claude
Desktop, and any other MCP-compatible host) can then list devices,
run shell commands, read/write files, call resources, and manage
products through the same API the CLI uses — with stable schemas and
a consistent error contract.

### Starting the server

```bash
thinr mcp [-d, --device <deviceId>]
```

The server speaks [MCP over stdio][mcp-stdio]. `-d/--device` sets a
default device that tools can omit in each call; `--user` can be
passed through (via the global flag) to impersonate another account.

[mcp-stdio]: https://modelcontextprotocol.io/specification/server/transport#stdio

### Tool catalog

Roughly 28 tools, grouped by capability. Every tool accepts optional
`device`, `user`, and `profile` arguments, so a single session can
target any device/account/environment without restart.

| Area | Tools |
| --- | --- |
| Discovery | `thinr_devices` (with optional `query` for regex filtering), `thinr_device_info`, `thinr_profiles` |
| Shell | `thinr_exec` (buffered), with streaming stdout/stderr |
| Filesystem | `thinr_read`, `thinr_write`, `thinr_ls`, `thinr_mkdir`, `thinr_delete`, `thinr_move` |
| Resources | `thinr_resource_list` (with `in`/`out` schemas), `thinr_resource_call` |
| Properties | `thinr_property_get`, `thinr_property_set` |
| Scripts (device) | `thinr_script_list`, `thinr_script_write`, `thinr_script_delete` |
| Monitoring and update | `thinr_monitoring`, `thinr_update` |
| Products | `thinr_products`, `thinr_product_delete`, `thinr_device_set_product` |
| Product scripts | `thinr_product_script_list`, `thinr_product_script_read`, `thinr_product_script_write`, `thinr_product_script_delete` |

Full input/output schemas are published via standard MCP
`list_tools`; the client will show them when you connect.

### Per-call controls

The server starts with no per-session pin: every tool call must say
which device it's for, and may optionally override the account or
profile for that single call.

- **`device`** — required for any device-scoped tool. Use
  `thinr_devices` (optionally with `query` to filter by regex) to
  discover ids.
- **`user`** — optional admin impersonation; falls back to the
  authenticated user of the active profile.
- **`profile`** — optional. Switches the active profile for that
  single tool call so an agent can hop between prod and staging
  without restarting the server. List the configured profiles with
  `thinr_profiles`.

### Integrating with Claude Code

Register the server once with the Claude Code CLI:

```bash
claude mcp add thinr -s user -- thinr mcp
```

That's it — a single MCP server entry handles every device of the
active profile. Tool calls pass `device` (and optionally `user` /
`profile`) per call.

Other MCP hosts follow the same pattern — they just need the command
`thinr mcp` (optionally with `-d <deviceId>`) over stdio.

---

## Profiles and multi-account use

`~/.config/thinr-cli/config.json` stores any number of profiles:

```json
{
  "default": "perf.aws.thinger.io",
  "profiles": {
    "perf.aws.thinger.io": { "server": "...", "username": "...", "token": "..." },
    "staging.local":       { "server": "...", "username": "...", "token": "..." }
  }
}
```

The active profile is picked, in order:

1. `--profile <name>` flag on the command line.
2. `THINR_PROFILE` environment variable.
3. The `default` field in the config file.
4. The sole profile, if there's only one.

Logging in to a new server creates a new profile whose name is the
server hostname (so it never clobbers an existing one). Legacy
single-profile files from older versions of the CLI are detected on
read and migrated in-memory without a manual step.

Use `thinr profile use <name>` to change the persisted default, or
`--profile <name>` / `THINR_PROFILE=<name>` for one-off runs.

## Development

```
thinr-cli/
├── bin/           # CLI entry point (thinr)
├── commands/      # Commander subcommand modules
├── lib/           # Core: api, auth, config, device-api, errors,
│                  # output, mcp-server, proxy, console, …
├── package.json
└── README.md
```

Local development:

```bash
npm install
npm link            # makes `thinr` available on $PATH
node bin/thinr.js   # or run directly without linking
```

There are no automated tests yet — contributions welcome.

## License

<a href="http://opensource.org/">
  <img style="float: right;" width="100px" height="137px" src="https://opensource.org/wp-content/uploads/2009/06/OSI_Standard_Logo_0.svg">
</a>

Released under the [MIT License](http://opensource.org/licenses/MIT).

Copyright &copy; [Thinger.io](http://thinger.io)

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
