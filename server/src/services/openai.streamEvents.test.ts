import assert from 'node:assert/strict'
import test from 'node:test'
import { __TESTING__, consumeLangChainEventStream } from './openai.js'

test('prompts include multiple-choice hint', () => {
  assert.ok(__TESTING__.MULTIPLE_CHOICE_HINT.includes('选择题注意'))
  assert.ok(__TESTING__.PROMPT.includes(__TESTING__.MULTIPLE_CHOICE_HINT))
  assert.ok(__TESTING__.TEXT_PROMPT.includes(__TESTING__.MULTIPLE_CHOICE_HINT))
})

test('consumeLangChainEventStream accumulates deltas from chunk/content arrays', async () => {
  async function* stream() {
    yield { event: 'on_llm_stream', data: { chunk: { content: [{ type: 'text', text: 'Hello' }] } } }
    yield { event: 'on_llm_stream', data: { chunk: { content: [{ type: 'text', text: ' world' }] } } }
  }

  const deltas: string[] = []
  const res = await consumeLangChainEventStream(stream(), { onDelta: (d) => deltas.push(d) })
  assert.equal(res.content, 'Hello world')
  assert.equal(res.deltaCount, 2)
  assert.deepEqual(deltas, ['Hello', ' world'])
})

test('consumeLangChainEventStream falls back to end output text when no deltas', async () => {
  async function* stream() {
    yield {
      event: 'on_chat_model_end',
      data: {
        output: {
          generations: [
            {
              message: { content: '题目：1+1\n\n解答：2' },
              generationInfo: { finish_reason: 'stop' }
            }
          ]
        }
      }
    }
  }

  const res = await consumeLangChainEventStream(stream())
  assert.equal(res.content, '题目：1+1\n\n解答：2')
  assert.equal(res.finishReason, 'stop')
  assert.equal(res.deltaCount, 0)
})

test('consumeLangChainEventStream reads token-based events', async () => {
  async function* stream() {
    yield { event: 'on_llm_new_token', data: { token: 'A' } }
    yield { event: 'on_llm_new_token', data: { token: 'B' } }
    yield { event: 'on_llm_new_token', data: { token: 'C' } }
  }

  const res = await consumeLangChainEventStream(stream())
  assert.equal(res.content, 'ABC')
  assert.equal(res.deltaCount, 3)
})
