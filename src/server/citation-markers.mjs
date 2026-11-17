export const citationMarkers = text => text.match(/\[@[^\]]+\]|\[(?:\d+[\s,，–-]*)+\]/g) || [];
