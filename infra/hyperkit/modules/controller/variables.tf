variable "name" {
  type        = string
  description = "Resource name prefix."
}

variable "aws_region" {
  type        = string
  description = "AWS region."
}

variable "ecs_cluster_name" {
  type        = string
  description = "ECS cluster in which to run the controller service."
}

variable "private_subnet_ids" {
  type        = list(string)
  description = "Private subnets for the Fargate controller."
}

variable "security_group_id" {
  type        = string
  description = "No-ingress security group for the controller task."
}

variable "controller_image" {
  type        = string
  description = "Controller image URI in ECR."
}

variable "desired_count" {
  type        = number
  description = "Always-on controller task count."
  default     = 1
}

variable "poll_interval" {
  type        = number
  description = "Controller reconciliation poll interval in seconds."
  default     = 30
}

variable "artifact_bucket_name" {
  type        = string
  description = "Artifact-lake bucket name."
}

variable "artifact_bucket_arn" {
  type        = string
  description = "Artifact-lake bucket ARN."
}

variable "artifact_prefix" {
  type        = string
  description = "S3 key prefix watched by the controller."
  default     = "runs/"
}

variable "sweep_id" {
  type        = string
  description = "Optional sweep ID restricting controller aggregation."
  default     = null
  nullable    = true
}

variable "queue_url" {
  type        = string
  description = "SQS results-notification queue URL."
}

variable "queue_arn" {
  type        = string
  description = "SQS results-notification queue ARN."
}

variable "otlp_endpoint" {
  type        = string
  description = "Private ADOT OTLP/HTTP endpoint."
}

variable "secret_environment" {
  type        = map(string)
  description = "Controller environment variable to Secrets Manager ARN mapping."
  default     = {}
}
