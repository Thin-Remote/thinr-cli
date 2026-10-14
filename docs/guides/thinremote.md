# ThinRemote: devices, agent and products

ThinRemote manages fleets of machines (gateways, servers, edge boxes) on a
Thinger.io server. Each machine runs **thinr-agent**, which connects to the
server as a device and lets you operate it remotely: files, commands,
scripts, monitoring, logs.

Almost everything is a **resource type** behind the generic tools
`resource_list` / `_get` / `_create` / `_update` / `_delete` and
`resource_call` (its actions), described by `resource_describe`: the
server's types (device, product, bucket, property, token, alarm…; read the
server's `concepts` guide with `doc_read`) and ThinRemote's, below. The one
tool of its own is `device_exec`, for shell commands.

Tool names below omit the `thinr_` prefix.

## The device and its agent

A ThinRemote device is a Generic (IOTMP) device whose firmware is the agent.
The agent runs as an OS user (root for a system install), so what you can do
on the machine is what that user can do. `resource_get` with type `device`
adds what the agent reports when it is connected: `agent.system_info`
(hostname, OS, architecture, user…), `agent.fs_base_path`, and `agent.where`,
a map of where everything below is. Check them before assuming write access
to system paths.

What the agent offers, and how to reach it:

| Need                                        | How                                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Run a shell command                         | `device_exec` with `device` (output and exit code; `timeout` in s)                                                              |
| List a folder                               | `resource_list` type `device_fs`, parent the device, `filter: {"path": "/var/log"}`                                             |
| Read a file                                 | `resource_get` type `device_fs`, parent the device, id the path                                                                 |
| Write a file / create a folder              | `resource_create` (or `_update`) type `device_fs`, body `{"content": "…"}` / `{"type": "directory"}`                            |
| Delete a file or folder                     | `resource_delete` type `device_fs`                                                                                              |
| Move, or copy binaries from/to this machine | `resource_call` type `device_fs`, action `move`, `push` or `pull`                                                               |
| CPU, memory, disk, network, load: now       | `device_resource_call` resource `monitoring`                                                                                    |
| The same, as history                        | `bucket_data_read` bucket `monitoring` with `device` (fields such as `cpu.usage`, `memory.usage`, `disk.root.usage`, `load.1m`) |
| A reusable, typed operation on one device   | type `device_script` (see `thinremote-scripts`)                                                                                 |
| Call what the agent or a script exposes     | `device_resource_list`, `device_resource_call`                                                                                  |
| Update the agent                            | `resource_call` type `device`, action `agent_update`, body `{"action": "check"}` or `{"action": "apply"}`                       |
| Install the agent on a new machine          | `resource_call` type `device`, action `agent_install` (a shell one-liner; no id)                                                |

Paths are absolute on the device. `/` on its own lists the agent's working
directory (normally the root, reported as `fs_base_path`); nothing is
confined to it.

Built-in agent resources (`cmd`, `monitoring`, `system`, `update`, `agent`)
keep those names: a device script with one of them would hide the real one,
so creating it is refused unless forced.

## Products: one configuration for a fleet

A product groups the devices of a fleet and holds what they share. ThinRemote
products are created with `resource_create` type `product` and come with
`config.type: "thinremote"` and a `monitoring` bucket that stores each
device's `monitoring` resource every 60 s (the history above; a device of
another kind of product has no history unless its product gets that bucket). On top of the
server's product, ThinRemote keeps these types, all with the product as
parent:

| Type                 | What it is                                                                    | Where it lives                                                             | Guide                     |
| -------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------- |
| `product_script`     | Code run on any device of the product, kept in one place                      | file storage named like the product, `scripts/`; one product API resource  | `thinremote-scripts`      |
| `product_playbook`   | Ordered steps rolled out across devices; actions `validate`, `run`, `rollout` | same storage, `playbooks/<name>.yaml`, indexed in the `playbooks` property | `thinremote-playbooks`    |
| `product_metric`     | Metrics for thinr's terminal dashboard                                        | `dashboard_metrics` product property                                       | `thinremote-metrics-logs` |
| `product_log_source` | Log sources for thinr (dashboard, `thinr device logs`)                        | `logs` product property                                                    | `thinremote-metrics-logs` |

Creating one that already exists fails (update it instead), and updating one
that does not exist fails too, as with the server's types.

Deleting a product with `resource_delete` also deletes its file storage (its
scripts and playbooks).

Devices join a product when they are created with `product`, with
`resource_update` (`{"product": "<id>"}`), or by autoprovisioning (type
`product_profile_autoprovision`).

## Fleet operations

| Need                                       | How                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Same command on many devices, once         | `device_exec` with `devices`, `product` (and `group`) or `all: true`; `dry_run` lists the targets first |
| Same file on every device                  | a playbook with a `write` step (to a temporary file, then `move`), rolled out                           |
| A repeatable, versioned change with checks | a playbook: action `run` on one device, then action `rollout`                                           |
| A value from every device                  | a product script + `device_resource_call` per device, or a metric                                       |
| Which devices are online                   | `resource_list` type `device` with `filter: {"product": "<id>"}`                                        |
| Fleet health at a glance                   | `bucket_data_read` bucket `monitoring` without `device`, `group_by` device                              |

Offline devices are skipped unless asked (`include_offline`). Commands on
several devices and rollouts act at once: confirm with the user first.

## Recipes

**Bring a new machine in.** `resource_create` type `product` (if the fleet
has none) → `resource_call` type `device` action `agent_install` → run the
command on the machine → the device appears (autoprovisioned or created) →
`resource_update` its `product` if needed → `resource_get` to confirm
`agent.system_info`.

**Expose a health check for the whole fleet.** Write it once as a product
script (`resource_create` type `product_script`, output-only, JSON on
stdout) → call it on a device with `device_resource_call` to check it →
register a metric over it (`resource_create` type `product_metric`) so
thinr's dashboard aggregates it across the fleet.

**Change a config file on every machine, safely.** `resource_describe` type
`product_playbook` (the format) → draft a playbook that writes the file and
restarts the service → action `validate` → `resource_create` to save it →
action `run` on one device with `check: true`, then for real → action
`rollout` with a small `batch_size`.

**Investigate one machine.** `resource_get` type `device` (agent info) →
`device_resource_call` resource `monitoring` → `device_exec` for specifics →
`resource_get` type `device_fs` for log files, or the product's log sources
with `thinr device logs`.
