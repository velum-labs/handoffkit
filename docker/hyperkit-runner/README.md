# HyperKit AWS Batch runner

Build from the repository root:

```sh
docker build -f docker/hyperkit-runner/Dockerfile -t hyperkit-runner .
```

The image runs one AWS Batch array entry through
`python -m hyperkit.cloud.runner`. Configure the Batch job with `RUN_ID` and
`MANIFEST_S3_URI`; AWS supplies `AWS_BATCH_JOB_ARRAY_INDEX`. Do not add provider
keys or AWS credentials to the image. Pass them through the Batch job role,
Secrets Manager, or runtime environment.

SWE-bench starts sibling containers. The Batch compute environment and job
definition must therefore expose a Docker daemon to the runner, normally by
mounting the host socket at `/var/run/docker.sock`. The image contains only the
Docker CLI and does not start its own daemon. Treat socket access as privileged
host access and isolate this runner on dedicated workers.
