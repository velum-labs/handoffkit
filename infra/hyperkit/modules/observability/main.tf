locals {
  alb_name                = substr("${var.name}-grafana", 0, 32)
  athena_output_location  = "s3://${var.artifact_bucket_name}/athena-results/"
  service_namespace       = "${var.name}.local"
  tailscale_parameter_arn = "arn:aws:ssm:${var.aws_region}:${var.account_id}:parameter${var.tailscale_auth_parameter_name}"
}

resource "aws_prometheus_workspace" "this" {
  alias = "${var.name}-metrics"
}

resource "aws_athena_workgroup" "grafana" {
  name  = "${var.name}-grafana"
  state = "ENABLED"

  configuration {
    enforce_workgroup_configuration    = true
    publish_cloudwatch_metrics_enabled = true

    result_configuration {
      output_location = local.athena_output_location

      encryption_configuration {
        encryption_option = "SSE_S3"
      }
    }
  }
}

resource "aws_ecs_cluster" "observability" {
  name = "${var.name}-observability"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "grafana" {
  name              = "/aws/hyperkit/${var.name}/grafana"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "adot" {
  name              = "/aws/hyperkit/${var.name}/adot"
  retention_in_days = 30
}

data "aws_iam_policy_document" "ecs_task_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name                 = "${var.name}-observability-execution"
  assume_role_policy   = data.aws_iam_policy_document.ecs_task_assume.json
  permissions_boundary = var.permissions_boundary_arn
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secret" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.grafana_admin_secret_arn]
  }
}

resource "aws_iam_role_policy" "execution_secret" {
  name   = "${var.name}-grafana-admin-secret"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secret.json
}

resource "aws_iam_role" "task" {
  name                 = "${var.name}-observability-task"
  assume_role_policy   = data.aws_iam_policy_document.ecs_task_assume.json
  permissions_boundary = var.permissions_boundary_arn
}

data "aws_iam_policy_document" "task" {
  statement {
    sid = "PrometheusReadWrite"
    actions = [
      "aps:GetLabels",
      "aps:GetMetricMetadata",
      "aps:GetSeries",
      "aps:QueryMetrics",
      "aps:RemoteWrite",
    ]
    resources = [aws_prometheus_workspace.this.arn]
  }

  statement {
    sid = "CloudWatchRead"
    actions = [
      "cloudwatch:DescribeAlarmsForMetric",
      "cloudwatch:DescribeAlarms",
      "cloudwatch:DescribeAnomalyDetectors",
      "cloudwatch:DescribeInsightRules",
      "cloudwatch:GetMetricData",
      "cloudwatch:GetMetricStatistics",
      "cloudwatch:GetMetricStream",
      "cloudwatch:GetInsightRuleReport",
      "cloudwatch:ListDashboards",
      "cloudwatch:ListManagedInsightRules",
      "cloudwatch:ListMetrics",
    ]
    resources = ["*"]
  }

  statement {
    sid = "CloudWatchLogsRead"
    actions = [
      "logs:DescribeLogGroups",
      "logs:GetLogEvents",
      "logs:GetLogGroupFields",
      "logs:GetLogRecord",
      "logs:StartQuery",
      "logs:StopQuery",
      "logs:GetQueryResults",
    ]
    resources = ["*"]
  }

  statement {
    sid = "XRayReadWrite"
    actions = [
      "xray:BatchGetTraces",
      "xray:GetGroups",
      "xray:GetInsight",
      "xray:GetInsightEvents",
      "xray:GetInsightImpactGraph",
      "xray:GetInsightSummaries",
      "xray:GetSamplingRules",
      "xray:GetSamplingStatisticSummaries",
      "xray:GetSamplingTargets",
      "xray:GetServiceGraph",
      "xray:GetTimeSeriesServiceStatistics",
      "xray:GetTraceGraph",
      "xray:GetTraceSummaries",
      "xray:PutTelemetryRecords",
      "xray:PutTraceSegments",
    ]
    resources = ["*"]
  }

  statement {
    sid = "AthenaQueries"
    actions = [
      "athena:GetDatabase",
      "athena:GetDataCatalog",
      "athena:GetQueryExecution",
      "athena:GetQueryResults",
      "athena:GetTableMetadata",
      "athena:ListDatabases",
      "athena:ListDataCatalogs",
      "athena:ListTableMetadata",
      "athena:StartQueryExecution",
      "athena:StopQueryExecution",
    ]
    resources = ["*"]
  }

  statement {
    sid = "GlueCatalogRead"
    actions = [
      "glue:GetDatabase",
      "glue:GetDatabases",
      "glue:GetPartition",
      "glue:GetPartitions",
      "glue:GetTable",
      "glue:GetTables",
    ]
    resources = [
      "arn:aws:glue:${var.aws_region}:${var.account_id}:catalog",
      "arn:aws:glue:${var.aws_region}:${var.account_id}:database/${var.glue_database_name}",
      "arn:aws:glue:${var.aws_region}:${var.account_id}:table/${var.glue_database_name}/*",
    ]
  }

  statement {
    sid = "ArtifactLakeRead"
    actions = [
      "s3:GetBucketLocation",
      "s3:ListBucket",
    ]
    resources = [var.artifact_bucket_arn]
  }

  statement {
    sid = "ArtifactAndAthenaResults"
    actions = [
      "s3:AbortMultipartUpload",
      "s3:GetObject",
      "s3:ListMultipartUploadParts",
      "s3:PutObject",
    ]
    resources = ["${var.artifact_bucket_arn}/*"]
  }
}

