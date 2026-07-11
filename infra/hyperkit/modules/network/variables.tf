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

variable "grafana_allowed_cidrs" {
  type        = set(string)
  description = "CIDRs allowed to reach the Grafana ALB."
  default     = []
}

variable "grafana_listener_port" {
  type        = number
  description = "Public ALB listener port."
  default     = 443
}
