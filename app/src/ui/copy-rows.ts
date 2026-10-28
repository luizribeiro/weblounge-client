export type CopyRow =
  | {
      readonly kind: "message";
      readonly time: Date;
      readonly author: string;
      readonly text: string;
    }
  | { readonly kind: "action"; readonly author: string; readonly text: string }
  | { readonly kind: "day-divider"; readonly label: string };

export function serializeCopyRows(rows: readonly CopyRow[]): string {
  return rows.map(serializeRow).join("\n");
}

function serializeRow(row: CopyRow): string {
  switch (row.kind) {
    case "message":
      return `[${formatTime(row.time)}] <${singleLine(row.author)}> ${singleLine(row.text)}`;
    case "action":
      return `* ${singleLine(row.author)} ${singleLine(row.text)}`;
    case "day-divider":
      return `--- ${singleLine(row.label)} ---`;
  }
}

function formatTime(time: Date): string {
  return `${pad(time.getHours())}:${pad(time.getMinutes())}`;
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function singleLine(value: string): string {
  return value.replaceAll(/\r?\n|\r/g, " ");
}
