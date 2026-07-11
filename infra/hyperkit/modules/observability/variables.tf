variable "name" {
  type        = string
  description = "Resource name prefix."
}

variable "aws_region" {
  type        = string
  description = "AWS region."
}

variable "account_id" {
  type        = string
  description = "AWS account ID."
}

variable "vpc_id" {
  type        = string
  description = "VPC ID."
}

variable "public_subnet_ids" {
  type        = list(string)
  description = "Public subnets for the ALB."
}

variable "private_subnet_ids" {
  type        = list(string)
  description = "Private subnets for Fargate tasks."
}

variable "alb_security_group_id" {
  type        = string
  description = "CIDR-restricted ALB security group."
}

variable "service_security_group_id" {
  type        = string
  description = "Fargate task security group."
}

variable "grafana_image" {
  type        = string
  description = "Provisioned Grafana image in ECR."
}

variable "adot_collector_image" {
  type        = string
  description = "Pinned ADOT collector image."
}

variable "grafana_admin_secret_arn" {
  type        = string
  description = "Secret ARN containing the Grafana admin password."
}

variable "grafana_certificate_arn" {
  type        = string
  description = "Optional ACM certificate ARN."
  default     = null
}

variable "desired_count" {
  type        = number
  description = "Always-on observability task count."
  default     = 1
}

variable "artifact_bucket_arn" {
  type        = string
  description = "Artifact-lake bucket ARN."
}

variable "artifact_bucket_name" {
  type        = string
  description = "Artifact-lake bucket name."
}

variable "glue_database_name" {
  type        = string
  description = "Glue catalog database queried by Athena."
}

variable "permissions_boundary_arn" {
  type        = string
  description = "Optional permissions boundary policy ARN attached to IAM roles created by this module."
  default     = null
}
