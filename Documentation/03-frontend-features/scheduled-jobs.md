# Scheduled jobs

## Concept

A scheduled job is the user-facing unit of work. It combines:

- GPU reservation window;
- target GPU;
- container image;
- command;
- CPU/RAM/GPU/VRAM/disk limits.

Users should not create a reservation separately and then create a task separately. The job form sends all required details to the backend in one request.

## Form fields

| Field           | Purpose                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| Container image | Custom image, for example `registry.example.org/team/train:2026-06`.    |
| Command         | One argument per line. Example: `python`, `train.py`, `--epochs`, `20`. |
| GPU             | GPU UUID/product selected from backend inventory.                       |
| Start           | Local datetime for reservation start.                                   |
| End             | Local datetime for reservation end.                                     |
| CPU             | Kubernetes CPU limit value, for example `1`, `2`, `500m`.               |
| RAM             | Kubernetes memory limit value, for example `2Gi`.                       |
| GPUs            | GPU count, usually `1`.                                                 |
| VRAM GB         | VRAM quota value passed through resource limits.                        |
| Disk            | Ephemeral storage limit, for example `10Gi`.                            |

## Request shape

The frontend sends:

```json
{
  "gpu_uuid": "gpu-1",
  "start_time": "2026-06-17T10:00:00.000Z",
  "end_time": "2026-06-17T12:00:00.000Z",
  "image": "registry.example.org/team/train:latest",
  "command": ["python", "train.py"],
  "resources": {
    "limits": {
      "cpu": "1",
      "memory": "2Gi",
      "nvidia.com/gpu": 1,
      "devops.local/vram-gb": 4,
      "ephemeral-storage": "10Gi"
    }
  }
}
```

## Backend behavior expected

The backend should:

1. validate start/end time;
2. reject reservation conflicts;
3. create the reservation;
4. store the job;
5. compute `time_limit_seconds` from the window;
6. dispatch the task when the start time arrives;
7. expose jobs through `GET /jobs`.

## Jobs vs active tasks

- **Jobs** are scheduled or historical user-facing work records.
- **Active tasks** are backend task records already dispatched to the execution layer and not yet completed/cancelled/failed.