resource "aws_iam_role_policy" "task" {
  name   = "${var.name}-observability"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}

locals {
  adot_config = <<-YAML
    extensions:
      sigv4auth:
        region: ${var.aws_region}
        service: aps
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
          http:
            endpoint: 0.0.0.0:4318
      prometheus:
        config:
          scrape_configs:
            - job_name: adot-collector
              scrape_interval: 30s
              static_configs:
                - targets: ["127.0.0.1:8888"]
    processors:
      memory_limiter:
        check_interval: 1s
        limit_mib: 384
      batch:
        timeout: 5s
        send_batch_size: 1024
    exporters:
      prometheusremotewrite:
        endpoint: ${aws_prometheus_workspace.this.prometheus_endpoint}api/v1/remote_write
        translation_strategy: UnderscoreEscapingWithSuffixes
        auth:
          authenticator: sigv4auth
      awsxray:
        region: ${var.aws_region}
    service:
      extensions: [sigv4auth]
      pipelines:
        metrics:
          receivers: [otlp, prometheus]
          processors: [memory_limiter, batch]
          exporters: [prometheusremotewrite]
        traces:
          receivers: [otlp]
          processors: [memory_limiter, batch]
          exporters: [awsxray]
  YAML
}

resource "aws_ecs_task_definition" "observability" {
  family                   = "${var.name}-observability"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "1024"
  memory                   = "2048"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name      = "grafana"
      image     = var.grafana_image
      essential = true
      cpu       = 768
      memory    = 1536
      portMappings = [
        {
          name          = "grafana"
          containerPort = 3000
          hostPort      = 3000
          protocol      = "tcp"
          appProtocol   = "http"
        },
      ]
      environment = [
        {
          name  = "AWS_REGION"
          value = var.aws_region
        },
        {
          name  = "AWS_SDK_LOAD_CONFIG"
          value = "true"
        },
        {
          name  = "AMP_ENDPOINT"
          value = aws_prometheus_workspace.this.prometheus_endpoint
        },
        {
          name  = "ATHENA_DATABASE"
          value = var.glue_database_name
        },
        {
          name  = "ATHENA_OUTPUT"
          value = local.athena_output_location
        },
        {
          name  = "ATHENA_WORKGROUP"
          value = aws_athena_workgroup.grafana.name
        },
        {
          name  = "GF_AUTH_ANONYMOUS_ENABLED"
          value = "false"
        },
        {
          name  = "GF_AUTH_SIGV4_AUTH_ENABLED"
          value = "true"
        },
        {
          name  = "GF_USERS_ALLOW_SIGN_UP"
          value = "false"
        },
      ]
      secrets = [
        {
          name      = "GF_SECURITY_ADMIN_PASSWORD"
          valueFrom = var.grafana_admin_secret_arn
        },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.grafana.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "grafana"
        }
      }
    },
    {
      name      = "adot"
      image     = var.adot_collector_image
      essential = true
      cpu       = 256
      memory    = 512
      command   = ["--config=env:AOT_CONFIG_CONTENT"]
      portMappings = [
        {
          name          = "otlp-grpc"
          containerPort = 4317
          hostPort      = 4317
          protocol      = "tcp"
        },
        {
          name          = "otlp-http"
          containerPort = 4318
          hostPort      = 4318
          protocol      = "tcp"
        },
      ]
      environment = [
        {
          name  = "AOT_CONFIG_CONTENT"
          value = local.adot_config
        },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.adot.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "adot"
        }
      }
    },
  ])

  depends_on = [
    aws_iam_role_policy_attachment.execution,
    aws_iam_role_policy.execution_secret,
  ]
}

