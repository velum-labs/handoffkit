variable "name" {
  type        = string
  description = "Resource name prefix."
}

variable "vpc_cidr" {
  type        = string
  description = "VPC IPv4 CIDR."
}

variable "availability_zones" {
  type        = list(string)
  description = "Optional availability-zone override."
  default     = []
}

variable "single_nat_gateway" {
  type        = bool
  description = "Whether both private subnets share one NAT gateway."
  default     = false
}
