# RouteKit remote gateways

RouteKit clients can name and select a shared gateway without running a local
daemon. The remote record contains only the HTTPS gateway URL and SSH host;
the data-plane token is stored in macOS Keychain or a private `0600` file on
other platforms.

```bash
routekit remote add mini --url https://your-gateway.example --ssh velum-mini
routekit remote list
routekit remote show mini
routekit remote use mini
routekit remote use --none
routekit remote remove mini
```

Selection precedence is `--local`, then `--remote <name>`, then the active
remote, then the local daemon. `routekit models list` and coding-tool launchers
use the remote HTTPS data plane. Status, config, accounts, providers, usage,
calls, telemetry, and doctor use an SSH relay into the daemon's existing
loopback-only `control.v1` endpoint. The control listener must not be exposed
on the network.

`remote add` retrieves the data-plane credential with the remote CLI and checks
both HTTPS health and SSH control compatibility. SSH access is therefore a hard
requirement for enrollment and administration, but not for later launcher and
model-list operations.
