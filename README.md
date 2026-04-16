# Thinr - ThinRemote CLI

<p align="center">
  <img src='https://s3.us-east-1.amazonaws.com/thinremote.io.files/share-image.svg' alt="Thinger n8n node">
</p>

A modern command-line interface for managing remote devices through the ThinRemote platform.

## Features

- **Remote Terminal**: Connect to a device's terminal and interact with it directly
- **TCP/Web Proxy**: Create proxies to remote devices, either for TCP connections or web interfaces
- **Device Status**: Check connection status and statistics for a device
- **Secure Authentication**: Support for both username/password and token-based authentication
- **Modern UI**: Clean and intuitive command-line interface

## Installation

### From NPM (recommended)

```bash
npm install -g @thinremote/thinr-cli
```

### From Source

```bash
git clone https://github.com/Thin-Remote/thinr-cli.git
cd thinr-cli
npm install
npm link
```

## Usage

### Initial Setup

Run the CLI without any parameters to set up:

```bash
thinr
```

You'll be prompted to authenticate either with username/password or with an existing token.

### JSON output

Every data-producing command accepts `-j, --json` and writes a single
envelope to stdout so scripts can pipe it to `jq`:

```json
{ "ok": true, "data": <payload> }
{ "ok": false, "error": { "message": "...", "code": "<code>" } }
```

Process exit codes always reflect success (`0`) or failure (non-zero),
independently of the envelope.

Error `code` values currently emitted:

| code              | meaning                                             |
|-------------------|-----------------------------------------------------|
| `not_configured`  | CLI has no saved profile — run `thinr` to set up.   |
| `not_found`       | Device, property, resource or profile not found.    |
| `unauthorized`    | Token expired / insufficient permissions.           |
| `server_error`    | Non-success HTTP response from the server.          |
| `network_error`   | No response from the server.                        |
| `input_error`     | Bad or missing CLI argument.                        |
| `timeout`         | Command timed out on the device (`exec`).           |
| `cancelled`       | User interrupted with Ctrl+C (`exec`).              |
| `error`           | Fallback for anything uncategorised.                |

In JSON mode, spinners and progress messages are suppressed so the
output is valid JSON without extra wrapping. Interactive commands
(`console`, `env`, `tcp`/`tls`/`http` proxies) accept `--json`
silently but do not change their behaviour, since they do not produce
a discrete result. `exec` buffers stdout/stderr when `--json` is set
and emits a single envelope on exit.

### Available Commands

#### Device

Listing devices:

```bash
thinr devices [--json]
```

##### Console

Connect to a device's terminal:

```bash
thinr device <deviceId> console
```

##### Proxy

Create a TCP or HTTP proxy to a remote device:

```bash
thinr device <deviceId> tcp <target> [options]
thinr device <deviceId> tls <target> [options]
thinr device <deviceId> http <taget> [options]
```

The target being the remote address and port on the device (defaults: tcp: 22, http: 80, tls: 443, and localhost for the target address).

Options:
- `-w, --web`: Create an HTTP proxy for web interface instead of TCP
- `--no-open`: Do not open browser automatically (web mode only)

Examples:
```bash
# Create a TCP proxy to SSH
thinr device RevPi20679 tcp 22

# Create a proxy to a specific port with SSL
thinr device RevPi20679 http 8080

# Create a proxy to a specific address
thinr device RevPi20679 http http://192.168.1.45:8080
```

##### Status

Check the connection status of a device:

```bash
thinr device <deviceId> status [options]
```

Options:
- `-j, --json`: Output the status in JSON format

##### Property

Retrieve the properties of a device:

```bash
thinr device <deviceId> property [options]
```

Retrieve a property from a device:

```bash
thinr device <deviceId> property <propertyId> [options]
```

Options:
- `-j, --json`: Output the status in JSON format
- `-f, --field`: Field to extract from the property or resource (e.g., -f data.value)

##### Resource

Get the available resources of a device:

```bash
thinr device <deviceId> resource [options]
```

Options:
- `-j, --json`: Output the status in JSON format

Execute a resource on a device:

```bash
thinr device <deviceId> resource <resourceId> [options]
```

Options:
- `-i, --input`: Input for the resource (e.g., -i param1=value1 -i param2=value2)
- `-j, --json`: Output the status in JSON format
- `-f, --field`: Field to extract from the property or resource (e.g., -f data.value)

##### Product

Iterate over all devices of a specific product in order to retrieve a property or execute a resource:

```bash
thinr product <productId> property [options]
thinr product <productId> resource [options]
```

Options:
- `-j, --json`: Output as JSON (one envelope with `results[]` per device, each with its own `ok`)
- `-f, --field`: Field to extract from the property or resource (e.g., -f data.value)
- `-g, --group`: Filter devices by asset group
- `-a, --all`: Include offline devices (for `property` only)

Options for executing a resource:
- `-i, --input`: Input for the resource (e.g., -i param1=value1 -i param2=value2)

##### Exec

Run a command on the device and stream its stdout/stderr back:

```bash
thinr device <deviceId> exec "<command>" [options]
```

Options:
- `-j, --json`: Buffer output and emit a single envelope `{stdout, stderr, exitCode}` on exit
- `--legacy`: Use the non-streaming one-shot API (older agents)

The process exits with the remote command's exit code.

##### Update

Check for or apply an agent update on the device:

```bash
thinr device <deviceId> update check [options]
thinr device <deviceId> update apply [options]
```

Options:
- `--channel <name>`: Update channel (default: `latest`)
- `-j, --json`: Output as JSON

#### Profile

Manage multiple CLI configurations (one per server / account):

```bash
thinr profile list [--json]
thinr profile current [--json]
thinr profile use <name> [--json]
thinr profile delete <name> [--json]
```

The active profile can also be overridden per-call with the global
`--profile <name>` option, or the `THINR_PROFILE` env var.

### Help

Get help for any command:

```bash
thinr --help
thinr device --help
thinr logout --help
```

## Development

The project structure is organized as follows:

```
thinr/
├── bin/           # Main executable
├── lib/           # Core functionality
├── commands/      # Command implementations
├── package.json
└── README.md
```

### Building

```bash
npm install
npm link
```

### Testing

```bash
npm test
```

## License

<a href="http://opensource.org/">
  <img style="float: right;" width="100px" height="137px" src="https://opensource.org/wp-content/uploads/2009/06/OSI_Standard_Logo_0.svg">
</a>

The plugin is licensed under the [MIT License](http://opensource.org/licenses/MIT):

Copyright &copy; [Thinger.io](http://thinger.io)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
