// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MOCK?: string;
  /** Screens that read /v1 instead of /api: a comma list, or "all". */
  readonly VITE_V1_SCREENS?: string;
}
