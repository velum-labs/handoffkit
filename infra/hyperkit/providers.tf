provider "aws" {
  region = var.aws_region

  default_tags {
    tags = merge(
      {
        Application = "hyperkit"
        Environment = var.environment
        ManagedBy   = "terraform"
        Project     = var.project_name
      },
      var.tags,
    )
  }
}
