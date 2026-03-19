# pi-remote-control

## Install

```bash
pi install https://github.com/goofansu/pi-remote-control
```

## Setup

### 1. Configure your public URL

Tell the extension the base URL your proxy/tunnel exposes:

```
/remote-control config
```

Enter something like `http://pi.myhost` or `https://pi.example.com`. This is saved to `~/.pi/agent/remote-control.json`.

### 2. Start the server

```
/remote-control
```

This starts the server on a random localhost port, generates an auth token, and displays a QR code + URL. Open the URL on any device.
