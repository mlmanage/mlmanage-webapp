# MLManage Hello World container

This image demonstrates the complete MLManage workflow with one command:

```text
./hello_world
```

The executable prints `hello world` to the container logs and writes the same text to `/results/hello.txt`, making it available in the Job's Results panel and results archive.

## Build an upload archive

Build for the target worker architecture. Omit `--platform` when the Docker host and worker use the same architecture:

```bash
TARGET_PLATFORM=linux/amd64
docker build --platform "$TARGET_PLATFORM" -t mlmanage-hello-world:latest .
docker save -o mlmanage-hello-world.tar mlmanage-hello-world:latest
```

Set `TARGET_PLATFORM` to the worker architecture, such as `linux/amd64` or `linux/arm64`.

In MLManage, open **New job**, choose **upload**, select `mlmanage-hello-world.tar`, and enter `./hello_world` in Command. The upload starts automatically.
