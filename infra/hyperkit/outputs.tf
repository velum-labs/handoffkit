output "artifact_bucket_name" {
  description = "S3 artifact-lake bucket."
  value       = module.storage.bucket_name
}

output "runner_repository_url" {
  description = "ECR URL for the Hyperkit runner image."
  value       = module.registry.runner_repository_url
}

output "controller_repository_url" {
  description = "ECR URL for the Hyperkit controller image."
  value       = module.registry.controller_repository_url
}

output "controller_results_queue_url" {
  description = "SQS queue URL consumed by the Hyperkit controller."
  value       = aws_sqs_queue.controller_results.id
}

output "controller_results_queue_arn" {
  description = "SQS queue ARN receiving S3 result notifications."
  value       = aws_sqs_queue.controller_results.arn
}

output "controller_ecs_service_name" {
  description = "ECS service hosting the always-on Hyperkit controller."
  value       = module.controller.service_name
}

output "grafana_repository_url" {
  description = "ECR URL for the provisioned Grafana image."
  value       = module.registry.grafana_repository_url
}

output "batch_job_queue_arn" {
  description = "ARN of the runner Batch job queue."
  value       = module.batch.job_queue_arn
}

output "batch_job_queue_name" {
  description = "Name of the runner Batch job queue."
  value       = module.batch.job_queue_name
}

output "batch_job_definition_arn" {
  description = "Revisioned ARN of the default runner job definition."
  value       = module.batch.job_definition_arn
}

output "batch_job_definition_name" {
  description = "Name of the default runner job definition."
  value       = module.batch.job_definition_name
}

output "grafana_url" {
  description = "Grafana ALB URL. Access remains limited to grafana_allowed_cidrs."
  value       = module.observability.grafana_url
}

output "amp_workspace_id" {
  description = "Amazon Managed Service for Prometheus workspace ID."
  value       = module.observability.amp_workspace_id
}

output "amp_workspace_endpoint" {
  description = "Amazon Managed Service for Prometheus workspace endpoint."
  value       = module.observability.amp_workspace_endpoint
}

output "observability_ecs_cluster_name" {
  description = "ECS cluster hosting observability and controller services."
  value       = module.observability.ecs_cluster_name
}

output "observability_ecs_service_name" {
  description = "ECS service hosting Grafana and ADOT."
  value       = module.observability.ecs_service_name
}

output "managed_secret_arns" {
  description = "Empty secret containers created by this stack. Populate values outside Terraform."
  value       = module.secrets.secret_arns_by_name
}
