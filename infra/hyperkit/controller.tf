resource "aws_sqs_queue" "controller_results_dlq" {
  name                      = "${local.name}-controller-results-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "controller_results" {
  name                       = "${local.name}-controller-results"
  message_retention_seconds  = 1209600
  receive_wait_time_seconds  = 20
  visibility_timeout_seconds = 300
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.controller_results_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "controller_results_dlq" {
  queue_url = aws_sqs_queue.controller_results_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.controller_results.arn]
  })
}

data "aws_iam_policy_document" "controller_results_queue" {
  statement {
    sid     = "AllowArtifactBucketNotifications"
    effect  = "Allow"
    actions = ["sqs:SendMessage"]
    resources = [
      aws_sqs_queue.controller_results.arn,
    ]

    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [module.storage.bucket_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sqs_queue_policy" "controller_results" {
  queue_url = aws_sqs_queue.controller_results.id
  policy    = data.aws_iam_policy_document.controller_results_queue.json
}

resource "aws_s3_bucket_notification" "controller_results" {
  bucket = module.storage.bucket_name

  queue {
    queue_arn     = aws_sqs_queue.controller_results.arn
    events        = ["s3:ObjectCreated:*"]
    filter_prefix = var.controller_s3_prefix
    filter_suffix = ".json"
  }

  depends_on = [aws_sqs_queue_policy.controller_results]
}

module "controller" {
  source = "./modules/controller"

  name                 = local.name
  aws_region           = var.aws_region
  ecs_cluster_name     = module.observability.ecs_cluster_name
  private_subnet_ids   = module.network.private_subnet_ids
  security_group_id    = module.network.controller_security_group_id
  controller_image     = "${module.registry.controller_repository_url}:${var.controller_image_tag}"
  desired_count        = var.controller_desired_count
  poll_interval        = var.controller_poll_interval
  artifact_bucket_name = module.storage.bucket_name
  artifact_bucket_arn  = module.storage.bucket_arn
  artifact_prefix      = var.controller_s3_prefix
  sweep_id             = var.controller_sweep_id
  queue_url            = aws_sqs_queue.controller_results.id
  queue_arn            = aws_sqs_queue.controller_results.arn
  otlp_endpoint        = module.observability.otlp_http_endpoint
  secret_environment   = local.controller_secret_environment

  depends_on = [
    aws_s3_bucket_notification.controller_results,
    module.observability,
  ]
}
