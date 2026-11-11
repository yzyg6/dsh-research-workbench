// Recognize only explicit synthetic acceptance strings; never export draft prose.
export function acceptanceMarker(value) {
  return typeof value === 'string' && /^RW-[AB]-(WRITE|FIGURE|READ)-20261109$/.test(value.trim()) ? value.trim() : null;
}
export function storedMarker(storage, sessionId) {
  try {
    const value = JSON.parse(storage.getItem(`dsh.conversation.${sessionId}`));
    return acceptanceMarker(typeof value?.draft === 'string' ? value.draft : value?.draft?.text);
  } catch { return null; }
}
