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
  exposes the same operations as eight resource tools for AI clients like
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
    - [`thinr device`](#thinr-device)
    - [`thinr product`](#thinr-product)
    - [`thinr agent`](#thinr-agent)
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

Every command follows one grammar, shared with the `thinger` CLI: nouns
first, then a verb, then the ids from the outermost to the innermost, then
the options (`thinr device property get <device> <property>`). Records
take the same verbs everywhere (`list`, `get`, `create`, `update`,
`delete`, `clone`, `set`, `describe`), a body comes from `--from <file>`
and `-s, --set key=value`, and `-j, --json` gives the JSON envelope below.
`thinr --help` lists the nouns; `thinr <noun> --help` their verbs.

```
thinr device <verb> <device> [args…] [options]
thinr product <verb> <product> [args…] [options]
thinr device property <verb> <device> <property> [options]
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

### `thinr device`

Most verbs take a `<device>` as their first positional; `list` works on
the whole account.

#### `list`

List every device visible to the active profile, or search and filter
them on the server:

```bash
thinr device list                              # every device
thinr device list --search supermicro          # ids/names containing "supermicro"
thinr device list --filter product=my-product  # filters are repeatable
thinr device list --json                       # JSON envelope with the raw API records
```

Combine with the global `-u, --user` flag for admin impersonation.

#### Records — `get` / `create` / `update` / `delete` / `set-product`

```bash
thinr device get <device>                          # server record as JSON (-f <path> for one field)
thinr device create <device> [-t Generic|MQTT|HTTP|Virtual|Subdevice] [-p product] [-n name]
thinr device update <device> -s name="Boiler 1"
thinr device delete <device> [-y]
thinr device set-product <device> <product>        # "" to unassign
```

`create` generates random credentials for Generic/MQTT devices unless
`-c` is given; they are shown once.

#### `console`

Open an interactive terminal on the device:

```bash
thinr device console <device>
```

#### Proxies — `tcp` / `tls` / `http`

Create a TCP, TLS, or HTTP proxy to a remote endpoint reachable from
the device:

```bash
thinr device tcp  <device> [target] [options]
thinr device tls  <device> [target] [options]
thinr device http <device> [target] [options]
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
thinr device status <device> [-j, --json]
```

Returns the device's connection stats (uptime, tx/rx, last-seen).

#### `property`

The properties of a device are records of their own:

```bash
thinr device property list <device>
thinr device property get  <device> <property> [-f value.threshold]
thinr device property set  <device> <property> '{"threshold": 30}'   # created when missing
thinr device property delete <device> <property> [-y]
```

`-f, --field <path>` prints one field of the record: the value of a
property is under `value`.

#### `resource`

List the resources exposed by the device (with their `in`/`out`
schemas when advertised), or call one:

```bash
thinr device resource list <device>
thinr device resource call <device> <resource>                 # read its output
thinr device resource call <device> <resource> -s value=true   # run it with an input
```

`call` takes the input from `--from <file>` (`-` for stdin) and
`-s, --set key=value` (repeatable, values parsed as JSON when they are),
and prints the answer, or one field of it with `-f, --field <path>`.

#### `exec`

Run a shell command on the device and stream stdout/stderr back:

```bash
thinr device exec <device> "<command>" [options]
```

Options:

- `-j, --json`: Buffer output and emit a single envelope
  `{stdout, stderr, exitCode}` on exit
- `--legacy`: Use the non-streaming one-shot API (older agents)

The process exits with the remote command's exit code.

### `thinr product`

Besides its records (`list`, `get`, `create`, `update`, `delete`,
`export`, `apply`, `profile`…), a product fans operations out across
every device that belongs to it.

#### `device-property`

Read a property on every device of the product:

```bash
thinr product device-property <product> <property> [options]
```

Options:

- `-j, --json`: Output as JSON. Emits one envelope with a `results[]`
  array, one entry per device, each with its own `ok` flag.
- `-f, --field <path>`: Extract a sub-field from each property (dot path)
- `-a, --all`: Include offline devices (default: only active)
- `-g, --group <group>`: Filter devices by asset group

#### `device-resource`

Call a resource on every active device of the product:

```bash
thinr product device-resource <product> <resource> [options]
```

Options:

- `-j, --json`: Output as JSON (`results[]` array, same shape as above)
- `-f, --field <path>`: Extract a sub-field from each result (dot path)
- `-g, --group <group>`: Filter devices by asset group
- `--from <file>`, `-s, --set <key=value>`: Resource input (`-s` is
  repeatable)

Offline devices are skipped for `device-resource` — the server would
reject the call anyway.

#### `metric` and `logs`

What thinr's terminal dashboard shows for the devices of a product:

```bash
thinr product metric list   <product>
thinr product metric set    <product> <name> [options]
thinr product metric delete <product> <name> [-y]

thinr product logs presets                         # patterns shipped with thinr
thinr product logs list        <product>
thinr product logs get         <product> <name>
thinr product logs create      <product> <name> [options]
thinr product logs delete      <product> <name> [-y]
thinr product logs set-default <product> <name>
```

#### `exec`

Run a shell command in parallel across every active device of the
product and report a per-device status table plus each device's
output:

```bash
thinr product exec <product> <command...> [options]
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

Also exposed to MCP clients as the `exec` action of type `device` with
body `product` (and `group`), so agents run a fleet operation with a
single call instead of looping per device.

#### `playbook`

Manage playbooks stored on a product and run them against one device
or the whole fleet:

```bash
thinr product playbook list     <product> [--json]
thinr product playbook upload   <product> <name> [file] [--description <text>] [--skip-validation] [--json]
thinr product playbook download <product> <name> [-o <file>] [--json]
thinr product playbook delete   <product> <name> [-y] [--json]
thinr product playbook run      <product> <name> (--device <id> | --fleet) [options]
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

### `thinr agent`

The ThinRemote agent running on the devices: check whether a device has a
newer release, and update one device or the whole fleet.

```bash
thinr agent check  <device> [--channel latest] [-j]
thinr agent update <device> [--channel latest] [-j]
thinr agent update --all [-p <product>] [-g <group>] [options]
```

`update --all` updates every outdated device: a canary first, then in
batches. Options (only with `--all`):

- `-p, --product <id>`, `-g, --group <id>` — narrow the fleet.
- `--batch-size <n>` — devices updated in parallel once the canary
  passes (default: 5).
- `--no-canary` — everything in batches from the start.
- `--continue-on-error` — keep rolling after a batch failure.
- `--dry-run` — list what would be updated, without updating it.
- `-y, --yes` — no confirmation (required in non-interactive shells).

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
Desktop, Cursor and any other MCP host): eight tools that reach everything the
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
with the `thinger` CLI, and serves its eight tools with the `thinr_`
prefix: `thinr_resource_describe`, `_list`, `_get`, `_create`, `_update`,
`_delete`, `_clone` and `_call` (actions). Each takes a `type` and the
record's `ids`, one key per level (`{"device": "gw_1"}`,
`{"device": "gw_1", "path": "/etc/hosts"}`,
`{"product": "gateways", "playbook": "app-config"}`); the records they
answer carry their ids.

| Types                                                                  | What for                                                                                                                                                                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The server's (`device`, `product`, `bucket`, `token`, `alarm_rule`…)   | Every resource of the account and their actions                                                                                                                                                                     |
| `device_resource` (list; action `call`)                                | What a connected device exposes: agent resources (`monitoring`, `cmd`…) and its scripts                                                                                                                             |
| `bucket_data` (list reads, create writes)                              | Time series, monitoring history included (bucket `monitoring`)                                                                                                                                                      |
| `storage_file`; `dashboard` actions `init` / `dev` / `publish`; others | Storages, web dashboards (create, develop against the server, publish), plugins (`plugin` `call`), product APIs (`product_profile_api` `call`), HTTP devices (`device` `send`), account usage (`device` `overview`) |
| `doc`, `profile`                                                       | Guides for agents (`thinremote`, `thinremote-scripts`, `thinremote-playbooks`, `thinremote-metrics-logs`, and the platform's: `concepts`, `product-code`, `server-admin`, `dashboard-sdk`) and profiles             |

ThinRemote adds its own resource types, listed, read, written and deleted
like a device or a token:

| Type               | ids                   | What it is                                                                     | Actions (`thinr_resource_call`) |
| ------------------ | --------------------- | ------------------------------------------------------------------------------ | ------------------------------- |
| `device_fs`        | `device`, `path`      | Files and folders of the device                                                | `move`, `push`, `pull`          |
| `device_script`    | `device`, `script`    | Scripts of the agent, each a resource of the device                            |                                 |
| `product_script`   | `product`, `script`   | Scripts run on any device of the product, kept once in its storage             |                                 |
| `product_playbook` | `product`, `playbook` | Playbooks: YAML steps validated, tried on one device and rolled out in batches | `validate`, `run`, `rollout`    |

and three actions to the server's `device` type: `exec` (a shell command
on one device, `ids.device`, or on several at once: body `devices`,
`product`, `group`, `all`), `agent_update` (check for or install a new
agent) and `agent_install` (the command that installs the agent on a new
machine). Live monitoring is the device resource `monitoring`; its
history, the bucket `monitoring`. The fleet metrics and log sources of
thinr's terminal dashboard are the product properties `dashboard_metrics`
and `logs`, checked before they are written.

`exec` on several devices, playbook runs on several devices and rollouts
answer their targets first and run with `confirm: true` (clients that
support elicitation ask the user instead). `thinr mcp --read-only` (or
`THINR_MCP_READ_ONLY=1`) serves only what reads. Full input schemas come
with the standard MCP `tools/list`, and `thinr_resource_describe` gives
each type's ids, fields, actions and examples.

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
3. **Save.** `thinr_resource_create` type `product_playbook`, ids
   `{"product", "playbook": <a short name>}`, body `{content}`. It is
   validated again and nothing is saved if invalid.
4. **Pre-flight on one device.** Action `run` with `ids.playbook` and
   `body.device`, with `dry_run: true` or `check: true` for a read-only
   preview, then for real.
5. **Roll out.** Action `rollout` runs it across the fleet in batches with a
   failure-rate stop, and writes a report to `playbooks/runs/` in the
   product storage. It answers its plan first and runs with
   `confirm: true` once the user agrees.

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
  that call only; `thinr_resource_list` type `profile` lists them.
- **`user`**: optional admin impersonation; defaults to the profile's user.
- Devices are named per call (`ids.device`): list them with
  `thinr_resource_list` type `device`.

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
├── commands/      # ThinRemote subcommands (agent, device, product, playbooks…)
├── lib/           # ThinRemote modules: identity, device-api, proxy,
│                  # console, playbooks, product scripts, MCP tools…
├── package.json
└── README.md
```

The generic part — API client, auth, profiles, REST helpers, the command
grammar, the generic commands (login, logout, profile, api, the records of
every resource type, device resource, bucket, storage…) and the generic MCP
tools — comes from
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
through the MCP `thinr_resource_delete` tool with type `product` (from an AI client) or
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
