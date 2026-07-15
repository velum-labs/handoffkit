# `@routekit/cli`

The independent RouteKit command line interface.

```sh
npx @routekit/cli config init
npx @routekit/cli serve
npx @routekit/cli codex
```

Configuration is loaded from `.routekit/router.yaml`, then
`~/.config/routekit/router.yaml`. Set `ROUTEKIT_CONFIG` to use an explicit
file and `ROUTEKIT_HOME` to relocate runtime state.
