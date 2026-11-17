const macModifiers = new Set(["⌃", "⌥", "⇧", "⌘"]);

export function isMacModifier(key: string): boolean {
  return macModifiers.has(key);
}

export function chordKeys(label: string): readonly string[] {
  const chars = [...label];
  if (chars[0] !== undefined && isMacModifier(chars[0]))
    return macChordKeys(chars);
  if (label.length > 1 && label.includes("+")) return label.split(/\+(?!$)/u);
  return label === "" ? [] : [label];
}

function macChordKeys(chars: readonly string[]): readonly string[] {
  const firstKey = chars.findIndex((char) => !isMacModifier(char));
  if (firstKey === -1) return chars;
  return [...chars.slice(0, firstKey), chars.slice(firstKey).join("")];
}
