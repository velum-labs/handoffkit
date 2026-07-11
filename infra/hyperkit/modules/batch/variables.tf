variable "name" {
  type        = string
  description = "Resource name prefix."
}

variable "aws_region" {
  type        = string
  description = "AWS region used by the awslogs driver."
}

variable "private_subnet_ids" {
  type        = list(string)
  description = "Private subnets for Spot instances."
}

variable "security_group_ids" {
  type        = list(string)
  description = "Security groups attached to Spot instances."
}

variable "instance_profile_arn" {
  type        = string
  description = "ECS instance profile ARN."
}

variable "job_role_arn" {
  type        = string
  description = "IAM role assumed by runner jobs."
}

variable "runner_image" {
  type        = string
  description = "Fully qualified ECR runner image."
}

variable "instance_types" {
  type        = list(string)
  description = "Memory-rich Spot instance types."
}

variable "max_vcpus" {
  type        = number
  description = "Maximum Spot fleet vCPUs."
}

variable "root_volume_gib" {
  type        = number
  description = "Encrypted gp3 root volume size."
}

variable "default_vcpus" {
  type        = number
  description = "Default job vCPU reservation."
}

variable "default_memory_mib" {
  type        = number
  description = "Default job memory reservation."
}

variable "job_timeout_seconds" {
  type        = number
  description = "Maximum duration of one job attempt."
}

variable "otlp_endpoint" {
  type        = string
  description = "Optional private ADOT HTTP endpoint."
  default     = null
}

variable "secret_environment" {
  type        = map(string)
  description = "Environment variable to Secrets Manager ARN mapping; only ARNs enter Terraform state."
  default     = {}
}

variable "permissions_boundary_arn" {
  type        = string
  description = "Optional permissions boundary policy ARN attached to IAM roles created by this module."
  default     = null
}
