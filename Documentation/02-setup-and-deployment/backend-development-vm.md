# Backend development VM deployment

Use this runbook only when the MLManage backend is hosted as a system service on a development VM. Deployment-specific values such as hostnames, usernames, paths, service names, and credentials must be supplied through local configuration and must not be committed to this repository.

The backend repository contains the authoritative infrastructure instructions. Consult its deployment documentation before changing a development environment.

## Define deployment values

Set values appropriate for your environment in the current shell or a private, untracked configuration file:

```bash
export MLMANAGE_BACKEND_DIR="/path/to/mlmanage-compute"
export MLMANAGE_SSH_TARGET="<user>@<backend-host>"
export MLMANAGE_REMOTE_DIR="<remote-application-directory>"
export MLMANAGE_SERVICE="<system-service-name>"
export MLMANAGE_API_URL="http://<backend-host>:8000"
```

Do not store passwords, SSH keys, tokens, database contents, or service secrets in this repository.

## Deploy backend source

Run these commands with `MLMANAGE_BACKEND_DIR` pointing to a separate checkout of the MLManage Compute repository:

```bash
python3 -m py_compile "$MLMANAGE_BACKEND_DIR/devops-backend/api/main.py"

git -C "$MLMANAGE_BACKEND_DIR" status --short
git -C "$MLMANAGE_BACKEND_DIR" diff

ssh "$MLMANAGE_SSH_TARGET" \
  "cp -a '$MLMANAGE_REMOTE_DIR/main.py' '$MLMANAGE_REMOTE_DIR/main.py.predeploy'"
scp "$MLMANAGE_BACKEND_DIR/devops-backend/api/main.py" \
  "$MLMANAGE_SSH_TARGET:$MLMANAGE_REMOTE_DIR/main.py"
ssh "$MLMANAGE_SSH_TARGET" \
  "cd '$MLMANAGE_REMOTE_DIR' && .venv/bin/python -m py_compile main.py && sudo systemctl restart '$MLMANAGE_SERVICE'"
```

Review uncommitted backend changes before deployment. Do not copy databases, environment files, service launchers, or secret values as part of a routine source deployment.

## Verify the deployment

```bash
ssh "$MLMANAGE_SSH_TARGET" \
  "sudo systemctl is-active '$MLMANAGE_SERVICE' && sudo systemctl status '$MLMANAGE_SERVICE' --no-pager"
curl --fail --show-error "$MLMANAGE_API_URL/health"
```

If the environment uses Kubernetes, also verify the relevant nodes and workloads with the deployment's configured `kubectl` context.

Run destructive live tests only against disposable test data and infrastructure.

## Roll back source

If the service fails after deployment, restore the backup made before the copy, validate it, and restart the service:

```bash
ssh "$MLMANAGE_SSH_TARGET"
export REMOTE_DIR="/path/to/backend" SERVICE="mlmanage-api.service"
cd "$REMOTE_DIR"
cp -a main.py.predeploy main.py
.venv/bin/python -m py_compile main.py
sudo systemctl restart "$SERVICE"
curl --fail --show-error http://localhost:8000/health
```

## Recover a broken Python environment

An operating-system or Python upgrade can invalidate an existing virtual environment. Recreate it from the backend's pinned dependency file rather than installing an ad hoc package list:

```bash
ssh "$MLMANAGE_SSH_TARGET"
export REMOTE_DIR="/path/to/backend" SERVICE="mlmanage-api.service"
sudo systemctl stop "$SERVICE"
cd "$REMOTE_DIR"
mv .venv ".venv.broken-$(date +%Y%m%d-%H%M%S)"
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m pip check
sudo systemctl start "$SERVICE"
```

Adjust the dependency command if the backend uses a different package manager or dependency file.

## Logs and common checks

```bash
ssh "$MLMANAGE_SSH_TARGET" \
  "sudo journalctl -u '$MLMANAGE_SERVICE' -n 100 --no-pager"
ssh "$MLMANAGE_SSH_TARGET" \
  "sudo ss -ltnp | grep :8000"
ssh "$MLMANAGE_SSH_TARGET" \
  "'$MLMANAGE_REMOTE_DIR/.venv/bin/python' -m pip check"
```

## Security boundary

A development VM is not a production deployment. Keep it on a restricted network, use proper secret management, avoid shared default credentials, and do not publish launchers, databases, logs containing tokens, or environment values. Production deployments additionally require TLS, access controls, backup and recovery procedures, and a hardened authentication/session design.
