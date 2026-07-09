output "bucket_name" {
  value       = aws_s3_bucket.artifacts.id
  description = "Artifact-lake bucket name."
}

output "bucket_arn" {
  value       = aws_s3_bucket.artifacts.arn
  description = "Artifact-lake bucket ARN."
}

output "glue_database_name" {
  value       = aws_glue_catalog_database.hyperkit.name
  description = "Glue database containing the ShardResult table."
}

output "glue_table_name" {
  value       = aws_glue_catalog_table.shard_results.name
  description = "Glue ShardResult table name."
}
