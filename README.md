# pi-remote-control

## Disclaimer

This project is for personal use and research only. It is provided as-is, and the author accepts no liability for any damage, loss, misuse, or operational consequences that result from installing or using it. Do not use it for safety-critical, multi-user, or untrusted-network deployments.

## Install

```bash
pi install https://github.com/goofansu/pi-remote-control
```

## Usage

Run `/remote-control` to open the menu:

- **Turn on / Turn off** — start or stop the server
- **Configure URL** — set the base URL exposed by your local tunnel or proxy, saved to `~/.pi/agent/remote-control.json`
- **Status** — show the QR code and connection URL (only when server is running)

On first use, configure the URL before the server can start.

To start the server automatically on launch:

```bash
pi --remote-control
```

## Use case

The remote-control server binds to `127.0.0.1` on the host running `pi` and is reached through a local tunnel or proxy — in this case [Surge Ponte](https://kb.nssurge.com/surge-knowledge-base/guidelines/ponte), which provides an end-to-end encrypted device-to-device tunnel without exposing the server to the LAN.

The setup is:

1. Install this extension on the Mac that runs `pi`.
2. Enable Surge Ponte on that Mac and give it a device name such as `pi`.
3. On the same Mac, open `pi` and run the `/remote-control` command.
4. Choose `Configure URL` and set the base URL to your Surge Ponte hostname, for example `http://pi.sgponte`.
5. Choose `Turn on`.
6. Open `Status` to get the QR code and one-time connection URL.
7. On another device on the same Surge Ponte network, open that URL in a browser.

In this setup, the browser URL is `http://pi.sgponte:<dynamic-port>`, but the traffic is still routed through Surge Ponte's tunnel between your devices.

## Security notes

- The server only listens on localhost. Remote access depends on whatever local tunnel or proxy you configure.
- If you use a reverse proxy instead of Surge Ponte, configure it to terminate TLS at a fixed `https://` endpoint and forward to the server's dynamic backend port. Do not expose the dynamic port directly over a public network, as the server does not support HTTPS and any token or session cookie would be transmitted in cleartext.
