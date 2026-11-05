import { expect, test, tier } from 'claude-code/testing'
import { DeltaCli } from './cli'

tier('user')

test('the first PATH program that answers as Delta is selected and cached without an installer', async () => {
  const calls: string[][] = []
  const run = async (argv: readonly string[]) => {
    calls.push([...argv])
    if (argv[0] === 'sh') return output('path /nix/bin/delta\npath /development build/delta\ninstalled /Applications/Delta.app/Contents/MacOS/delta\n')
    return argv[0] === '/nix/bin/delta' ? gitDelta() : contract()
  }
  const cli = new DeltaCli()
  expect(await cli.resolve(run, true)).toBe('/development build/delta')
  expect(await cli.resolve(run)).toBe('/development build/delta')
  expect(calls.slice(1)).toEqual([
    ['/nix/bin/delta', '--json', 'thread', 'contract'],
    ['/development build/delta', '--json', 'thread', 'contract'],
  ])
  expect(calls[0]![2]).not.toContain('curl')
})

test('an install location is selected unprobed once PATH holds only other programs named delta', async () => {
  const calls: string[][] = []
  const installed = '/Applications/Delta.app/Contents/MacOS/delta'
  const run = async (argv: readonly string[]) => {
    calls.push([...argv])
    return argv[0] === 'sh' ? output(`path /nix/bin/delta\npath /nix/bin/delta\ninstalled ${installed}\n`) : gitDelta()
  }
  expect(await new DeltaCli().resolve(run)).toBe(installed)
  expect(calls.slice(1)).toEqual([['/nix/bin/delta', '--json', 'thread', 'contract']])
})

test('only other programs named delta on PATH leave the CLI missing and name them', async () => {
  const run = async (argv: readonly string[]) => argv[0] === 'sh' ? output('path /nix/bin/delta\n') : gitDelta()
  await expect(new DeltaCli().resolve(run))
    .rejects.toThrow("Delta CLI is missing. /nix/bin/delta is another program named delta, not Zed's Delta CLI.")
})

test('resume never installs, but explicit setup after missing discovery does', async () => {
  const calls: string[][] = []
  const run = async (argv: readonly string[]) => {
    calls.push([...argv])
    return argv[2]!.includes('--non-interactive') ? output('/installed/delta\n') : output('')
  }
  const cli = new DeltaCli()
  await expect(cli.resolve(run)).rejects.toThrow(Error)
  expect(calls).toHaveLength(1)
  const progress: string[] = []
  expect(await cli.resolve(run, true, (text) => progress.push(text))).toBe('/installed/delta')
  expect(progress).toHaveLength(1)
  expect(calls).toHaveLength(3)
  expect(calls[2]![2]).toContain('--locate-cli')
  expect(calls[2]![2]).toContain('--non-interactive')
})

test('concurrent setup shares installation and failure; later retry succeeds', async () => {
  let installations = 0
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const run = async (argv: readonly string[]) => {
    if (!argv[2]!.includes('--non-interactive')) return output('')
    installations++
    await held
    return installations === 1 ? output('', 1, 'download failed') : output('/installed/delta\n')
  }
  const cli = new DeltaCli()
  const first = cli.resolve(run, true)
  const second = cli.resolve(run, true)
  release()
  await expect(first).rejects.toThrow(Error)
  await expect(second).rejects.toThrow(Error)
  expect(installations).toBe(1)
  expect(await cli.resolve(run, true)).toBe('/installed/delta')
  expect(installations).toBe(2)
})

test('discovery failures and malformed paths never authorize installation', async () => {
  let calls = 0
  const run = async () => {
    calls++
    return calls === 1 ? output('', 1, 'permission denied') : output('installed relative/delta\n')
  }
  const cli = new DeltaCli()
  await expect(cli.resolve(run, true)).rejects.toThrow(Error)
  expect(calls).toBe(1)
  await expect(cli.resolve(run, true)).rejects.toThrow(Error)
  expect(calls).toBe(2)
})

test('Windows discovery selects the first PATH program that answers as Delta, without a shell', async () => {
  for (const path of ['C:\\Program Files\\Delta\\delta.exe', '\\\\server\\tools\\delta.exe']) {
    const calls: string[][] = []
    const run = async (argv: readonly string[]) => {
      calls.push([...argv])
      if (argv[0] === 'where.exe') return output(`C:\\scoop\\shims\\delta.exe\r\n${path}\r\nC:\\other\\delta.exe\r\n`)
      return argv[0] === 'C:\\scoop\\shims\\delta.exe' ? gitDelta() : contract()
    }
    const cli = new DeltaCli()
    const windows = { exists: async () => { throw new Error('PATH must win over registry lookup') } }
    expect(await cli.resolve(run, true, undefined, windows)).toBe(path)
    expect(await cli.resolve(run, false, undefined, windows)).toBe(path)
    expect(calls).toEqual([
      ['where.exe', '$PATH:delta.exe'],
      ['C:\\scoop\\shims\\delta.exe', '--json', 'thread', 'contract'],
      [path, '--json', 'thread', 'contract'],
    ])
  }
})

