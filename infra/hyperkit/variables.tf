variable "aws_region" {
  description = "AWS region in which to create Hyperkit."
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Short name used to prefix resources."
  type        = string
  default     = "hyperkit"
}

variable "environment" {
  description = "Deployment environment name."
  type        = string
  default     = "production"
}

variable "vpc_cidr" {
  description = "CIDR assigned to the Hyperkit VPC."
  type        = string
  default     = "10.42.0.0/16"
}

variable "availability_zones" {
  description = "Two or more availability zones. The first two available zones are used when empty."
  type        = list(string)
  default     = []

  validation {
    condition     = length(var.availability_zones) == 0 || length(var.availability_zones) >= 2
    error_message = "availability_zones must be empty or contain at least two zones."
  }
}

variable "single_nat_gateway" {
  description = "Use one NAT gateway to reduce cost. Set false for an AZ-independent production egress path."
  type        = bool
  default     = false
}

variable "artifact_bucket_name" {
  description = "Globally unique artifact-lake bucket name. AWS generates a name when null."
  type        = string
  default     = null
}

variable "artifact_retention_days" {
  description = "Days before noncurrent artifact versions expire."
  type        = number
  default     = 90
}

variable "force_destroy_artifact_bucket" {
  description = "Allow Terraform to delete a non-empty artifact bucket."
  type        = bool
  default     = false
}

variable "runner_image_tag" {
  description = "Runner image tag referenced by the Batch job definition."
  type        = string
  default     = "latest"
}

variable "controller_image_tag" {
  description = "Controller image tag referenced by the Fargate task definition."
  type        = string
  default     = "latest"

  validation {
    condition     = trimspace(var.controller_image_tag) != ""
    error_message = "controller_image_tag must not be empty."
  }
}

variable "controller_desired_count" {
  description = "Number of always-on Hyperkit controller Fargate tasks."
  type        = number
  default     = 1

  validation {
    condition     = var.controller_desired_count >= 0 && floor(var.controller_desired_count) == var.controller_desired_count
    error_message = "controller_desired_count must be a non-negative integer."
  }
}

variable "controller_poll_interval" {
  description = "Controller reconciliation poll interval in seconds."
  type        = number
  default     = 30

  validation {
    condition     = var.controller_poll_interval > 0 && floor(var.controller_poll_interval) == var.controller_poll_interval
    error_message = "controller_poll_interval must be a positive integer."
  }
}

variable "controller_s3_prefix" {
  description = "S3 key prefix watched by the controller and used for bucket notifications."
  type        = string
  default     = "runs/"

  validation {
    condition     = var.controller_s3_prefix != "" && !startswith(var.controller_s3_prefix, "/") && endswith(var.controller_s3_prefix, "/")
    error_message = "controller_s3_prefix must be non-empty, relative, and end with a slash."
  }
}

variable "controller_sweep_id" {
  description = "Optional sweep ID restricting controller aggregation; null processes every sweep under the configured prefix."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.controller_sweep_id == null || can(regex("\\S", var.controller_sweep_id))
    error_message = "controller_sweep_id must be null or non-empty."
  }
}

variable "grafana_image_tag" {
  description = "Grafana configuration image tag referenced by ECS."
  type        = string
  default     = "latest"
}

variable "secret_names" {
  description = "Additional empty Secrets Manager containers for provider credentials. Secret values are populated outside Terraform."
  type        = set(string)
  default     = []
}

variable "external_secret_arns" {
  description = "Existing secret ARNs the runner may read."
  type        = set(string)
  default     = []
}

variable "runner_managed_secret_environment" {
  description = "Runner environment variable to managed secret-name mapping. Terraform creates containers, never values."
  type        = map(string)
  default     = {}
}

variable "runner_external_secret_environment" {
  description = "Runner environment variable to existing secret-ARN mapping."
  type        = map(string)
  default     = {}
}

variable "controller_managed_secret_environment" {
  description = "Controller environment variable to managed secret-name mapping. Terraform creates containers, never values."
  type        = map(string)
  default     = {}
}

variable "controller_external_secret_environment" {
  description = "Controller environment variable to existing secret-ARN mapping."
  type        = map(string)
  default     = {}
}

variable "batch_instance_types" {
  description = "Memory-rich EC2 types eligible for the Spot compute environment."
  type        = list(string)
  default     = ["r7i.2xlarge", "r7i.4xlarge", "m7i.2xlarge", "m7i.4xlarge"]
}

variable "batch_max_vcpus" {
  description = "Maximum aggregate vCPUs for the Spot fleet."
  type        = number
  default     = 256
}

variable "batch_root_volume_gib" {
  description = "Encrypted gp3 root volume size used for images and sibling-container caches."
  type        = number
  default     = 500

  validation {
    condition     = var.batch_root_volume_gib >= 500
    error_message = "batch_root_volume_gib must be at least 500 GiB."
  }
}

variable "batch_default_vcpus" {
  description = "Default runner job vCPU reservation; submissions may override it."
  type        = number
  default     = 2
}

variable "batch_default_memory_mib" {
  description = "Default runner job memory reservation in MiB; submissions may override it."
  type        = number
  default     = 8192
}

variable "batch_job_timeout_seconds" {
  description = "Maximum attempt duration for a runner job."
  type        = number
  default     = 21600
}

variable "grafana_allowed_cidrs" {
  description = "CIDRs allowed to reach Grafana. Empty by default so the public ALB is not internet-accessible."
  type        = set(string)
  default     = []
}

variable "grafana_certificate_arn" {
  description = "ACM certificate ARN. When set, the ALB serves HTTPS on 443; otherwise it serves HTTP on 80."
  type        = string
  default     = null
}

variable "grafana_desired_count" {
  description = "Number of always-on Grafana/ADOT Fargate tasks."
  type        = number
  default     = 1
}

variable "grafana_admin_secret_arn" {
  description = "Existing Secrets Manager secret ARN containing the Grafana admin password. An empty container is created when null."
  type        = string
  default     = null
}

variable "adot_collector_image" {
  description = "Pinned ADOT collector image used by the observability sidecar."
  type        = string
  default     = "public.ecr.aws/aws-observability/aws-otel-collector:v0.43.3"
}

variable "budget_limit_usd" {
  description = "Monthly AWS cost budget in USD."
  type        = number
  default     = 2500
}

variable "budget_alert_threshold_percent" {
  description = "Forecasted and actual budget notification threshold."
  type        = number
  default     = 80
}

variable "budget_alert_email" {
  description = "Email address for AWS Budget notifications. Notifications are disabled when null."
  type        = string
  default     = null
}

variable "tags" {
  description = "Additional tags applied through the AWS provider."
  type        = map(string)
  default     = {}
}
