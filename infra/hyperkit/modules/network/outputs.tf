output "vpc_id" {
  value       = aws_vpc.this.id
  description = "Hyperkit VPC ID."
}

output "public_subnet_ids" {
  value       = aws_subnet.public[*].id
  description = "Public subnet IDs."
}

output "private_subnet_ids" {
  value       = aws_subnet.private[*].id
  description = "Private subnet IDs."
}

output "batch_security_group_id" {
  value       = aws_security_group.batch.id
  description = "Batch worker security group ID."
}

output "controller_security_group_id" {
  value       = aws_security_group.controller.id
  description = "Always-on controller security group ID."
}

output "grafana_alb_security_group_id" {
  value       = aws_security_group.grafana_alb.id
  description = "Grafana ALB security group ID."
}

output "observability_security_group_id" {
  value       = aws_security_group.observability.id
  description = "Observability task security group ID."
}
