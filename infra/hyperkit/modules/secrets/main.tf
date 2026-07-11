resource "aws_secretsmanager_secret" "this" {
  for_each = var.secret_names

  name                    = each.value
  description             = "Hyperkit-managed empty secret container; value is populated outside Terraform"
  recovery_window_in_days = 30

  tags = {
    Name = each.value
  }
}

locals {
  readable_secret_arns = toset(concat(
    [for name, secret in aws_secretsmanager_secret.this : secret.arn if contains(var.job_readable_secret_names, name)],
    tolist(var.external_secret_arns),
  ))
  log_group_arn = "arn:aws:logs:${var.aws_region}:${var.account_id}:log-group:/aws/hyperkit/${var.name}*"
}

data "aws_iam_policy_document" "job_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "job" {
  name               = "${var.name}-batch-job"
  assume_role_policy = data.aws_iam_policy_document.job_assume.json
}

data "aws_iam_policy_document" "job" {
  statement {
    sid = "ArtifactBucketMetadata"
    actions = [
      "s3:GetBucketLocation",
      "s3:ListBucket",
      "s3:ListBucketMultipartUploads",
    ]
    resources = [var.artifact_bucket_arn]
  }

  statement {
    sid = "ArtifactObjects"
    actions = [
      "s3:AbortMultipartUpload",
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:ListMultipartUploadParts",
      "s3:PutObject",
    ]
    resources = ["${var.artifact_bucket_arn}/*"]
  }

  dynamic "statement" {
    for_each = length(local.readable_secret_arns) == 0 ? [] : [local.readable_secret_arns]

    content {
      sid       = "ReadConfiguredSecrets"
      actions   = ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]
      resources = statement.value
    }
  }

  statement {
    sid       = "EcrAuthorization"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  dynamic "statement" {
    for_each = length(var.ecr_repository_arns) == 0 ? [] : [var.ecr_repository_arns]

    content {
      sid = "PullRunnerManagedImages"
      actions = [
        "ecr:BatchCheckLayerAvailability",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer",
      ]
      resources = statement.value
    }
  }

  statement {
    sid = "WriteHyperkitLogs"
    actions = [
      "logs:CreateLogStream",
      "logs:DescribeLogStreams",
      "logs:PutLogEvents",
    ]
    resources = [local.log_group_arn, "${local.log_group_arn}:*"]
  }

  statement {
    sid       = "WriteHyperkitMetrics"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["Hyperkit"]
    }
  }

}

resource "aws_iam_role_policy" "job" {
  name   = "${var.name}-batch-job"
  role   = aws_iam_role.job.id
  policy = data.aws_iam_policy_document.job.json
}

data "aws_iam_policy_document" "instance_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "instance" {
  name               = "${var.name}-batch-instance"
  assume_role_policy = data.aws_iam_policy_document.instance_assume.json
}

resource "aws_iam_role_policy_attachment" "instance_ecs" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role"
}

data "aws_iam_policy_document" "instance_ecr" {
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = var.ecr_repository_arns
  }
}

resource "aws_iam_role_policy" "instance_ecr" {
  name   = "${var.name}-ecr-pull"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.instance_ecr.json
}

resource "aws_iam_instance_profile" "batch" {
  name = "${var.name}-batch"
  role = aws_iam_role.instance.name
}
