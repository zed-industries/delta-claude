type Execution = { sequence: number; turnId?: string; lost?: true; endSequence?: number }
type SavedBinding = {
  next: number
  lastTurnSequence?: number
  execution?: Execution
}

/** Check a saved binding's turn sequences before use, without mutating persisted data. */
export function restoreBinding<T extends SavedBinding>(previous: T): T {
  const binding = structuredClone(previous)
  const validSequence = (sequence: unknown): sequence is number =>
    Number.isSafeInteger(sequence) && Number(sequence) > 0 && Number(sequence) < binding.next
  if (binding.lastTurnSequence !== undefined && !validSequence(binding.lastTurnSequence))
    throw new Error('Invalid saved turn sequence; preserve the outbox and producer state')
  const execution = binding.execution
  if (execution && (!validSequence(execution.sequence) ||
      (execution.turnId !== undefined && (typeof execution.turnId !== 'string' || !execution.turnId)) ||
      (execution.endSequence !== undefined && (!validSequence(execution.endSequence) || execution.endSequence <= execution.sequence))))
    throw new Error('Invalid saved execution; preserve the outbox and producer state')
  return binding
}
