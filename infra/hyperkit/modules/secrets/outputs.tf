output "secret_arns_by_name" {
  value       = { for name, secret in aws_secretsmanager_secret.this : name => secret.arn }
  description = "Map of managed secret names to ARNs."
}

output "all_readable_secret_arns" {
  value       = local.readable_secret_arns
  description = "Secret ARNs granted to the Batch job role."
}

output "job_role_arn" {
  value       = aws_iam_role.job.arn
  description = "Batch runner job role ARN."
}

output "batch_instance_profile_arn" {
  value       = aws_iam_instance_profile.batch.arn
  description = "Batch EC2 instance profile ARN."
}
