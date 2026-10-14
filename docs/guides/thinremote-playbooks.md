# ThinRemote playbooks

A playbook is a YAML document with ordered steps the agent executes on each
device: write a file, run a command, install a script, restart a service…
It is the safe way to change many machines: validated before it runs,
testable on one device, rolled out in batches with a failure threshold, and
recorded.

Tool names below omit the `thinr_` prefix.

## Authoring flow

A saved playbook is a resource of type `product_playbook`, with the product
as parent and its name as id; validating, running and rolling it out are
its actions (`resource_call`).

1. `resource_describe` type `product_playbook` once: its `playbook_format`
   is the full schema (document, `vars`, step fields, every action with its
   parameters, the `when` syntax). Write against it.
2. Draft the YAML, then action `validate` with the YAML in `body.content`,
   and fix what it reports. Repeat until it is clean.
3. Save it: `resource_create` type `product_playbook`, body
   `{"content": "<yaml>", "description"?: "…"}` (validated again: nothing is
   saved if invalid; it writes `playbooks/<name>.yaml` in the product storage
   and registers it in the `playbooks` product property). Change it later
   with `resource_update`.
4. Try it on one device: action `run` with the playbook's `id` and
   `body.device`, first with `dry_run: true` (the resolved plan, no device
   contacted), then `check: true` (contacts the device read-only: each step
   says changed / unchanged / unknown), then for real.
5. Roll it out: action `rollout` (below).

For a one-off run that is not worth saving, action `run` without `id` takes
the YAML in `body.content`, with the same `dry_run` and `check`; it targets
`body.device`, `body.devices`, `body.group` or every device of the product.

`resource_list` and `resource_get` show what a product has (`get` includes
the YAML); `resource_delete` removes one (index entry, then file).

## Document

```yaml
name: nginx-config
description: Deploy nginx.conf and reload
target:
    product: web_gateways # or devices: [gw1, gw2]; group: madrid narrows
    concurrency: 10 # parallel devices (action run)
    fail_fast: false
vars:
    port:
        default: 8080
        type: number
        description: Listening port
    release:
        type: string
        required: true # must be given at run time
steps:
    - name: Write config to a temp file
      action: write
      path: /tmp/nginx.conf
      content: |
          server { listen {{ port }}; }
    - name: Check it
      action: exec
      command: nginx -t -c /tmp/nginx.conf
      register: check
    - name: Move it into place
      action: move
      source: /tmp/nginx.conf
      destination: /etc/nginx/nginx.conf
      overwrite: true
      when: check.ok
    - name: Reload
      action: exec
      command: systemctl reload nginx
```

- `vars`: plain (`port: 8080`) or extended (`default`, `type` string |
  number | boolean | object, `description`, `overridable: false` for
  internal ones, `required: true`). Used in any parameter as `{{ name }}`.
  Overrides passed at run time (`vars`) are validated against the declared
  type; unknown, non-overridable or missing required ones are errors, and
  they never change the stored playbook.
- Step fields: `name`, `action`, the action's parameters, and optionally
  `when` (skip unless true), `register` (expose `{ ok, result | error,
duration_ms }` to later steps), `pause_after` (seconds).
- `when` syntax: `==`, `!=`, `>`, `<`, `>=`, `<=`, `and`, `or`, `not`,
  parentheses, quoted strings, numbers, `true` / `false` / `null`, dotted
  paths (`check.ok`, `agent.version`).

Actions:

| Action                             | Parameters (\* required)               | Does                                                       |
| ---------------------------------- | -------------------------------------- | ---------------------------------------------------------- |
| `exec`                             | `command`\*, `timeout`                 | runs a shell command; non-zero exit fails the step         |
| `write`                            | `path`_, `content`_                    | writes inline content                                      |
| `push` / `pull`                    | `source`_, `destination`_              | copies a file from / to the machine running the playbook   |
| `mkdir`                            | `path`\*                               | creates a directory                                        |
| `move`                             | `source`_, `destination`_, `overwrite` | moves; write to a temp file then `move` for atomic deploys |
| `delete`                           | `path`\*, `recursive`                  | deletes                                                    |
| `property_set`                     | `property`_, `value`_                  | sets a device property                                     |
| `resource`                         | `resource`\*, `inputs`                 | calls a device resource                                    |
| `script_install` / `script_delete` | `name`\*, `content` or `content_file`  | installs or removes a device script                        |
| `update`                           | `op`\*, `channel`                      | checks for or applies an agent update                      |
| `sleep`                            | `seconds`\*                            | waits                                                      |

`check` cannot predict `exec` or `resource` steps: they report `unknown`.

## Rolling out

Action `rollout` (`resource_call` type `product_playbook`, the playbook's
`id`) runs a saved playbook on every matching device of the product, in batches of `body.batch_size` (default 5). A batch finishes before
the next starts; after each one the cumulative failure rate is compared
with `body.failure_threshold` (default 10 %), and reaching it stops the rollout
without touching the remaining devices. Narrow the targets with `group` or
`filter`; offline devices are skipped unless `include_offline`. `dry_run`
lists the plan and the devices; `check` reports what would change.

Each rollout writes a report to `playbooks/runs/<timestamp>-<name>-<user>.json`
in the product storage (read it with `storage_file_read`, storage named like
the product): resolved variables, per-device outcome, and why it stopped if
it did. A rollout that stops does not undo the devices it already changed:
write files to a temporary path and `move` them into place, so a device is
never left with half a change.

Writing the same file to every device is a playbook too: a `write` step
(and a `move`), rolled out.

Rollouts change real machines: confirm with the user, test on one device
first, and start with small batches.
