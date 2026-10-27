/**
 * The Delta organizations the person belongs to, read once per process, and the one a repository saved.
 */
import { authStatus, orgCreate, orgList } from '../cli/delta-cli'
import { setupEnv } from './interaction'
import { policyPath, readProjectPolicy } from './project-policy'
import type { Host } from '../core/host'
import { isPersonalOrganization, type Organization } from './setup'

/**
 * Organization id → name, filled by every organization list read, so the band can name the
 * organization a thread is shared with. The band itself reads the list at most once per process.
 */
const organizationNames = new Map<string, string>()
/** The organization selected in Delta, as the last organization list read reported it. */
export let currentOrganizationId: string | undefined
/** The account's personal organizations, from the band's directory read, which also reads the login. */
let personalIds = new Set<string>()
let organizationDirectory: Promise<void> | undefined

/** Whether `id` is one of the account's personal organizations, once the band's directory read finished. */
export function isPersonalOrganizationId(id: string): boolean {
  return personalIds.has(id)
}

/** Create a team organization through the CLI and remember its name for the band. */
export async function createOrganization(host: Host, name: string): Promise<Organization> {
  const created = await orgCreate(host, name)
  organizationNames.set(created.id, created.name)
  return created
}

/** The account's organizations from `delta --json org list`, remembering their names for the band. */
export async function listOrganizations(host: Host, timeoutMs?: number): Promise<Organization[]> {
  const organizations = await orgList(host, timeoutMs)
  for (const organization of organizations) organizationNames.set(organization.id, organization.name)
  currentOrganizationId = (organizations.find((organization) => organization.current) ?? organizations[0])?.id
  return organizations
}

export function loadOrganizationDirectory(host: Host): Promise<void> {
  organizationDirectory ??= (async () => {
    const [organizations, login] = await Promise.all([
      listOrganizations(host), authStatus(host).then((status) => status.login, () => undefined),
    ])
    personalIds = new Set(organizations.filter((org) => isPersonalOrganization(org, login)).map((org) => org.id))
  })().catch(() => undefined)
  return organizationDirectory
}

/** The name of an organization, or of the current one when the caller names none. */
export function organizationName(id: string | undefined): string | undefined {
  return organizationNames.get(id ?? currentOrganizationId ?? '')
}

/** The organization a checkout's `.delta/settings.json` names, in any mode; undefined when it names none or can't be read. */
export async function savedOrganization(host: Host, root: string): Promise<string | undefined> {
  try { return readProjectPolicy(await setupEnv(host).readFile(policyPath(root))).policy.organization }
  catch { return undefined }
}