data "aws_ami" "tailscale_connector" {
  most_recent = true
  owners      = ["099720109477"]

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "tailscale_connector" {
  name                 = substr("${var.name}-tailscale-connector", 0, 64)
  assume_role_policy   = data.aws_iam_policy_document.ec2_assume.json
  permissions_boundary = var.permissions_boundary_arn
}

data "aws_iam_policy_document" "tailscale_connector" {
  statement {
    actions   = ["ssm:GetParameter"]
    resources = [local.tailscale_parameter_arn]
  }
}

resource "aws_iam_role_policy" "tailscale_connector" {
  name   = "read-tailscale-auth-key"
  role   = aws_iam_role.tailscale_connector.id
  policy = data.aws_iam_policy_document.tailscale_connector.json
}

resource "aws_iam_instance_profile" "tailscale_connector" {
  name = substr("${var.name}-tailscale-connector", 0, 128)
  role = aws_iam_role.tailscale_connector.name
}

resource "aws_security_group" "tailscale_connector" {
  name_prefix = "${var.name}-tailscale-"
  description = "Outbound-only Tailscale connector for internal Grafana"
  vpc_id      = var.vpc_id

  tags = {
    Name = "${var.name}-tailscale-connector"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_egress_rule" "tailscale_connector" {
  security_group_id = aws_security_group.tailscale_connector.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "Tailscale coordination, DERP, and internal Grafana"
}

resource "aws_vpc_security_group_ingress_rule" "grafana_from_tailnet" {
  security_group_id            = var.alb_security_group_id
  referenced_security_group_id = aws_security_group.tailscale_connector.id
  from_port                    = 80
  to_port                      = 80
  ip_protocol                  = "tcp"
  description                  = "Grafana proxy traffic from the Tailscale connector"
}

resource "aws_lb" "grafana" {
  name                       = local.alb_name
  internal                   = true
  load_balancer_type         = "application"
  security_groups            = [var.alb_security_group_id]
  subnets                    = var.private_subnet_ids
  drop_invalid_header_fields = true
  enable_deletion_protection = true
}

resource "aws_lb_target_group" "grafana" {
  name                 = local.alb_name
  port                 = 3000
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30

  health_check {
    enabled             = true
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
    path                = "/api/health"
    protocol            = "HTTP"
    timeout             = 5
    matcher             = "200"
  }
}

resource "aws_lb_listener" "grafana" {
  load_balancer_arn = aws_lb.grafana.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.grafana.arn
  }
}

resource "aws_instance" "tailscale_connector" {
  ami                         = data.aws_ami.tailscale_connector.id
  instance_type               = var.tailscale_connector_instance_type
  subnet_id                   = var.public_subnet_ids[0]
  associate_public_ip_address = true
  vpc_security_group_ids      = [aws_security_group.tailscale_connector.id]
  iam_instance_profile        = aws_iam_instance_profile.tailscale_connector.name

  user_data = <<-EOT
    #!/bin/bash
    set -euo pipefail
    apt-get update -qq
    apt-get install -y -qq curl
    curl -fsSL https://tailscale.com/install.sh | sh
    snap install aws-cli --classic || apt-get install -y -qq awscli
    tailscale_auth_key="$(
      aws ssm get-parameter \
        --region ${var.aws_region} \
        --name ${var.tailscale_auth_parameter_name} \
        --with-decryption \
        --query Parameter.Value \
        --output text
    )"
    tailscale up \
      --auth-key="$tailscale_auth_key" \
      --hostname=${var.tailscale_hostname} \
      --accept-routes=false
    unset tailscale_auth_key
    tailscale serve --bg http://${aws_lb.grafana.dns_name}:80
  EOT

  metadata_options {
    http_tokens = "required"
  }

  root_block_device {
    encrypted   = true
    volume_size = 8
    volume_type = "gp3"
  }

  tags = {
    Name = "${var.name}-tailscale-connector"
  }

  depends_on = [
    aws_iam_role_policy.tailscale_connector,
    aws_lb_listener.grafana,
  ]
}

resource "aws_service_discovery_private_dns_namespace" "observability" {
  name        = local.service_namespace
  description = "Private Hyperkit telemetry service discovery"
  vpc         = var.vpc_id
}

resource "aws_service_discovery_service" "adot" {
  name = "adot"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.observability.id

    dns_records {
      ttl  = 10
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {
    failure_threshold = 1
  }
}

resource "aws_ecs_service" "observability" {
  name                              = "${var.name}-observability"
  cluster                           = aws_ecs_cluster.observability.id
  task_definition                   = aws_ecs_task_definition.observability.arn
  desired_count                     = var.desired_count
  launch_type                       = "FARGATE"
  platform_version                  = "LATEST"
  health_check_grace_period_seconds = 90
  enable_ecs_managed_tags           = true
  propagate_tags                    = "SERVICE"

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    assign_public_ip = false
    security_groups  = [var.service_security_group_id]
    subnets          = var.private_subnet_ids
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.grafana.arn
    container_name   = "grafana"
    container_port   = 3000
  }

  service_registries {
    registry_arn = aws_service_discovery_service.adot.arn
  }

  depends_on = [aws_lb_listener.grafana]
}
