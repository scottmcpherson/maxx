export function computerUseServeArgs(
  socketPath: string,
  bundleID: string,
  existingBrowserProfiles: boolean,
): string[] {
  return [
    "serve",
    "--embedded",
    "--socket",
    socketPath,
    "--host-bundle-id",
    bundleID,
    "--permission-mode",
    "standard",
    ...(existingBrowserProfiles ? ["--grant", "existing-profile"] : []),
  ];
}

export function computerUseMcpArgs(socketPath: string, bundleID: string): string[] {
  return [
    "mcp",
    "--embedded",
    "--socket",
    socketPath,
    "--host-bundle-id",
    bundleID,
  ];
}
