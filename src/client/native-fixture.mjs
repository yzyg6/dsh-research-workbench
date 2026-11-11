import { acceptanceMarker } from './native-evidence.mjs';

/** Exercise the native input facade; never simulate DOM events or submit. */
export function seedNativeDraft({ mode, marker, draft, phase, workspaceMember, applied, actions }) {
  if (mode !== 'seed' || applied || phase !== 'plain' || !workspaceMember || acceptanceMarker(marker) !== marker) return 'inactive';
  if (draft === marker) return 'retained';
  if (typeof draft !== 'string' || draft.trim()) return 'preserved';
  actions.setDraft(marker);
  actions.persistDraft();
  return 'seeded';
}
