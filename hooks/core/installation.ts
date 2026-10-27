/** App installation and plugin installation/activation must never interrupt one another. */
type Installation = { kind: 'app' | 'plugin' }

export let installation: Installation | undefined

/** Claim the process-wide installer slot synchronously; a late release cannot clear a newer owner. */
export function claimInstallation(kind: Installation['kind']): (() => void) | undefined {
  if (installation) return
  const claim = { kind }
  installation = claim
  return () => { if (installation === claim) installation = undefined }
}
