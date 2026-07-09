output "runner_repository_url" {
  value       = aws_ecr_repository.this["runner"].repository_url
  description = "Runner repository URL."
}

output "runner_repository_arn" {
  value       = aws_ecr_repository.this["runner"].arn
  description = "Runner repository ARN."
}

output "grafana_repository_url" {
  value       = aws_ecr_repository.this["grafana"].repository_url
  description = "Grafana repository URL."
}

output "grafana_repository_arn" {
  value       = aws_ecr_repository.this["grafana"].arn
  description = "Grafana repository ARN."
}
