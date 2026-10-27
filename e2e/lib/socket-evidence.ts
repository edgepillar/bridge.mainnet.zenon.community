// Retain only known protocol categories; browser errors can contain endpoints
// or peer-supplied data and must not be copied into published diagnostics.
export function socketFailureClass(message: string): string {
  if (/must not mask|masked frame/i.test(message)) return 'MASKED_SERVER_FRAME'
  if (/invalid frame header|invalid reserved bits|invalid opcode|protocol error/i.test(message)) return 'INVALID_FRAME'
  if (/invalid utf-?8/i.test(message)) return 'INVALID_UTF8'
  if (/ERR_CONNECTION_REFUSED/.test(message)) return 'CONNECTION_REFUSED'
  if (/ERR_CONNECTION_RESET/.test(message)) return 'CONNECTION_RESET'
  if (/ERR_CONNECTION_CLOSED/.test(message)) return 'CONNECTION_CLOSED'
  if (/ERR_TIMED_OUT|timed out/i.test(message)) return 'TIMED_OUT'
  return 'OTHER'
}
