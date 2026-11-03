import { describe, expect, test, tier } from 'claude-code/testing'
import { completedTurn, parseSummary, rememberTurn } from './thread-summary'

tier('user')

describe('thread summaries', () => {
  test('a new turn cannot replace an earlier completed turn input', () => {
    rememberTurn('first', 'Collect lemons')
    rememberTurn('second', 'Count oranges')
    expect(completedTurn('first', 'Collected lemons')).toBe('user: Collect lemons\n\nassistant: Collected lemons')
    expect(completedTurn('second', 'Counted oranges')).toBe('user: Count oranges\n\nassistant: Counted oranges')
  })

  test('accepts an unchanged document and rejects oversize replies', () => {
    expect(parseSummary('{"summary":"Collected lemons","threadSearchSummary":null}'))
      .toEqual({ summary: 'Collected lemons' })
    expect(() => parseSummary(JSON.stringify({ summary: 'x'.repeat(513) }))).toThrow()
  })

  test('enforces CLI byte limits for multibyte summaries and search terms', () => {
    const summary = {
      summary: '界'.repeat(170) + 'ab',
      threadSearchSummary: {
        generatedTitle: '界'.repeat(66) + 'ab',
        summary: '界'.repeat(682) + 'ab',
        keywords: ['界'.repeat(33) + 'a'],
        intents: ['界'.repeat(33) + 'a'],
      },
    }
    expect(parseSummary(JSON.stringify(summary))).toEqual(summary)
    for (const oversized of [
      { ...summary, summary: summary.summary + 'a' },
      { ...summary, threadSearchSummary: { ...summary.threadSearchSummary,
        generatedTitle: summary.threadSearchSummary.generatedTitle + 'a' } },
      { ...summary, threadSearchSummary: { ...summary.threadSearchSummary,
        summary: summary.threadSearchSummary.summary + 'a' } },
      { ...summary, threadSearchSummary: { ...summary.threadSearchSummary,
        keywords: [summary.threadSearchSummary.keywords[0] + 'a'] } },
      { ...summary, threadSearchSummary: { ...summary.threadSearchSummary,
        intents: [summary.threadSearchSummary.intents[0] + 'a'] } },
    ]) {
      expect(() => parseSummary(JSON.stringify(oversized))).toThrow()
    }
  })
})
