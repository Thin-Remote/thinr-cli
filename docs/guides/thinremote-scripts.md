# ThinRemote scripts

A script turns an operation (read a sensor, rotate a log, run a backup,
collect a health report) into a **resource**: something with a name and an
input/output shape that tools, dashboards and other devices can call. Use one
instead of `thinr_device_exec` whenever the operation will be repeated.

Tool names below omit the `thinr_` prefix.

## Device scripts or product scripts

| | Device script | Product script |
|---|---|---|
| Lives in | the device: `<agent base>/scripts/` | the product's file storage: `scripts/` |
| Reaches | that device | every device of the product, current and future |
| Changing it | one write per device | one write, effective on the next call everywhere |
| Tools | `device_script_list`, `device_script_write`, `device_script_delete` | `product_script_list`, `product_script_read`, `product_script_write`, `product_script_delete` |
| Called with | `device_resource_call` on that device | `device_resource_call` on any device of the product |

Prefer **product scripts** for fleets: the code is downloaded on each call,
so there is nothing to deploy and no drift between devices. Use a device
script for something specific to one machine.

The resource name is the file name without extension: `scripts/backup.sh` is
the resource `backup`. The extension is kept only for editor highlighting.

Scripts run with the agent's privileges, root for a system install:
installing one grants permanent remote execution of that code. Treat it like
adding a service.

## Product scripts

`product_script_write` does everything needed, idempotently: it creates the
product's storage if missing, writes the `index.js` wrapper the first time,
links it as the product's code, uploads the script and creates or updates
the product API resource, so the script is callable at once. The product must
exist (`resource_create` type `product`).

How a call works: the product API resource targets the agent's `cmd`
resource; the product code reads the script from the storage, sends it with
the caller's input on stdin, and parses stdout as JSON (`parse_stdout`). A
non-zero exit returns `{error, retcode}`; invalid JSON returns
`{error: "invalid JSON in stdout", stdout}`.

Contract:

- Any executable source. With a shebang (`#!/usr/bin/env python3`,
  `#!/bin/bash`…) it runs with that interpreter; without one it runs through
  the shell (pipes, redirects and `&&` work).
- The object the caller sends arrives on **stdin** as JSON: parse it with
  `jq`, `json.load`, `JSON.parse`.
- With `output` true (the default), **stdout must be valid JSON**: the
  resource returns the decoded object.

Choose the resource shape with `input` and `output`:

| Shape | `input` | `output` | Example | Console shows |
|---|---|---|---|---|
| output only | omit | true | stats, status | the output |
| input and output | `{field: default}` | true | transform, query | an input form and the output |
| input only | `{field: default}` | false | notify, log | an input form; the call replies empty |
| run | omit | false | ping, restart | a button |

`input` maps field names (`^[A-Za-z_][A-Za-z0-9_]*$`) to default values
(string, number or boolean), e.g. `{"threshold": 80, "label": "warm"}`: the
console renders typed fields and callers may override each one. Omit it for
a free-form payload passed to stdin as is.

Example, output only (`scripts/disk.sh`):

```sh
#!/bin/bash
df -P / | awk 'NR==2 {printf "{\"used_pct\": %d, \"avail_kb\": %d}\n", $5, $4}'
```

Example, input and output (`scripts/ping.py`, `input: {"host": "8.8.8.8"}`):

```python
#!/usr/bin/env python3
import json, subprocess, sys
host = json.load(sys.stdin).get("host", "8.8.8.8")
ok = subprocess.run(["ping", "-c", "1", "-W", "2", host], capture_output=True).returncode == 0
print(json.dumps({"host": host, "reachable": ok}))
```

## Device scripts

`device_script_write` writes the file in the agent's scripts folder, makes
it executable and reloads the scripts extension (`$scripts/reload`), so the
resource is callable at once. `device_script_list` shows each script with
the schema it describes.

Contract:

- Executable with a shebang.
- Called with `--describe`, it prints a JSON object with `input` and/or
  `output` sample objects, e.g. `{"input": {"path": ""}, "output": {"size": 0}}`:
  that becomes the resource's schema.
- Called normally, the input object arrives on stdin as JSON; stdout is
  parsed as JSON. An object's keys become the output fields; any other value
  appears under `output`. A non-zero exit is an error.

## Writing JSON safely

Build JSON with a tool, never by pasting values into a string: a hostname or
a log line with a quote or a backslash breaks it. Use `jq -n --arg v "$x"
'{v: $v}'`, or Python's `json.dumps`. Output landing under `output` (device
scripts) or an `invalid JSON` error (product scripts) means the JSON was
malformed.
