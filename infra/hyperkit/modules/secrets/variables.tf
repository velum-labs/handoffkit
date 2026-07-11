variable "name" {
  type        = string
  description = "Resource name prefix."
}

variable "aws_region" {
  type        = string
  description = "AWS region used in scoped IAM ARNs."
}

variable "account_id" {
  type        = string
  description = "AWS account ID used in scoped IAM ARNs."
}

variable "secret_names" {
  type        = set(string)
  description = "Names of empty Secrets Manager containers to create."
  default     = []
}

variable "job_readable_secret_names" {
  type        = set(string)
  description = "Subset of managed secret names the Batch job role may read."
  default     = []
}

variable "external_secret_arns" {
  type        = set(string)
  description = "Existing secret ARNs the job role may read."
  default     = []
}

variable "artifact_bucket_arn" {
  type        = string
  description = "Artifact-lake bucket ARN."
}

variable "ecr_repository_arns" {
  type        = list(string)
  description = "ECR repositories that runner jobs may pull sibling images from."
  default     = []
}
