# ThinRemote: devices, agent and products

ThinRemote manages fleets of Linux machines (gateways, servers, edge boxes)
on a Thinger.io server. Each machine runs **thinr-agent**, which connects to
the server as a device and lets you operate it remotely: files, commands,
scripts, monitoring, logs. Everything else (products, buckets, properties,
tokens, alarms, dashboards) is the server's, reached with the generic
`thinr_resource_*` tools; read the server's `concepts` guide with
`thinr_doc_read` for those.

Tool names below omit the `thinr_` prefix.

## The device and its agent

A ThinRemote device is a Generic (IOTMP) device whose firmware is the agent.
The agent runs as an OS user (root for a system install), so what you can do
on the machine is what that user can do. `resource_get` with type `device`
adds what the agent reports when it is connected: `agent.system_info`
(hostname, OS, architecture, user…) and `agent.fs_base_path`. Check them
before assuming write access to system paths.

What the agent exposes, and the tool for each:

| Need                                             | Tool                                                                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Run a shell command                              | `device_exec` (stdout, stderr, exit code; `timeout` in s)                                                                  |
| Read / write / list / move / delete files        | `device_file_read`, `device_file_write`, `device_file_list`, `device_file_move`, `device_file_delete`, `device_dir_create` |
| Copy binaries or big files from/to this machine  | `device_files_push`, `device_files_pull`                                                                                   |
| CPU, memory, disk, network, load: now or history | `device_monitoring_get`                                                                                                    |
| A reusable, typed operation on one device        | `device_script_write` (see `thinremote-scripts`)                                                                           |
| Call what the agent or a script exposes          | `device_resource_list`, `device_resource_call`                                                                             |
| Update the agent                                 | `device_agent_update`                                                                                                      |
| Install the agent on a new machine               | `agent_install_get` (a shell one-liner)                                                                                    |

Paths are absolute on the device. `/` on its own lists the agent's working
directory (normally the root, reported as `fs_base_path`); nothing is
confined to it.

Built-in agent resources (`cmd`, `monitoring`, `system`, `update`, `agent`)
keep those names: a device script with one of them would hide the
real one, so `device_script_write` refuses it unless forced.

## Products: one configuration for a fleet

A product groups the devices of a fleet and holds what they share. ThinRemote
products are created with `resource_create` type `product` and come with
`config.type: "thinremote"` and a `monitoring` bucket that stores each
device's `monitoring` resource every 60 s (what `device_monitoring_get`
reads as history). On top of the server's product, ThinRemote keeps:

| Piece                                                                     | Where it lives                                                                       | Tools                                                           |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Product scripts: code run on any device of the product, kept in one place | file storage named like the product, `scripts/`; one product API resource per script | `product_script_*` (see `thinremote-scripts`)                   |
| Playbooks: ordered steps rolled out across devices                        | same storage, `playbooks/<name>.yaml`, indexed in the `playbooks` product property   | `product_playbook_*`, `playbook_*` (see `thinremote-playbooks`) |
| Metrics for thinr's terminal dashboard                                    | `dashboard_metrics` product property                                                 | `product_metric_*` (see `thinremote-metrics-logs`)              |
| Log sources for thinr (dashboard, `thinr device logs`)                    | `logs` product property                                                              | `product_logs_*` (see `thinremote-metrics-logs`)                |

Deleting a product with `resource_delete` also deletes its file storage (its
scripts and playbooks).

Devices join a product when they are created with `product`, with
`resource_update` (`{"product": "<id>"}`), or by autoprovisioning (type
`product_profile_autoprovision`).

## Fleet operations

| Need                                       | Tool                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| Same command on every device, once         | `product_exec` (parallel, per-device result, `concurrency`, `fail_fast`)          |
| Same file on every device                  | `product_write`                                                                   |
| A repeatable, versioned change with checks | a playbook: `product_playbook_run` on one device, then `product_playbook_rollout` |
| A value from every device                  | a product script + `device_resource_call` per device, or a metric                 |
| Which devices are online                   | `resource_list` type `device` with `filter: {"product": "<id>"}`                  |
| Fleet health at a glance                   | `device_monitoring_get` without `device` (one row per device)                     |

Offline devices are skipped by fleet tools unless asked (`all` /
`include_offline`).

## Recipes

**Bring a new machine in.** `resource_create` type `product` (if the fleet
has none) → `agent_install_get` → run the command on the machine → the
device appears (autoprovisioned or created) → `resource_update` its
`product` if needed → `resource_get` to confirm `agent.system_info`.

**Expose a health check for the whole fleet.** Write it once as a product
script (`product_script_write`, output-only, JSON on stdout) → call it on a
device with `device_resource_call` to check it → register a metric over it
(`product_metric_write`) so thinr's dashboard aggregates it across the
fleet.

**Change a config file on every machine, safely.** Write a playbook
(`playbook_describe` → draft → `playbook_validate`) that writes the file and
restarts the service → `product_playbook_write` → `product_playbook_run` on
one device with `check: true`, then for real → `product_playbook_rollout`
with a small `batch_size`.

**Investigate one machine.** `resource_get` (agent info) →
`device_monitoring_get` (`realtime: true`) → `device_exec` for specifics →
`device_file_read` for log files, or the product's log sources with
`thinr device logs`.
