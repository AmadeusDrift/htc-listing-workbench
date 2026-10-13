/** Display-only redaction. Raw model/platform evidence remains in the request record. */
export function safeIssueExplanation(value: string | null | undefined): string {
  if (!value?.trim()) return '未保存具体说明。';
  return value
    .replace(/(?:https?|ftp|file):\/\/[^\s<>"'，。；）)]+/gi, '[链接已隐藏]')
    .replace(/\b[A-Za-z]:[\\/][^\s<>"'，。；]+|\\\\[^\s<>"'，。；]+/g, '[本机路径已隐藏]')
    .replace(/\/(?:Users|home|tmp|var|private)\/[^\s<>"'，。；]+/g, '[本机路径已隐藏]')
    .replace(/\b(?:Authorization\s*[:=]\s*)?Bearer\s+[^\s,;，；]+/gi, '[凭据已隐藏]')
    .replace(/["']?\b(?:api[_-]?key|access[_-]?key(?:[_-]?(?:id|secret))?|client[_-]?secret|refresh[_-]?token|security[_-]?token|token|password|secret)\b["']?\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;，；]+)/gi, '[凭据已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[凭据已隐藏]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .slice(0, 2400);
}
