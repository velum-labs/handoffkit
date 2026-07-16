# Subscription pooling

RouteKit owns subscription credentials, account pools, CLIProxyAPI, provider
relays, and their command surfaces. FusionKit v4 only consumes opaque endpoint
IDs served by RouteKit.

```sh
npm install -g @routekit/cli
routekit accounts --help
routekit accounts cliproxy --help
routekit serve
```

Configure account-backed endpoints in `.routekit/router.yaml`, then reference
their `endpointId` values from `.fusionkit/fusion.json`. Do not put account or
provider definitions in Fusion config.

FusionKit links the reusable `@routekit/router` SDK for embedded composition;
it does not depend on `@routekit/cli` or execute `routekit`. `fusionkit stop`
only reaps Fusion-owned processes and portless routes. External RouteKit
daemons remain running.
