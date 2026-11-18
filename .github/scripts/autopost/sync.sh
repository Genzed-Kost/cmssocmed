#!/usr/bin/env bash
# sync.sh <claim|apply> — ambil data terbaru, jalankan run.js, commit & push.
# Diulang bila push bentrok dengan perubahan dari web CMS.
set -euo pipefail
MODE="$1"
BRANCH="${GITHUB_REF_NAME:-main}"
DIR="$(cd "$(dirname "$0")" && pwd)"

git config user.name  "cms-autopost[bot]"
git config user.email "cms-autopost[bot]@users.noreply.github.com"

for i in 1 2 3 4 5; do
  git fetch --quiet origin "$BRANCH"
  git reset --quiet --hard "origin/$BRANCH"
  node "$DIR/run.js" "$MODE"
  git add data/contents.json data/activity.json
  if git diff --cached --quiet; then
    echo "Tidak ada perubahan untuk di-commit."
    exit 0
  fi
  git commit --quiet -m "chore(autopost): $MODE $(date -u +%FT%H:%MZ) [skip ci]"
  if git push --quiet origin "HEAD:$BRANCH"; then
    echo "Tersimpan ke repo ($MODE)."
    exit 0
  fi
  echo "Push bentrok, coba lagi ($i)…"
  sleep $((i * 3))
done
echo "::error::Gagal menyimpan ke repo setelah 5 kali percobaan"
exit 1
