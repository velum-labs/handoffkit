data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  availability_zones = length(var.availability_zones) > 0 ? slice(var.availability_zones, 0, 2) : slice(data.aws_availability_zones.available.names, 0, 2)
  nat_gateway_count  = var.single_nat_gateway ? 1 : 2
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "${var.name}-vpc"
  }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name = "${var.name}-igw"
  }
}

resource "aws_subnet" "public" {
  count = 2

  vpc_id                  = aws_vpc.this.id
  availability_zone       = local.availability_zones[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, count.index)
  map_public_ip_on_launch = false

  tags = {
    Name = "${var.name}-public-${local.availability_zones[count.index]}"
    Tier = "public"
  }
}

resource "aws_subnet" "private" {
  count = 2

  vpc_id            = aws_vpc.this.id
  availability_zone = local.availability_zones[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, count.index + 8)

  tags = {
    Name = "${var.name}-private-${local.availability_zones[count.index]}"
    Tier = "private"
  }
}

resource "aws_eip" "nat" {
  count = local.nat_gateway_count

  domain = "vpc"

  tags = {
    Name = "${var.name}-nat-${count.index + 1}"
  }

  depends_on = [aws_internet_gateway.this]
}

resource "aws_nat_gateway" "this" {
  count = local.nat_gateway_count

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags = {
    Name = "${var.name}-nat-${count.index + 1}"
  }

  depends_on = [aws_internet_gateway.this]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name = "${var.name}-public"
  }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count = 2

  route_table_id = aws_route_table.public.id
  subnet_id      = aws_subnet.public[count.index].id
}

resource "aws_route_table" "private" {
  count = 2

  vpc_id = aws_vpc.this.id

  tags = {
    Name = "${var.name}-private-${local.availability_zones[count.index]}"
  }
}

resource "aws_route" "private_internet" {
  count = 2

  route_table_id         = aws_route_table.private[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[var.single_nat_gateway ? 0 : count.index].id
}

resource "aws_route_table_association" "private" {
  count = 2

  route_table_id = aws_route_table.private[count.index].id
  subnet_id      = aws_subnet.private[count.index].id
}

resource "aws_security_group" "batch" {
  name_prefix = "${var.name}-batch-"
  description = "No-ingress Batch worker security group"
  vpc_id      = aws_vpc.this.id

  tags = {
    Name = "${var.name}-batch"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_egress_rule" "batch" {
  security_group_id = aws_security_group.batch.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "Outbound access for registries, AWS APIs, and model providers"
}

resource "aws_security_group" "controller" {
  name_prefix = "${var.name}-controller-"
  description = "No-ingress Hyperkit controller security group"
  vpc_id      = aws_vpc.this.id

  tags = {
    Name = "${var.name}-controller"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_egress_rule" "controller" {
  security_group_id = aws_security_group.controller.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "Outbound access to AWS APIs and the private ADOT endpoint"
}

resource "aws_security_group" "grafana_alb" {
  name_prefix = "${var.name}-grafana-alb-"
  description = "Tailnet connector ingress to the internal Grafana ALB"
  vpc_id      = aws_vpc.this.id

  tags = {
    Name = "${var.name}-grafana-alb"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_egress_rule" "grafana_alb" {
  security_group_id = aws_security_group.grafana_alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "Forward requests to Grafana targets"
}

resource "aws_security_group" "observability" {
  name_prefix = "${var.name}-observability-"
  description = "Grafana and ADOT Fargate task security group"
  vpc_id      = aws_vpc.this.id

  tags = {
    Name = "${var.name}-observability"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "observability_grafana" {
  security_group_id            = aws_security_group.observability.id
  referenced_security_group_id = aws_security_group.grafana_alb.id
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
  description                  = "Grafana traffic from the ALB"
}

resource "aws_vpc_security_group_ingress_rule" "observability_otlp_grpc" {
  security_group_id            = aws_security_group.observability.id
  referenced_security_group_id = aws_security_group.batch.id
  from_port                    = 4317
  to_port                      = 4317
  ip_protocol                  = "tcp"
  description                  = "OTLP gRPC telemetry from Batch workers"
}

resource "aws_vpc_security_group_ingress_rule" "observability_otlp_http" {
  security_group_id            = aws_security_group.observability.id
  referenced_security_group_id = aws_security_group.batch.id
  from_port                    = 4318
  to_port                      = 4318
  ip_protocol                  = "tcp"
  description                  = "OTLP HTTP telemetry from Batch workers"
}

resource "aws_vpc_security_group_ingress_rule" "observability_controller_otlp_grpc" {
  security_group_id            = aws_security_group.observability.id
  referenced_security_group_id = aws_security_group.controller.id
  from_port                    = 4317
  to_port                      = 4317
  ip_protocol                  = "tcp"
  description                  = "OTLP gRPC telemetry from the Hyperkit controller"
}

resource "aws_vpc_security_group_ingress_rule" "observability_controller_otlp_http" {
  security_group_id            = aws_security_group.observability.id
  referenced_security_group_id = aws_security_group.controller.id
  from_port                    = 4318
  to_port                      = 4318
  ip_protocol                  = "tcp"
  description                  = "OTLP HTTP telemetry from the Hyperkit controller"
}

resource "aws_vpc_security_group_egress_rule" "observability" {
  security_group_id = aws_security_group.observability.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "AWS APIs and external plugin access"
}
