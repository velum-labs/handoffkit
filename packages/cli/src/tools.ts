import { setToolDriverRegistry } from "@fusionkit/ensemble";
import { toolRegistry } from "@velum-labs/routekit-tool-registry";

export { toolRegistry };

setToolDriverRegistry(toolRegistry);
