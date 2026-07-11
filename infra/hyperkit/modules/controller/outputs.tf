output "service_name" {
  value       = aws_ecs_service.controller.name
  description = "ECS service hosting the Hyperkit controller."
}

output "task_role_arn" {
  value       = aws_iam_role.task.arn
  description = "Controller ECS task role ARN."
}

output "log_group_name" {
  value       = aws_cloudwatch_log_group.controller.name
  description = "Controller CloudWatch log group name."
}
