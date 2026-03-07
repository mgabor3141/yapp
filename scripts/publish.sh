#!/usr/bin/env bash
set -euo pipefail

# Publish packages via yarn (handles OIDC + workspace: rewriting) and emit
# "New tag:" lines so changesets/action can detect published packages and
# create GitHub releases.
#
# Order: dependencies before dependents (budget-model before safeguard).

packages=(
  packages/budget-model
  packages/bash-trim
  packages/desktop-notify
  packages/safeguard
)

for dir in "${packages[@]}"; do
  pkg="$dir/package.json"
  name=$(node -p "require('./$pkg').name")
  version=$(node -p "require('./$pkg').version")

  if npm view "$name@$version" version &>/dev/null; then
    echo "⏭  $name@$version already published"
    continue
  fi

  (cd "$dir" && yarn npm publish --access public)
  echo "New tag: $name@$version"
done