test('Windows registry fallback prefers HKCU and skips stale or missing installation markers', async () => {
  const userFolder = 'D:\\Custom Delta'
  const machineFolder = 'C:\\Program Files\\Delta'
  const userCli = `${userFolder}\\bin\\delta.exe`
  const machineCli = `${machineFolder}\\bin\\delta.exe`
  for (const user of ['installed', 'stale', 'missing', 'empty', 'relative', 'wrong-type']) {
    const calls: string[][] = []
    const checked: string[] = []
    const run = async (argv: readonly string[]) => {
      calls.push([...argv])
      if (argv[0] === 'where.exe') return output('', 1)
      if (argv[0] !== 'reg.exe') throw new Error('Discovery must not install')
      if (argv[2]!.startsWith('HKCU')) {
        if (user === 'missing') return output('', 1)
        const folder = user === 'empty' ? '' : user === 'relative' ? 'relative' : userFolder
        return output(`\r\n    InstallFolder    ${user === 'wrong-type' ? 'REG_DWORD' : 'REG_SZ'}    ${folder}\r\n`)
      }
      return output(`\r\n    InstallFolder    REG_SZ    ${machineFolder}\\\r\n`)
    }
    const windows = { exists: async (path: string) => {
      checked.push(path)
      return path === machineCli || (user === 'installed' && path === userCli)
    } }
    const progress: string[] = []
    expect(await new DeltaCli().resolve(run, true, (text) => progress.push(text), windows))
      .toBe(user === 'installed' ? userCli : machineCli)
    expect(calls).toEqual([
      ['where.exe', '$PATH:delta.exe'],
      ...['HKCU', ...(user === 'installed' ? [] : ['HKLM'])].map((hive) =>
        ['reg.exe', 'query', `${hive}\\Software\\Zed Industries\\Delta`, '/v', 'InstallFolder', '/reg:64']),
    ])
    expect(checked).toEqual(user === 'installed' ? [userCli]
      : user === 'stale' ? [userCli, machineCli] : [machineCli])
    expect(progress).toEqual([])
  }
})

test('Windows missing CLI and invalid discovery never invoke an installer', async () => {
  const calls: string[][] = []
  const progress: string[] = []
  const results = [output('', 1), output('', 1),
    output('    InstallFolder    REG_SZ    C:\\Removed Delta\r\n'),
    output('C:delta.exe\r\n'), output('', 2, 'lookup failed')]
  const cli = new DeltaCli()
  const run = async (argv: readonly string[]) => {
    calls.push([...argv])
    return results.shift()!
  }
  for (let attempt = 0; attempt < 3; attempt++)
    await expect(cli.resolve(run, false, (text) => progress.push(text), { exists: async () => false })).rejects.toThrow(Error)
  expect(calls).toEqual([
    ['where.exe', '$PATH:delta.exe'],
    ...['HKCU', 'HKLM'].map((hive) =>
      ['reg.exe', 'query', `${hive}\\Software\\Zed Industries\\Delta`, '/v', 'InstallFolder', '/reg:64']),
    ...Array(2).fill(['where.exe', '$PATH:delta.exe']),
  ])
  expect(progress).toEqual([])
})

test('Windows explicit installation rediscovers the registry without a refreshed PATH', async () => {
  let installed = false
  let installations = 0
  const run = async (argv: readonly string[]) => {
    if (argv[0] === 'powershell.exe') {
      installations++
      installed = true
      return output('')
    }
    if (argv[0] === 'reg.exe' && installed)
      return output('    InstallFolder    REG_SZ    D:\\Delta\r\n')
    return output('', 1)
  }
  const cli = new DeltaCli()
  let approved = false
  let prompts = 0
  const windows = {
    exists: async (path: string) => path === 'D:\\Delta\\bin\\delta.exe',
    confirmInstall: async () => { prompts++; return approved },
  }
  await expect(cli.resolve(run, false, undefined, windows)).rejects.toThrow(Error)
  expect(prompts).toBe(0)
  await expect(cli.resolve(run, true, undefined, windows)).rejects.toThrow(Error)
  expect(installations).toBe(0)
  approved = true
  expect(await cli.resolve(run, true, undefined, windows)).toBe('D:\\Delta\\bin\\delta.exe')
  expect(installations).toBe(1)
  expect(prompts).toBe(2)
  expect(await cli.resolve(run, true, undefined, windows)).toBe('D:\\Delta\\bin\\delta.exe')
  expect(prompts).toBe(2)
})

test('Windows installation failure is retryable and never caches a CLI', async () => {
  let installations = 0
  const run = async (argv: readonly string[]) => {
    if (argv[0] === 'powershell.exe') {
      installations++
      return output('', 1, 'Windows requires a restart')
    }
    return output('', 1)
  }
  const cli = new DeltaCli()
  for (let attempt = 0; attempt < 2; attempt++)
    await expect(cli.resolve(run, true, undefined, { exists: async () => false, confirmInstall: async () => true }))
      .rejects.toThrow(Error)
  expect(installations).toBe(2)
})

/** How git-delta, the diff pager, answers a Delta command: it rejects `--json`. */
function gitDelta() {
  return output('', 2, "error: unexpected argument '--json' found")
}

function contract() {
  return output('{"operation":"contract","min":8,"max":9}\n')
}

function output(stdout: string, exitCode = 0, stderr = '') {
  return { stdout, exitCode, stderr, isStdoutTruncated: false, isStderrTruncated: false }
}
