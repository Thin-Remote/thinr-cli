# ThingR - ThingRemote CLI

A modern command-line interface for managing remote devices through the ThingRemote platform.

![ThingR CLI](https://raw.githubusercontent.com/Thin-Remote/thinr/main/assets/thinr-cli.png)

## Features

- **Remote Terminal**: Connect to a device's terminal and interact with it directly
- **TCP/Web Proxy**: Create proxies to remote devices, either for TCP connections or web interfaces
- **Device Status**: Check connection status and statistics for a device
- **Secure Authentication**: Support for both username/password and token-based authentication
- **Modern UI**: Clean and intuitive command-line interface

## Installation

### From NPM (recommended)

```bash
npm install -g thinr-cli
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

### Available Commands

#### Device

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

The target being the remote port on the device (defaults: tcp: 22, http: 80, tls: 443).

Options:
- `-w, --web`: Create an HTTP proxy for web interface instead of TCP
- `--no-secure`: Do not use SSL for the target connection
- `--no-open`: Do not open browser automatically (web mode only)

Examples:
```bash
# Create a TCP proxy to SSH
thinr proxy RevPi20679

# Create a web interface proxy
thinr proxy RevPi20679 --web

# Create a proxy to a specific port with SSL
thinr proxy RevPi20679 --remote-port 8080 --ssl

# Create a proxy to a specific address
thinr proxy RevPi20679 --remote-address 192.168.1.100
```

##### Status

Check the connection status of a device:

```bash
thinr status <deviceId> [options]
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

Get the avaiable resources of a device:

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
- `-j, --json`: Output the status in JSON format
- `-f, --field`: Field to extract from the property or resource (e.g., -f data.value)

Options for executing a resource:
- `-i, --input`: Input for the resource (e.g., -i param1=value1 -i param2=value2)


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
  <img style="float: right;" width="100px" height="137px" src="/assets/OSI_Standard_Logo_0.svg">
</a>

The plugin is licensed under the [MIT License](http://opensource.org/licenses/MIT):

Copyright &copy; [Thinger.io](http://thinger.io)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
