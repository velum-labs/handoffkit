data "aws_caller_identity" "current" {}

locals {
  name                        = "${var.project_name}-${var.environment}"
  grafana_admin_secret_name   = "${var.project_name}/${var.environment}/grafana-admin-password"
  create_grafana_admin_secret = var.grafana_admin_secret_arn == null
  job_managed_secret_names    = setunion(var.secret_names, toset(values(var.runner_managed_secret_environment)))
  base_managed_secret_names = setunion(
    local.job_managed_secret_names,
    toset(values(var.controller_managed_secret_environment)),
  )
  managed_secret_names          = local.create_grafana_admin_secret ? setunion(local.base_managed_secret_names, toset([local.grafana_admin_secret_name])) : local.base_managed_secret_names
  readable_external_secret_arns = setunion(var.external_secret_arns, toset(values(var.runner_external_secret_environment)))
  grafana_admin_secret_arn      = local.create_grafana_admin_secret ? module.secrets.secret_arns_by_name[local.grafana_admin_secret_name] : var.grafana_admin_secret_arn
  runner_secret_environment = merge(
    { for environment_name, secret_name in var.runner_managed_secret_environment : environment_name => module.secrets.secret_arns_by_name[secret_name] },
    var.runner_external_secret_environment,
  )
  controller_secret_environment = merge(
    { for environment_name, secret_name in var.controller_managed_secret_environment : environment_name => module.secrets.secret_arns_by_name[secret_name] },
    var.controller_external_secret_environment,
  )
}

module "network" {
  source = "./modules/network"

  name               = local.name
  vpc_cidr           = var.vpc_cidr
  availability_zones = var.availability_zones
  single_nat_gateway = var.single_nat_gateway
}

module "storage" {
  source = "./modules/storage"

  name                      = local.name
  bucket_name               = var.artifact_bucket_name
  force_destroy             = var.force_destroy_artifact_bucket
  noncurrent_retention_days = var.artifact_retention_days
}

module "registry" {
  source = "./modules/registry"

  name = local.name
}

module "secrets" {
  source = "./modules/secrets"

  name                      = local.name
  aws_region                = var.aws_region
  account_id                = data.aws_caller_identity.current.account_id
  secret_names              = local.managed_secret_names
  job_readable_secret_names = local.job_managed_secret_names
  external_secret_arns      = local.readable_external_secret_arns
  artifact_bucket_arn       = module.storage.bucket_arn
  ecr_repository_arns       = [module.registry.runner_repository_arn]
  permissions_boundary_arn  = var.iam_permissions_boundary_arn
}

module "batch" {
  source = "./modules/batch"

  name                 = local.name
  aws_region           = var.aws_region
  private_subnet_ids   = module.network.private_subnet_ids
  security_group_ids   = [module.network.batch_security_group_id]
  instance_profile_arn = module.secrets.batch_instance_profile_arn
  job_role_arn         = module.secrets.job_role_arn
  runner_image         = "${module.registry.runner_repository_url}:${var.runner_image_tag}"
  instance_types       = var.batch_instance_types
  max_vcpus            = var.batch_max_vcpus
  root_volume_gib      = var.batch_root_volume_gib
  default_vcpus        = var.batch_default_vcpus
  default_memory_mib   = var.batch_default_memory_mib
  job_timeout_seconds  = var.batch_job_timeout_seconds
  otlp_endpoint        = module.observability.otlp_http_endpoint
  secret_environment   = local.runner_secret_environment

  permissions_boundary_arn = var.iam_permissions_boundary_arn
}

module "observability" {
  source = "./modules/observability"

  name                              = local.name
  aws_region                        = var.aws_region
  account_id                        = data.aws_caller_identity.current.account_id
  vpc_id                            = module.network.vpc_id
  public_subnet_ids                 = module.network.public_subnet_ids
  private_subnet_ids                = module.network.private_subnet_ids
  alb_security_group_id             = module.network.grafana_alb_security_group_id
  service_security_group_id         = module.network.observability_security_group_id
  grafana_image                     = "${module.registry.grafana_repository_url}:${var.grafana_image_tag}"
  adot_collector_image              = var.adot_collector_image
  grafana_admin_secret_arn          = local.grafana_admin_secret_arn
  tailscale_auth_parameter_name     = var.tailscale_auth_parameter_name
  tailscale_hostname                = var.tailscale_grafana_hostname
  tailscale_dns_suffix              = var.tailscale_dns_suffix
  tailscale_connector_instance_type = var.tailscale_connector_instance_type
  desired_count                     = var.grafana_desired_count
  artifact_bucket_arn               = module.storage.bucket_arn
  artifact_bucket_name              = module.storage.bucket_name
  glue_database_name                = module.storage.glue_database_name
  permissions_boundary_arn          = var.iam_permissions_boundary_arn
}

resource "aws_budgets_budget" "monthly" {
  name         = "${local.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "notification" {
    for_each = var.budget_alert_email == null ? [] : ["actual", "forecasted"]

    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = var.budget_alert_threshold_percent
      threshold_type             = "PERCENTAGE"
      notification_type          = upper(notification.value)
      subscriber_email_addresses = [var.budget_alert_email]
    }
  }
}
