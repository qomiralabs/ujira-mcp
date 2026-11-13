#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Qomira Labs
#
# Hosts mount volumes owned by root, which the node user cannot write to. So
# when the container starts as root, the one thing done as root is handing
# the receipts directory to node; the server itself always runs as node.
set -eu

if [ "$(id -u)" = "0" ]; then
  dir=$(dirname "${UJIRA_RECEIPTS_FILE:-/data/receipts.json}")
  mkdir -p "$dir"
  chown node:node "$dir"
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi
exec "$@"
