data "aws_iam_policy_document" "batch_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["batch.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "batch_service" {
  name                 = "${var.name}-batch-service"
  assume_role_policy   = data.aws_iam_policy_document.batch_assume.json
  permissions_boundary = var.permissions_boundary_arn
}

resource "aws_iam_role_policy_attachment" "batch_service" {
  role       = aws_iam_role.batch_service.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBatchServiceRole"
}

data "aws_iam_policy_document" "spot_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["spotfleet.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "spot_fleet" {
  name                 = "${var.name}-spot-fleet"
  assume_role_policy   = data.aws_iam_policy_document.spot_assume.json
  permissions_boundary = var.permissions_boundary_arn
}

resource "aws_iam_role_policy_attachment" "spot_fleet" {
  role       = aws_iam_role.spot_fleet.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEC2SpotFleetTaggingRole"
}

resource "aws_launch_template" "batch" {
  name_prefix            = "${var.name}-batch-"
  update_default_version = true

  block_device_mappings {
    device_name = "/dev/xvda"

    ebs {
      delete_on_termination = true
      encrypted             = true
      volume_size           = var.root_volume_gib
      volume_type           = "gp3"
      iops                  = 6000
      throughput            = 250
    }
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_put_response_hop_limit = 2
    http_tokens                 = "required"
  }

  tag_specifications {
    resource_type = "instance"

    tags = {
      Name = "${var.name}-batch-worker"
    }
  }

  tag_specifications {
    resource_type = "volume"

    tags = {
      Name = "${var.name}-batch-cache"
    }
  }
}

resource "aws_batch_compute_environment" "spot" {
  compute_environment_name_prefix = "${var.name}-spot-"
  service_role                    = aws_iam_role.batch_service.arn
  state                           = "ENABLED"
  type                            = "MANAGED"

  compute_resources {
    type                = "SPOT"
    allocation_strategy = "SPOT_CAPACITY_OPTIMIZED"
    bid_percentage      = 100
    min_vcpus           = 0
    desired_vcpus       = 0
    max_vcpus           = var.max_vcpus
    instance_role       = var.instance_profile_arn
    instance_type       = var.instance_types
    security_group_ids  = var.security_group_ids
    subnets             = var.private_subnet_ids
    spot_iam_fleet_role = aws_iam_role.spot_fleet.arn

    launch_template {
      launch_template_id = aws_launch_template.batch.id
      version            = "$Latest"
    }

    tags = {
      Name = "${var.name}-batch-worker"
    }
  }

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [
    aws_iam_role_policy_attachment.batch_service,
    aws_iam_role_policy_attachment.spot_fleet,
  ]
}

resource "aws_batch_job_queue" "runner" {
  name     = "${var.name}-runner"
  state    = "ENABLED"
  priority = 100

  compute_environment_order {
    order               = 1
    compute_environment = aws_batch_compute_environment.spot.arn
  }
}

resource "aws_cloudwatch_log_group" "runner" {
  name              = "/aws/hyperkit/${var.name}/batch"
  retention_in_days = 30
}

locals {
  runner_environment = concat(
    [
      {
        name  = "AWS_REGION"
        value = var.aws_region
      },
    ],
    var.otlp_endpoint == null ? [] : [
      {
        name  = "OTEL_EXPORTER_OTLP_ENDPOINT"
        value = var.otlp_endpoint
      },
      {
        name  = "OTEL_EXPORTER_OTLP_PROTOCOL"
        value = "http/protobuf"
      },
    ],
  )
}

resource "aws_batch_job_definition" "runner" {
  name                  = "${var.name}-runner"
  type                  = "container"
  platform_capabilities = ["EC2"]
  propagate_tags        = true

  container_properties = jsonencode({
    image            = var.runner_image
    jobRoleArn       = var.job_role_arn
    executionRoleArn = var.job_role_arn
    privileged       = true
    environment      = local.runner_environment
    secrets = [
      for environment_name, secret_arn in var.secret_environment : {
        name      = environment_name
        valueFrom = secret_arn
      }
    ]
    resourceRequirements = [
      {
        type  = "VCPU"
        value = tostring(var.default_vcpus)
      },
      {
        type  = "MEMORY"
        value = tostring(var.default_memory_mib)
      },
    ]
    volumes = [
      {
        name = "docker-socket"
        host = {
          sourcePath = "/var/run/docker.sock"
        }
      },
    ]
    mountPoints = [
      {
        sourceVolume  = "docker-socket"
        containerPath = "/var/run/docker.sock"
        readOnly      = false
      },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.runner.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "runner"
      }
    }
  })

  retry_strategy {
    attempts = 3

    evaluate_on_exit {
      action           = "RETRY"
      on_status_reason = "Host EC2*"
    }

    evaluate_on_exit {
      action    = "EXIT"
      on_reason = "*"
    }
  }

  timeout {
    attempt_duration_seconds = var.job_timeout_seconds
  }
}
