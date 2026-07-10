output "grafana_url" {
  value       = "${local.listener_is_https ? "https" : "http"}://${aws_lb.grafana.dns_name}"
  description = "Grafana URL."
}

output "amp_workspace_id" {
  value       = aws_prometheus_workspace.this.id
  description = "AMP workspace ID."
}

output "amp_workspace_arn" {
  value       = aws_prometheus_workspace.this.arn
  description = "AMP workspace ARN."
}

output "amp_workspace_endpoint" {
  value       = aws_prometheus_workspace.this.prometheus_endpoint
  description = "AMP workspace endpoint."
}

output "otlp_http_endpoint" {
  value       = "http://adot.${local.service_namespace}:4318"
  description = "Private OTLP/HTTP endpoint discovered through Cloud Map."
}

output "grafana_log_group_arn" {
  value       = aws_cloudwatch_log_group.grafana.arn
  description = "Grafana CloudWatch log group ARN."
}

output "adot_log_group_arn" {
  value       = aws_cloudwatch_log_group.adot.arn
  description = "ADOT CloudWatch log group ARN."
}

output "ecs_cluster_name" {
  value       = aws_ecs_cluster.observability.name
  description = "ECS cluster hosting observability and controller services."
}

output "ecs_service_name" {
  value       = aws_ecs_service.observability.name
  description = "ECS service hosting Grafana and ADOT."
}
