#!/usr/bin/env bash
# Assemble committed public sources; a private adapter is optional.
set -euo pipefail
if [[ $# -eq 2 ]]; then
  adapter_repo=""
  reel_ref="$1"
  destination="$2"
elif [[ $# -eq 3 ]]; then
  adapter_repo="$1"
  reel_ref="$2"
  destination="$3"
else
  echo "Usage: $0 [PRIVATE_ADAPTER_REPOSITORY] REEL_COMMIT EMPTY_DESTINATION" >&2
  exit 2
fi
reel_repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
[[ -d "$destination" && -z "$(ls -A "$destination")" ]] || { echo 'Destination must exist and be empty' >&2; exit 1; }
reel_commit="$(git -C "$reel_repo" rev-parse --verify "$reel_ref^{commit}")"
paths=(reel_organization.py deployment-adapter/README.md delivery-service/requirements.txt
  delivery-service/app.py delivery-service/providers.py delivery-service/standalone_providers.py)
paths+=(delivery-service/slack_recaps.py delivery-service/main.py delivery-service/Dockerfile)
for path in "${paths[@]}"; do
  git -C "$reel_repo" cat-file -e "$reel_commit:$path"
done
git -C "$reel_repo" archive "$reel_commit" "${paths[@]}" | tar -x -C "$destination"
printf 'REEL_GIT_SHA=%s\n' "$reel_commit" > "$destination/PROVENANCE"
if [[ -n "$adapter_repo" ]]; then
  # Preserve the previously pinned adapter for existing private deployments.
  adapter_ref="${REEL_PRIVATE_ADAPTER_REF:?Set REEL_PRIVATE_ADAPTER_REF to a reviewed adapter commit}"
  adapter_commit="$(git -C "$adapter_repo" rev-parse --verify "$adapter_ref^{commit}")"
  git -C "$adapter_repo" archive "$adapter_commit" \
    team-planning/meeting_transcription/config.py \
    team-planning/meeting_transcription/distribution.py \
    team_ops/__init__.py team_ops/ai_usage.py team_ops/client_metadata.py team_ops/accounting_identity.py \
    team_ops/google_drive/__init__.py team_ops/google_drive/auth.py team_ops/google_drive/client.py \
    team_ops/notion.py team_ops/pipedrive.py team_ops/slack.py team_ops/slack_idempotency.py \
    | tar -x -C "$destination/deployment-adapter"
  mv "$destination/deployment-adapter/team-planning/meeting_transcription/config.py" "$destination/deployment-adapter/config.py"
  mv "$destination/deployment-adapter/team-planning/meeting_transcription/distribution.py" "$destination/deployment-adapter/distribution.py"
  rmdir "$destination/deployment-adapter/team-planning/meeting_transcription" "$destination/deployment-adapter/team-planning"
  printf 'PRIVATE_ADAPTER_GIT_SHA=%s\n' "$adapter_commit" >> "$destination/PROVENANCE"
fi
