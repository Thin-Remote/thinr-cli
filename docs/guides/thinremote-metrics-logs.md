# ThinRemote fleet metrics and log sources

Two per-product settings for operating a fleet from **thinr**: the metrics
its terminal dashboard (`thinr` with no arguments) shows for a product, and
the log sources an operator can stream from a device (in that dashboard or
with `thinr device logs`). Today only thinr reads them; they are not the web
console's dashboards (for those, see the server's `dashboard-sdk` guide and
the `dashboard` action `publish`). Both live on the server as product
properties (type `product_property`, ids `{"product", "property"}`), so the
devices need nothing and other clients could reuse them. Each is written
whole: read it, change it, `resource_update` it with the whole `value`
(not with `merge`). It is checked before it is saved, and
`resource_describe` type `product_property` shows both shapes.

Tool names below omit the `thinr_` prefix.

## Metrics

A metric is a value thinr's dashboard asks every device of the product for,
and combines across the fleet: free disk, connected clients, service version…
They live in the `dashboard_metrics` product property, an array of
metrics with unique names (create the property with the first one).

Fields of a metric:

| Field           | Meaning                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| `name`          | Stable id (letters, digits, `_`, `-`), unique in the array                                               |
| `label`         | Title in the panel                                                                                       |
| `resource`      | Product API resource called on each device, usually a product script                                     |
| `field`         | Dot path to the value in the response (`disk.used_pct`); omit for scalar responses                       |
| `aggregation`   | `sum`, `avg`, `max`, `min` (numeric), `count` (devices reporting a value), `top`, `distribution`, `none` |
| `visualization` | `kpi` (default: value and its age), `sparkline` (value and recent trend), `bar`, `list`                  |
| `interval`      | Refresh in seconds (≥ 1); 0 or omitted relays only what devices push                                     |
| `unit`          | Display suffix (`%`, `devices`)                                                                          |

Recipe: write a product script that prints the value as JSON (see
`thinremote-scripts`), check it with the `device_resource` action `call` on
one device, then add the metric pointing at the script's resource name.

## Log sources

A log source is a named shell command the agent streams when an operator
opens a device's logs in thinr (`journalctl -f`, `docker logs -f app`,
`tail -F /var/log/nginx/access.log`). They live in the `logs` product
property; without it, products show a single `system` source running
journalctl. Its value is `{"sources": [...], "default"?: "<name>"}`.

- A source has a `name` (≤ 32 chars, letters, digits, `_`, `-`; unique; up
  to 32 sources) and a `command`, stored and run as is. `default` names the
  one shown first (and the one `thinr device logs` uses without
  `--source`).
- Structured rendering: add a `preset` (`resource_describe` type
  `product_property` lists them: journalctl, spdlog, nginx…) or your own
  `pattern`, a regex with named groups `time`, `level` and `msg`. With a
  `level` group, operators can filter by severity. `preset` and `pattern`
  are mutually exclusive.
- Deleting the property (`resource_delete`) brings back the fallback.
