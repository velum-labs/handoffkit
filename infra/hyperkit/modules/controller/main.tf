locals {
  log_group_name = "/aws/hyperkit/${var.name}/controller"
  environment = concat(
    [
      {
        name  = "AWS_REGION"
        value = var.aws_region
      },
      {
        name  = "HYPERKIT_S3_BUCKET"
        value = var.artifact_bucket_name
      },
      {
        name  = "HYPERKIT_S3_PREFIX"
        value = var.artifact_prefix
      },
      {
        name  = "HYPERKIT_SQS_QUEUE_URL"
        value = var.queue_url
      },
      {
        name  = "HYPERKIT_POLL_INTERVAL"
        value = tostring(var.poll_interval)
      },
      {
        name  = "OTEL_EXPORTER_OTLP_ENDPOINT"
        value = var.otlp_endpoint
      },
    ],
    var.sweep_id == null ? [] : [
      {
        name  = "HYPERKIT_SWEEP_ID"
        value = var.sweep_id
      },
    ],
  )
  secrets = [
    for environment_name in sort(keys(var.secret_environment)) : {
      name      = environment_name
      valueFrom = var.secret_environment[environment_name]
    }
  ]
}

resource "aws_cloudwatch_log_group" "controller" {
  name              = local.log_group_name
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
  name               = "${var.name}-controller-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  count = length(var.secret_environment) == 0 ? 0 : 1

  statement {
    sid       = "ReadConfiguredSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = values(var.secret_environment)
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  count = length(var.secret_environment) == 0 ? 0 : 1

  name   = "${var.name}-controller-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets[0].json
}

resource "aws_iam_role" "task" {
  name               = "${var.name}-controller-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
}

data "aws_iam_policy_document" "task" {
  statement {
    sid       = "LocateArtifactBucket"
    actions   = ["s3:GetBucketLocation"]
    resources = [var.artifact_bucket_arn]
  }

  statement {
    sid       = "ListRunArtifacts"
    actions   = ["s3:ListBucket"]
    resources = [var.artifact_bucket_arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["${var.artifact_prefix}*"]
    }
  }

  statement {
    sid = "ReadRunArtifacts"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]
    resources = ["${var.artifact_bucket_arn}/${var.artifact_prefix}*"]
  }

  statement {
    sid = "ConsumeResultNotifications"
    actions = [
      "sqs:ChangeMessageVisibility",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl",
      "sqs:ReceiveMessage",
    ]
    resources = [var.queue_arn]
  }
}

resource "aws_iam_role_policy" "task" {
  name   = "${var.name}-controller"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}

resource "aws_ecs_task_definition" "controller" {
  family                   = "${var.name}-controller"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name        = "controller"
      image       = var.controller_image
      essential   = true
      cpu         = 512
      memory      = 1024
      stopTimeout = 120
      environment = local.environment
      secrets     = local.secrets
      linuxParameters = {
        initProcessEnabled = true
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.controller.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "controller"
        }
      }
    },
  ])

  depends_on = [
    aws_iam_role_policy_attachment.execution,
    aws_iam_role_policy.execution_secrets,
  ]
}

resource "aws_ecs_service" "controller" {
  name                    = "${var.name}-controller"
  cluster                 = var.ecs_cluster_name
  task_definition         = aws_ecs_task_definition.controller.arn
  desired_count           = var.desired_count
  launch_type             = "FARGATE"
  platform_version        = "LATEST"
  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    assign_public_ip = false
    security_groups  = [var.security_group_id]
    subnets          = var.private_subnet_ids
  }
}
