#!/usr/bin/env bash
# Backup DATA_DIR to a target path (e.g. a USB stick or remote host).
# Usage:  bash scripts/backup.sh /mnt/usb/backup
#   or:   bash scripts/backup.sh user@host:/path/to/backup
#
# Add to cron for automatic backups, e.g. every hour:
#   0 * * * * /usr/bin/bash /path/to/BirthdayPhotoApp/scripts/backup.sh /mnt/usb/backup >> /home/pi/backup.log 2>&1

set -euo pipefail

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
  echo "Usage: $0 <target-path-or-host:path>" >&2
  exit 1
fi

# Load DATA_DIR from .env if available
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"
if [[ -f "$ENV_FILE" ]]; then
  DATA_DIR="$(grep -E '^DATA_DIR=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'")"
fi
DATA_DIR="${DATA_DIR:-./data}"

# Resolve relative path from project root
if [[ "$DATA_DIR" != /* ]]; then
  DATA_DIR="$SCRIPT_DIR/../$DATA_DIR"
fi

echo "[$(date -Is)] Backing up $DATA_DIR → $TARGET"
rsync -av --delete "$DATA_DIR/" "$TARGET/"
echo "[$(date -Is)] Backup complete."
