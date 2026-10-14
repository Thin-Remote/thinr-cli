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
  exposes the same operations as 24 typed tools for AI clients like
  Claude Code, Claude Desktop and Cursor.

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
    - [`thinr playbook <action>`](#thinr-playbook-action)
    - [`thinr profile`](#thinr-profile)
    - [`thinr logout`](#thinr-logout)
- [Part 2 — MCP server](#part-2--mcp-server)
    - [Starting the server](#starting-the-server)
    - [Tool catalog](#tool-catalog)
    - [Authoring playbooks from natural language](#authoring-playbooks-from-natural-language)
    - [Per-call controls](#per-call-controls)
    - [Integrating with Claude Code](#integrating-with-claude-code)
    - [Integrating with Claude Desktop, Cursor and other MCP hosts](#integrating-with-claude-desktop-cursor-and-other-mcp-hosts)
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

Requires Node.js ≥ 18.

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

| Flag                | Env var            | Meaning                                                                                                                                                            |
| ------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--profile <name>`  | `THINR_PROFILE`    | Use a non-default profile for this invocation.                                                                                                                     |
| `-u, --user <name>` | —                  | Admin impersonation: act on behalf of another user (requires admin privileges on the server).                                                                      |
| —                   | `THINR_INSECURE=1` | Accept self-signed TLS certificates globally. Localhost / 127.0.0.1 are always accepted; this flag extends the relaxation to any host, useful for LAN dev servers. |

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

| code             | meaning                                           |
| ---------------- | ------------------------------------------------- |
| `not_configured` | CLI has no saved profile — run `thinr` to set up. |
| `not_found`      | Device, property, resource or profile not found.  |
| `unauthorized`   | Token expired or insufficient permissions.        |
| `server_error`   | Non-success HTTP response from the server.        |
| `network_error`  | No response from the server.                      |
| `input_error`    | Bad or missing CLI argument.                      |
| `timeout`        | Command timed out on the device (`exec`).         |
| `cancelled`      | User interrupted with Ctrl+C (`exec`).            |
| `error`          | Fallback for anything uncategorised.              |

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

#### Records — `info` / `create` / `delete` / `set-product`

```bash
thinr device info <deviceId>                       # server record as JSON
thinr device create <deviceId> [-t Generic|MQTT|HTTP|Virtual|Subdevice] [-p product]
thinr device delete <deviceId> [-y]
thinr device set-product <deviceId> <productId>    # "" to unassign
thinr device property-set <deviceId> <property> <json>
```

`create` generates random credentials for Generic/MQTT devices unless
`-c` is given; they are shown once.

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

#### `exec`

Run a shell command in parallel across every active device of the
product and report a per-device status table plus each device's
output:

```bash
thinr product exec <productId> <command...> [options]
```

Options:

- `-j, --json`: Output as JSON. Emits a single envelope with a
  `summary` block and a `results[]` array carrying stdout, stderr,
  exit code, `timedOut` flag and per-device duration.
- `-c, --concurrency <n>`: Max parallel executions (default: 10)
- `--timeout <seconds>`: Per-device timeout (default: 30)
- `--fail-fast`: Stop dequeueing new devices as soon as one fails
- `-g, --group <group>`: Filter devices by asset group
- `-a, --all`: Include offline devices (default: only active)

Examples:

```bash
# hostname on every active device
thinr product exec my-product hostname

# apt upgrade across the fleet with 5 parallel slots and a long timeout
thinr product exec my-product "apt-get -y upgrade" -c 5 --timeout 600

# target only a subset of the product
thinr product exec my-product "systemctl restart agent" -g staging
```

Also exposed to MCP clients as `thinr_device_exec` with `product` (and
`group`), so agents run a fleet operation with a single call instead of
looping per device.

#### `playbook`

Manage playbooks stored on a product and run them against one device
or the whole fleet:

```bash
thinr product playbook list     <productId> [--json]
thinr product playbook upload   <productId> <name> [file] [--description <text>] [--skip-validation] [--json]
thinr product playbook download <productId> <name> [-o <file>] [--json]
thinr product playbook delete   <productId> <name> [--json]
thinr product playbook run      <productId> <name> (--device <id> | --fleet) [options]
```

`upload` reads the YAML from a file, or from stdin when the path is
omitted or `-`. The document is validated against the playbook schema
before being written to the product storage; an invalid document is
rejected with a descriptive error and nothing is uploaded. Pass
`--skip-validation` only to work around a schema-runtime gap (do not
use it to bypass real errors).

`run` targets either a single device (`--device <id>`) or the whole
fleet (`--fleet`, progressive batch rollout):

- `-v, --var <key=value>` — override an overridable playbook variable
  (repeatable; values are coerced to the declared type).
- `--vars-file <path>` — load variable overrides from a YAML/JSON file.
- `--dry-run` — print the resolved plan without contacting any device.
- `--check` — contact devices read-only and report what each step would
  change.
- `--yes` / `-y` — skip the interactive confirmation prompt.

Fleet-only options:

- `--batch-size <n>` — devices attempted in parallel per batch
  (default: 5).
- `--failure-threshold <p>` — abort rollout when cumulative failure
  rate reaches P% (default: 25).
- `-g, --group <id>` — restrict to an asset group.
- `--filter <key=value>` — extra server-side filter (repeatable).
- `--include-offline` — attempt offline devices too (default: active
  only).

Each fleet rollout writes a persistent JSON report to
`playbooks/runs/<timestamp>-<name>-<user>.json` in the product's file
storage, capturing resolved variables, per-device outcomes, and any
abort reason.

### `thinr playbook <action>`

Run or validate a local playbook YAML file (not stored on a product).
Useful for one-shot or ad-hoc runs:

```bash
thinr playbook validate <file>
thinr playbook run      <file> [--dry-run] [--check] [options]
```

`validate` parses the YAML and reports any schema errors. `run`
resolves the target block declared inside the playbook and executes
it; the same variable-override flags as `thinr product playbook run`
apply. For playbooks that should be reusable across users, upload
them to their product with `thinr product playbook upload` instead.

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

Forget the active profile and revoke the API token `thinr` created for it
at a username/password login:

```bash
thinr logout                 # active profile (or --profile <name>)
thinr logout --all           # every profile
thinr logout --keep-token    # leave the token on the server
```

Other profiles are left untouched. `thinr login` re-authenticates the
active profile; `--server`, `--username` and `--token` skip the prompts.

---

## Part 2 — MCP server

`thinr` ships an [MCP][mcp] server for AI clients (Claude Code, Claude
Desktop, Cursor and any other MCP host): 24 tools that reach everything the
CLI does, through the same API, with stable schemas and one error contract.

### Starting the server

```bash
thinr mcp
```

The server speaks [MCP over stdio][mcp-stdio]. Every tool call carries its
own `profile` and `user` arguments, so a single running server handles any
device of any configured environment without a restart.

[mcp-stdio]: https://modelcontextprotocol.io/specification/server/transport#stdio

### Tools

thinr is built on [`@thinger-io/cli-core`][cli-core], the core it shares
with the `thinger` CLI, and serves its 23 generic tools with the `thinr_`
prefix plus one of its own:

| Tools                                                                                                                                                    | What for                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `thinr_resource_describe`, `_list`, `_get`, `_create`, `_update`, `_delete`, `_clone`, `_call`                                                           | Every resource type: the server's and ThinRemote's (below), and their actions                                          |
| `thinr_device_resource_list`, `thinr_device_resource_call`                                                                                               | What a connected device exposes: agent resources (`monitoring`, `cmd`…) and its scripts                                |
| `thinr_bucket_data_read`, `thinr_bucket_data_write`                                                                                                      | Time series, monitoring history included (bucket `monitoring`)                                                         |
| `thinr_storage_file_*`, `thinr_dashboard_publish`, `thinr_plugin_call`, `thinr_product_resource_call`, `thinr_device_data_send`, `thinr_device_overview` | Storages, web dashboards, plugins, product APIs, HTTP devices, account usage                                           |
| `thinr_doc_read`, `thinr_profile_list`                                                                                                                   | Guides for agents (`thinremote`, `thinremote-scripts`, `thinremote-playbooks`, `thinremote-metrics-logs`) and profiles |
| `thinr_device_exec`                                                                                                                                      | A shell command on one device, or on several at once (`devices`, `product`, `group`, `all`)                            |

ThinRemote adds its own resource types to the generic tools, so they are
listed, read, written and deleted like a device or a token:

| Type                 | Parent  | What it is                                                                     | Actions (`thinr_resource_call`) |
| -------------------- | ------- | ------------------------------------------------------------------------------ | ------------------------------- |
| `device_fs`          | device  | Files and folders of the device (id: the path)                                 | `move`, `push`, `pull`          |
| `device_script`      | device  | Scripts of the agent, each a resource of the device                            |                                 |
| `product_script`     | product | Scripts run on any device of the product, kept once in its storage             |                                 |
| `product_metric`     | product | Metrics of thinr's terminal dashboard                                          |                                 |
| `product_log_source` | product | Log sources an operator streams from a device                                  |                                 |
| `product_playbook`   | product | Playbooks: YAML steps validated, tried on one device and rolled out in batches | `validate`, `run`, `rollout`    |

and two actions to the server's `device` type: `agent_update` (check for or
install a new agent) and `agent_install` (the command that installs the
agent on a new machine). Live monitoring is the device resource
`monitoring`; its history, the bucket `monitoring`.

Full input schemas come with the standard MCP `tools/list`, and
`thinr_resource_describe` gives each type's fields and actions.

[cli-core]: https://github.com/thinger-io/thinger-cli-core

### Authoring playbooks from natural language

Playbooks are YAML documents with ordered steps (`exec`, `write`, `move`,
`delete`, `script_install`…), a `target` and `vars`, that the agent applies
on each device. With the MCP server connected, an assistant can turn a
request into a validated playbook stored on the product, without anyone
writing YAML by hand:

1. **Read the format.** `thinr_resource_describe` type `product_playbook`:
   its `playbook_format` lists the document fields, the target, the two
   forms of `vars` (plain and extended) and every step action.
2. **Draft and validate.** Write the YAML and call `thinr_resource_call`
   type `product_playbook`, action `validate`, with it in `body.content`;
   fix what it reports until it is clean.
3. **Save.** `thinr_resource_create` type `product_playbook`, parent the
   product, id a short name, body `{content}`. It is validated again and
   nothing is saved if invalid.
4. **Pre-flight on one device.** Action `run` with the playbook's id and
   `body.device`, with `dry_run: true` or `check: true` for a read-only
   preview, then for real.
5. **Roll out.** Action `rollout` runs it across the fleet in batches with a
   failure-rate stop, and writes a report to `playbooks/runs/` in the
   product storage.

Example prompt:

> "On product `edge-gateways`, create a playbook called `nginx-upgrade`
> that updates the nginx package, renders `/etc/nginx/nginx.conf` from a
> template, and restarts nginx only if the config check passes. Make
> `worker_connections` an overridable integer variable, default 1024. Then
> try it on `edge-gw-17` in check mode."

A second message like "looks good, roll it out to staging" maps to the
`rollout` action with `group` and a conservative `batch_size`.

### Per-call controls

- **`profile`**: optional on every tool. Uses another configured server for
  that call only; `thinr_profile_list` lists them.
- **`user`**: optional admin impersonation; defaults to the profile's user.
- Devices are named per call (`device`, or `parent` for a device's
  resources): list them with `thinr_resource_list` type `device`.

### Integrating with Claude Code

Register the server once with the Claude Code CLI:

```bash
claude mcp add thinr -s user -- thinr mcp
```

That's it: a single MCP server entry handles every device of every
configured profile.

### Integrating with Claude Desktop, Cursor and other MCP hosts

Other MCP hosts use a JSON config file (`claude_desktop_config.json`,
`.cursor/mcp.json`, etc.). The entry shape is the same on every host:

```json
{
    "mcpServers": {
        "thinr": {
            "command": "thinr",
            "args": ["mcp"]
        }
    }
}
```

The `thinr` binary must be on `PATH` for the host to spawn it —
`npm install -g @thinremote/thinr-cli` puts it there. If the host
runs under a shell that doesn't load your global npm bin
(common on macOS GUI apps), point `command` at the absolute path
(`which thinr`) instead.

---

## Profiles and multi-account use

`~/.config/thinr-cli/config.json` stores any number of profiles:

```json
{
    "default": "perf.aws.thinger.io",
    "profiles": {
        "perf.aws.thinger.io": { "server": "...", "username": "...", "token": "..." },
        "staging.local": { "server": "...", "username": "...", "token": "..." }
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
├── commands/      # ThinRemote subcommands (agent, fleet, playbooks…)
├── lib/           # ThinRemote modules: identity, device-api, proxy,
│                  # console, playbooks, product scripts, MCP tools…
├── package.json
└── README.md
```

The generic part — API client, auth, profiles, REST helpers, the generic
commands (login, logout, profile, device list/info/property/resource,
product list/property-\_, bucket) and the generic MCP tools — comes from
[@thinger-io/cli-core](https://github.com/thinger-io/cli-core), shared
with the `thinger` CLI. `lib/identity.js` is what makes it `thinr`: names,
`~/.config/thinr-cli`, `THINR\__`, the OAuth client and the product
template.

Local development:

```bash
npm install
npm link            # makes `thinr` available on $PATH
node bin/thinr.js   # or run directly without linking
```

Unit tests live under `tests/` and run offline:

```bash
npm test
```

### Integration tests

The product-playbook end-to-end script at
[`tests/integration/playbook-e2e.js`](tests/integration/playbook-e2e.js)
drives a real ThinRemote cloud through the full playbook lifecycle
(create product → upload flat/extended/internal playbooks → list →
download → replace → reject invalid inputs → optionally run in
`check` mode against a device → delete). Cleanup of the temporary
product and its file storage is unconditional (`try / finally`),
even if the run fails halfway.

Prerequisites:

- An authenticated CLI profile (`thinr` once, or `THINR_PROFILE=<name>`
  pointing at an existing entry in `~/.config/thinr-cli/config.json`).
- The account must be allowed to create products and file storages.

Invocations:

```bash
# Offline checks only — parses fixtures, exercises resolveVarScope,
# asserts the dry-run plan. No network access. Safe in CI without
# credentials.
node tests/integration/playbook-e2e.js --offline

# Full flow against the active profile. Creates a throw-away product
# named "playbook-e2e-<timestamp>-<rand>" and deletes it on exit.
node tests/integration/playbook-e2e.js

# Add a test device to exercise `check`-mode execution with and
# without variable overrides. The device must belong to the active
# user; it does NOT need to be bound to the temporary product.
THINR_E2E_DEVICE=<device-id> node tests/integration/playbook-e2e.js
```

The script only touches resources it creates itself (identified by
the `playbook-e2e-` product-id prefix). If a run is interrupted
before the `finally` cleanup executes — e.g. the process is killed
— list leftovers with `thinr product list --json` and drop each one
through the MCP `thinr_product_delete` tool (from an AI client) or
via a Node one-liner reusing `deleteProductWithStorage` from
`lib/product.js`.

No credentials or tokens are ever written to the repository; the
script reads them from the standard CLI profile store.

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
