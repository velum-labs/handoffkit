from fusionkit_core.config import FusionConfig
from fusionkit_core.fake_client import FakeModelClient
from fusionkit_core.model_client import ChatClient, ToolChoice, ToolDefinition
from fusionkit_core.routekit_client import RouteKitClient


def build_clients(config: FusionConfig) -> dict[str, ChatClient]:
    return {
        endpoint_id: RouteKitClient(config.routekit_url, endpoint_id)
        for endpoint_id in config.endpoint_ids
    }


__all__ = [
    "ChatClient",
    "FakeModelClient",
    "RouteKitClient",
    "ToolChoice",
    "ToolDefinition",
    "build_clients",
]
