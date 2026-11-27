// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

import { connect, createServer, type AddressInfo } from 'node:net';

/** A port nothing listens on, found by binding to 0 and letting it go. */
export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) =>
    probe.close(() => {
      resolve();
    }),
  );
  return port;
}

/** Resolves with the error code of a plain TCP connect, or 'connected'. */
export function tryConnect(port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve('connected');
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code ?? error.name);
    });
  });
}
