const macModifiers = new Set(["⌃", "⌥", "⇧", "⌘"]);

export function isMacModifier(key: string): boolean {
  return macModifiers.has(key);
}

export function chordKeys(label: string): readonly string[] {
  if (label.length > 1 && label.includes("+")) return label.split(/\+(?!$)/u);
  const chars = [...label];
  const firstKey = chars.findIndex((char) => !isMacModifier(char));
  if (firstKey === -1) return chars;
  return [...chars.slice(0, firstKey), chars.slice(firstKey).join("")];
}
