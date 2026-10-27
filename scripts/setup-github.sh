#!/usr/bin/env bash
# Configures the GitHub side of the pipeline with the gh CLI. Idempotent: run it
# as many times as you like.
#
#   scripts/setup-github.sh [owner/repo]
#
# Optional environment variables:
#   WAIT_TIMER_MINUTES            wait timer of the production environment (default 1)
#   STAGING_APP_URL               public URL of the staging service   (variable APP_URL)
#   STAGING_RENDER_SERVICE_ID     Render service id of staging        (variable RENDER_SERVICE_ID)
#   PRODUCTION_APP_URL            public URL of the production service
#   PRODUCTION_RENDER_SERVICE_ID  Render service id of production
#   DRY_RUN=1                     print what would be changed without calling the API
#
# What it does NOT do: create secrets. They are printed at the end so you can
# set them yourself without the values ever touching this script.
set -euo pipefail

REPO="${1:-}"
WAIT_TIMER_MINUTES="${WAIT_TIMER_MINUTES:-1}"
DRY_RUN="${DRY_RUN:-0}"

if ! [[ "$WAIT_TIMER_MINUTES" =~ ^[0-9]+$ ]] || [ "$WAIT_TIMER_MINUTES" -gt 43200 ]; then
  echo "WAIT_TIMER_MINUTES must be an integer between 0 and 43200" >&2
  exit 1
fi

# gh wrapper: with DRY_RUN it only prints the command (and the JSON body).
gh_call() {
  if [ "$DRY_RUN" = "1" ]; then
    echo "[dry-run] gh $*"
    if [[ " $* " == *" --input - "* ]]; then
      cat
    fi
    return 0
  fi
  gh "$@" > /dev/null
}

if [ -z "$REPO" ]; then
  REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
fi
if ! [[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "Repository must look like owner/repo, got '$REPO'" >&2
  exit 1
fi
echo "Configuring $REPO"

USER_LOGIN="$(gh api user --jq .login)"
USER_ID="$(gh api user --jq .id)"
echo "Required reviewer for production: $USER_LOGIN"

# --- Environments -----------------------------------------------------------
ensure_branch_policy() {
  local env="$1" existing
  existing="$(gh api "repos/$REPO/environments/$env/deployment-branch-policies" --jq '.branch_policies[].name' 2> /dev/null || true)"
  if grep -qx "main" <<< "$existing"; then
    echo "  $env: deployment branch policy 'main' already present"
  else
    gh_call api -X POST "repos/$REPO/environments/$env/deployment-branch-policies" -f name=main -f type=branch
    echo "  $env: deployment restricted to branch main"
  fi
}

echo "Environment: preview (no protection, used by PR previews)"
gh_call api -X PUT "repos/$REPO/environments/preview" --input - << 'JSON'
{}
JSON

echo "Environment: staging (branch main, no reviewers)"
gh_call api -X PUT "repos/$REPO/environments/staging" --input - << 'JSON'
{
  "wait_timer": 0,
  "reviewers": [],
  "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true }
}
JSON
ensure_branch_policy staging

echo "Environment: production (branch main, reviewer $USER_LOGIN, wait ${WAIT_TIMER_MINUTES} min)"
# prevent_self_review is false on purpose: with a single account the person who
# starts the deploy is also the only possible reviewer.
gh_call api -X PUT "repos/$REPO/environments/production" --input - << JSON
{
  "wait_timer": $WAIT_TIMER_MINUTES,
  "prevent_self_review": false,
  "reviewers": [{ "type": "User", "id": $USER_ID }],
  "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true }
}
JSON
ensure_branch_policy production

# --- Environment variables --------------------------------------------------
set_var() {
  local env="$1" name="$2" value="$3"
  if [ -z "$value" ]; then
    echo "  $env: $name not set (export the matching variable listed in the header of this script, then rerun)"
    return 0
  fi
  gh_call variable set "$name" --env "$env" --repo "$REPO" --body "$value"
  echo "  $env: $name set"
}

echo "Environment variables"
set_var staging NODE_ENV production
set_var staging APP_URL "${STAGING_APP_URL:-}"
set_var staging RENDER_SERVICE_ID "${STAGING_RENDER_SERVICE_ID:-}"
set_var production NODE_ENV production
set_var production APP_URL "${PRODUCTION_APP_URL:-}"
set_var production RENDER_SERVICE_ID "${PRODUCTION_RENDER_SERVICE_ID:-}"

# --- Workflow token defaults ------------------------------------------------
echo "Default GITHUB_TOKEN permissions: read-only (workflows ask for more per job)"
gh_call api -X PUT "repos/$REPO/actions/permissions/workflow" -f default_workflow_permissions=read \
  -F can_approve_pull_request_reviews=false

# --- Branch protection ------------------------------------------------------
# enforce_admins=false keeps the admin bypass: with one account nobody else can
# approve, so the owner merges with "bypass branch protections".
echo "Branch protection on main"
gh_call api -X PUT "repos/$REPO/branches/main/protection" --input - << 'JSON'
{
  "required_status_checks": { "strict": true, "checks": [{ "context": "CI OK" }] },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON

cat << EOF

Done. Secrets are not created by this script. Set them with (each command asks for the value):

  gh secret set DISCORD_WEBHOOK_URL --repo $REPO
  gh secret set VERCEL_TOKEN --repo $REPO
  gh secret set VERCEL_ORG_ID --repo $REPO
  gh secret set VERCEL_PROJECT_ID --repo $REPO
  gh secret set VERCEL_AUTOMATION_BYPASS_SECRET --repo $REPO
  gh secret set RENDER_API_KEY --env staging --repo $REPO
  gh secret set RENDER_API_KEY --env production --repo $REPO

See docs/setup.md for where each value comes from.
EOF
