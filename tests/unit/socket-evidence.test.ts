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

it('separates an empty browser error from a calibrated reserved-bit protocol error', () => {
  expect(socketFailureClass('')).toBe('EMPTY_ERROR')
  expect(socketFailureClass('One or more reserved bits are on: reserved1 = 1, reserved2 = 0, reserved3 = 0')).toBe('INVALID_FRAME')
})

it('separates a refused Origin handshake from a validated transport drop',()=>{
 expect(socketFailureClass('Error during WebSocket handshake: Unexpected response code: 403')).toBe('HANDSHAKE_FORBIDDEN')
 expect(socketFailureClass('Unexpected response code: 403 wss://private.fixture.invalid/')).toBe('HANDSHAKE_FORBIDDEN')
})
