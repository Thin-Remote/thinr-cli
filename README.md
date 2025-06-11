# ThingR - ThingRemote CLI

A modern command-line interface for managing remote devices through the ThingRemote platform.

![ThingR CLI](https://raw.githubusercontent.com/username/thingr/main/assets/thingr-cli.png)

## Features

- **Remote Terminal**: Connect to a device's terminal and interact with it directly
- **TCP/Web Proxy**: Create proxies to remote devices, either for TCP connections or web interfaces
- **Device Status**: Check connection status and statistics for a device
- **Secure Authentication**: Support for both username/password and token-based authentication
- **Modern UI**: Clean and intuitive command-line interface

## Installation

### From NPM (recommended)

```bash
npm install -g thingr
```

### From Source

```bash
git clone https://github.com/username/thingr.git
cd thingr
npm install
npm link
```

## Usage

### Initial Setup

Run the CLI without any parameters to set up:

```bash
thingr
```

You'll be prompted to authenticate either with username/password or with an existing token.

### Available Commands

#### Console

Connect to a device's terminal:

```bash
thingr console <deviceId>
```

#### Proxy

Create a TCP or HTTP proxy to a remote device:

```bash
thingr proxy <deviceId> [options]
```

Options:
- `-r, --remote-port <port>`: Remote port on device (default: 80 for web, 22 for TCP)
- `-a, --remote# ThingR - ThingRemote CLI

A modern command-line interface for managing remote devices through the ThingRemote platform.

![ThingR CLI](https://raw.githubusercontent.com/username/thingr/main/assets/thingr-cli.png)

## Features

- **Remote Terminal**: Connect to a device's terminal and interact with it directly
- **TCP/Web Proxy**: Create proxies to remote devices, either for TCP connections or web interfaces
- **Device Status**: Check connection status and statistics for a device
- **Secure Authentication**: Support for both username/password and token-based authentication
- **Modern UI**: Clean and intuitive command-line interface

## Installation

### From NPM (recommended)

```bash
npm install -g thingr
```

### From Source

```bash
git clone https://github.com/username/thingr.git
cd thingr
npm install
npm link
```

## Usage

### Initial Setup

Run the CLI without any parameters to set up:

```bash
thingr
```

You'll be prompted to authenticate either with username/password or with an existing token.

### Available Commands

#### Console

Connect to a device's terminal:

```bash
thingr console <deviceId>
```

#### Proxy

Create a TCP or HTTP proxy to a remote device:

```bash
thingr proxy <deviceId> [options]
```

Options:
- `-r, --remote-port <port>`: Remote port on device (default: 80 for web, 22 for TCP)
- `-a, --remote-address <address>`: Remote address on device (default: localhost)
- `-w, --web`: Create an HTTP proxy for web interface instead of TCP
- `-s, --ssl`: Use SSL for the server connection
- `--no-open`: Do not open browser automatically (web mode only)

Examples:
```bash
# Create a TCP proxy to SSH
thingr proxy RevPi20679

# Create a web interface proxy
thingr proxy RevPi20679 --web

# Create a proxy to a specific port with SSL
thingr proxy RevPi20679 --remote-port 8080 --ssl

# Create a proxy to a specific address
thingr proxy RevPi20679 --remote-address 192.168.1.100
```

#### Status

Check the connection status of a device:

```bash
thingr status <deviceId> [options]
```

Options:
- `-j, --json`: Output the status in JSON format

### Help

Get help for any command:

```bash
thingr --help
thingr console --help
thingr proxy --help
thingr status --help
```

## Development

The project structure is organized as follows:

```
thingr/
├── bin/           # Main executable
├── lib/           # Core functionality
├── commands/      # Command implementations
├── package.json
└── README.md
```

### Building

```bash
npm install
```

### Testing

```bash
npm test
```

## License

MIT