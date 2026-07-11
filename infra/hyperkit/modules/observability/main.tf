locals {
  alb_name               = substr("${var.name}-grafana", 0, 32)
  athena_output_location = "s3://${var.artifact_bucket_name}/athena-results/"
  listener_is_https      = var.grafana_certificate_arn != null
  service_namespace      = "${var.name}.local"
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
  name               = "${var.name}-observability-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
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
  name               = "${var.name}-observability-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
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

resource "aws_lb" "grafana" {
  name                       = local.alb_name
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [var.alb_security_group_id]
  subnets                    = var.public_subnet_ids
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
  port              = local.listener_is_https ? 443 : 80
  protocol          = local.listener_is_https ? "HTTPS" : "HTTP"
  certificate_arn   = var.grafana_certificate_arn
  ssl_policy        = local.listener_is_https ? "ELBSecurityPolicy-TLS13-1-2-2021-06" : null

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.grafana.arn
  }
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
