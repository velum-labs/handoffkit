resource "aws_s3_bucket" "artifacts" {
  bucket        = var.bucket_name
  bucket_prefix = var.bucket_name == null ? "${var.name}-artifacts-" : null
  force_destroy = var.force_destroy

  tags = {
    Name    = "${var.name}-artifact-lake"
    DataSet = "shard-results"
  }
}

resource "aws_s3_bucket_ownership_controls" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    id     = "artifact-hygiene"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_retention_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.artifacts]
}

resource "aws_glue_catalog_database" "hyperkit" {
  name        = replace("${var.name}_artifacts", "-", "_")
  description = "Hyperkit artifact-lake catalog"
}

resource "aws_glue_catalog_table" "shard_results" {
  name          = "shard_results"
  database_name = aws_glue_catalog_database.hyperkit.name
  table_type    = "EXTERNAL_TABLE"

  parameters = {
    "classification"            = "json"
    "EXTERNAL"                  = "TRUE"
    "projection.enabled"        = "true"
    "projection.sweep_id.type"  = "injected"
    "storage.location.template" = "s3://${aws_s3_bucket.artifacts.id}/runs/$${sweep_id}/results/"
  }

  partition_keys {
    name = "sweep_id"
    type = "string"
  }

  storage_descriptor {
    location      = "s3://${aws_s3_bucket.artifacts.id}/runs/"
    input_format  = "org.apache.hadoop.mapred.TextInputFormat"
    output_format = "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat"

    ser_de_info {
      name                  = "openx-json"
      serialization_library = "org.openx.data.jsonserde.JsonSerDe"
      parameters = {
        "ignore.malformed.json" = "false"
      }
    }

    columns {
      name = "shard_id"
      type = "string"
    }

    columns {
      name = "cell_id"
      type = "string"
    }

    columns {
      name = "generation"
      type = "int"
    }

    columns {
      name = "benchmark"
      type = "string"
    }

    columns {
      name = "instance_id"
      type = "string"
    }

    columns {
      name = "sut_hash"
      type = "string"
    }

    columns {
      name = "status"
      type = "string"
    }

    columns {
      name = "resolved"
      type = "boolean"
    }

    columns {
      name = "cost_usd"
      type = "double"
    }

    columns {
      name = "tokens"
      type = "bigint"
    }

    columns {
      name = "steps"
      type = "int"
    }

    columns {
      name = "latency_s"
      type = "double"
    }

    columns {
      name = "failure_mode"
      type = "string"
    }

    columns {
      name = "adapter_version"
      type = "string"
    }

    columns {
      name = "dataset_hash"
      type = "string"
    }

    columns {
      name = "created_at"
      type = "string"
    }
  }
}
