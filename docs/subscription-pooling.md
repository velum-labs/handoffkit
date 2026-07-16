# Subscription pooling

RouteKit owns subscription credentials, account pools, CLIProxyAPI, provider
relays, and their command surfaces. FusionKit v4 only consumes opaque endpoint
IDs served by RouteKit.

```sh
npm install -g @routekit/cli
routekit config init
claude                              # establish the official Claude Code login
routekit accounts add claude-code  # imports it and enables the account kind
routekit endpoints add private-review \
  --model claude-sonnet-4-5 --account claude-code
routekit serve
```

The canonical subscription kinds are `claude-code` and `codex`. For Codex,
establish the official login with `codex login`, then run
`routekit accounts add codex`. The Claude Code tool launcher remains
`routekit claude [endpoint-id]`; there is no `routekit claude-code` command.

`accounts add` automatically enables the imported kind in the effective router
config. Account-backed endpoint YAML contains only the opaque endpoint ID,
upstream model, and account kind:

```yaml
endpoints:
  - endpointId: private-review
    model: claude-sonnet-4-5
    account: claude-code
accounts:
  claude-code:
    enabled: true
```

Reference `private-review` from `.fusionkit/fusion.json` just like any other
opaque RouteKit endpoint ID. Do not put account, provider, model, URL, or key
definitions in Fusion config.

Normal `routekit serve` and `routekit <tool>` paths use subscription backends
in process. `routekit accounts serve` is advanced mode for exposing the pool as
a separate authenticated proxy to an external consumer; it is not an account
enrollment or endpoint-creation step.

CLIProxyAPI has a separate lifecycle:

```sh
routekit accounts cliproxy install
routekit accounts cliproxy login gemini
routekit accounts cliproxy serve
routekit endpoints add gemini-subscription \
  --model gemini-3.1-pro-preview \
  --provider cliproxy \
  --base-url http://127.0.0.1:8317/v1 \
  --api-key-env ROUTEKIT_CLIPROXY_API_KEY
```

Login alone does not add a RouteKit endpoint; keep CLIProxyAPI serving and add
each URL-backed endpoint explicitly.

FusionKit links the reusable `@routekit/router` SDK for embedded composition;
it does not depend on `@routekit/cli` or execute `routekit`. `fusionkit stop`
only reaps Fusion-owned processes and portless routes. External RouteKit
daemons remain running.
