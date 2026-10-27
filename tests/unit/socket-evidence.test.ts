import { expect, it } from 'vitest'
import { socketFailureClass } from '../../e2e/lib/socket-evidence.ts'

it('distinguishes framing failures from transport and deadline failures', () => {
  expect(socketFailureClass('A server must not mask any frames that it sends to the client.')).toBe('MASKED_SERVER_FRAME')
  expect(socketFailureClass('Invalid frame header')).toBe('INVALID_FRAME')
  expect(socketFailureClass('Could not decode a text frame as UTF-8: invalid UTF-8')).toBe('INVALID_UTF8')
  expect(socketFailureClass('Error in connection establishment: net::ERR_CONNECTION_REFUSED')).toBe('CONNECTION_REFUSED')
  expect(socketFailureClass('net::ERR_CONNECTION_RESET')).toBe('CONNECTION_RESET')
  expect(socketFailureClass('net::ERR_CONNECTION_CLOSED')).toBe('CONNECTION_CLOSED')
  expect(socketFailureClass('net::ERR_TIMED_OUT')).toBe('TIMED_OUT')
})

it('keeps endpoints, peer messages and unknown error text out of retained evidence', () => {
  const privateMessage = 'wss://private.fixture.invalid/?token=PRIVATE_VALUE peer=PRIVATE_PEER'
  expect(socketFailureClass(privateMessage)).toBe('OTHER')
  const classified = socketFailureClass('net::ERR_CONNECTION_RESET ' + privateMessage)
  expect(classified).toBe('CONNECTION_RESET')
  expect(classified).not.toContain('PRIVATE')
})
