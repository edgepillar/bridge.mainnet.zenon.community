// Retain only known protocol categories; browser errors can contain endpoints
// or peer-supplied data and must not be copied into published diagnostics.
export function socketFailureClass(message: string): string {
  if (message === '') return 'EMPTY_ERROR'
  if (/must not mask|masked frame/i.test(message)) return 'MASKED_SERVER_FRAME'
  if (/invalid frame header|invalid reserved bits|one or more reserved bits are on|invalid opcode|protocol error/i.test(message)) return 'INVALID_FRAME'
  if (/invalid utf-?8/i.test(message)) return 'INVALID_UTF8'
  if (/unexpected continuation/i.test(message)) return 'UNEXPECTED_CONTINUATION'
  if (/previous message.*unfinished|new message.*unfinished/i.test(message)) return 'UNFINISHED_MESSAGE'
  if (/control.*fragment|control.*not final/i.test(message)) return 'FRAGMENTED_CONTROL_FRAME'
  if (/invalid.*close|reserved status code/i.test(message)) return 'INVALID_CLOSE_FRAME'
  if (/Unexpected response code: 403/i.test(message)) return 'HANDSHAKE_FORBIDDEN'
  if (/ERR_CONNECTION_REFUSED/.test(message)) return 'CONNECTION_REFUSED'
  if (/ERR_CONNECTION_RESET/.test(message)) return 'CONNECTION_RESET'
  if (/ERR_CONNECTION_CLOSED/.test(message)) return 'CONNECTION_CLOSED'
  if (/connection closed|closed before.*connection/i.test(message)) return 'CONNECTION_CLOSED'
  if (/connection reset/i.test(message)) return 'CONNECTION_RESET'
  if (/ERR_TIMED_OUT|timed out/i.test(message)) return 'TIMED_OUT'
  return 'OTHER'
}
