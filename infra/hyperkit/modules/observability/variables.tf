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
  description = "Public subnets for the outbound-only Tailscale connector."
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

variable "tailscale_auth_parameter_name" {
  type        = string
  description = "Existing SSM SecureString containing a tagged, reusable, ephemeral Tailscale auth key."

  validation {
    condition     = can(regex("^/[A-Za-z0-9_.\\-/]+$", var.tailscale_auth_parameter_name))
    error_message = "tailscale_auth_parameter_name must be a valid absolute SSM parameter name."
  }
}

variable "tailscale_hostname" {
  type        = string
  description = "MagicDNS hostname for tailnet-only Grafana access."

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.tailscale_hostname))
    error_message = "tailscale_hostname must be a valid lowercase DNS label."
  }
}

variable "tailscale_dns_suffix" {
  type        = string
  description = "Tailnet DNS suffix used for the HTTPS Grafana URL."

  validation {
    condition     = can(regex("^[a-z0-9.-]+\\.ts\\.net$", var.tailscale_dns_suffix))
    error_message = "tailscale_dns_suffix must be a ts.net DNS suffix."
  }
}

variable "tailscale_connector_instance_type" {
  type        = string
  description = "EC2 instance type for the outbound-only Tailscale connector."
  default     = "t3.nano"
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
