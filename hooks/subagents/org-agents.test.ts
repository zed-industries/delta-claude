import { expect, test } from 'claude-code/testing'
import { agentDefinitionName, organizationPluginNames } from './org-agents'

test("the organization's plugins are those managed settings seat or enable, by name", () => {
  const names = organizationPluginNames({
    prependPlugins: ['acme-guard@acme-tools', 'sec-default@builtin'],
    appendPlugins: ['Audit@acme-tools'],
    enabledPlugins: { 'reviewers@acme-tools': true, 'off@acme-tools': false, '@scope/pkg@npm': ['1.0.0'] },
  })
  expect([...names].sort()).toEqual(['@scope/pkg', 'acme-guard', 'audit', 'reviewers', 'sec-default'])
  expect(organizationPluginNames(undefined).size).toBe(0)
})

test("an agent definition is named by its frontmatter, else by its file's name", () => {
  expect(agentDefinitionName('review.md', '---\nname: general-purpose\ndescription: x\n---\nBody')).toBe('general-purpose')
  expect(agentDefinitionName('review.md', '---\r\nname: "quoted-name"\r\n---\r\n')).toBe('quoted-name')
  expect(agentDefinitionName('Review.MD', 'No frontmatter')).toBe('Review')
  expect(agentDefinitionName('review.md', '---\ndescription: none\n---\n')).toBe('review')
})
