variable "name" {
  type        = string
  description = "Resource name prefix."
}

variable "bucket_name" {
  type        = string
  description = "Optional globally unique bucket name."
  default     = null
}

variable "force_destroy" {
  type        = bool
  description = "Whether Terraform may delete a non-empty bucket."
  default     = false
}

variable "noncurrent_retention_days" {
  type        = number
  description = "Retention for noncurrent artifact versions."
  default     = 90
}
