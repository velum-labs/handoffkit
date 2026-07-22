output "job_queue_arn" {
  value       = aws_batch_job_queue.runner.arn
  description = "Runner queue ARN."
}

output "job_queue_name" {
  value       = aws_batch_job_queue.runner.name
  description = "Runner queue name."
}

output "job_definition_arn" {
  value       = aws_batch_job_definition.runner.arn
  description = "Runner job definition ARN, including revision."
}

output "job_definition_name" {
  value       = aws_batch_job_definition.runner.name
  description = "Runner job definition name."
}

output "compute_environment_arn" {
  value       = aws_batch_compute_environment.spot.arn
  description = "Spot compute environment ARN."
}

output "log_group_arn" {
  value       = aws_cloudwatch_log_group.runner.arn
  description = "Runner CloudWatch Logs group ARN."
}
