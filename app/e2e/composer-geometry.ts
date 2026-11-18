import { expect, type Locator } from "@playwright/test";

export interface FirstLineGeometry {
  readonly fieldCenter: number;
  readonly sendCenter: number;
  readonly textCenter: number;
}

export async function firstLineGeometry(
  input: Locator,
): Promise<FirstLineGeometry> {
  return input.evaluate(async (element) => {
    const textarea = element as HTMLTextAreaElement;
    await document.fonts.ready;
    const field = textarea.closest<HTMLElement>("[data-composer-field]");
    const send = field?.querySelector<HTMLElement>("[data-composer-send]");
    if (field === null || field === undefined || send === null)
      throw new Error("composer geometry is missing");
    const inputStyle = getComputedStyle(textarea);
    const inputRect = textarea.getBoundingClientRect();
    const fieldStyle = getComputedStyle(field);
    const fieldRect = field.getBoundingClientRect();
    const sendRect = send.getBoundingClientRect();
    const probe = document.createElement("span");
    probe.style.background = "transparent";
    probe.style.border = "0";
    probe.style.font = inputStyle.font;
    probe.style.fontKerning = inputStyle.fontKerning;
    probe.style.letterSpacing = inputStyle.letterSpacing;
    probe.style.lineHeight = inputStyle.lineHeight;
    probe.style.margin = "0";
    probe.style.opacity = "0";
    probe.style.padding = "0";
    probe.style.position = "fixed";
    probe.style.whiteSpace = "pre";
    probe.style.left = `${inputRect.left + Number.parseFloat(inputStyle.borderLeftWidth) + Number.parseFloat(inputStyle.paddingLeft)}px`;
    probe.style.top = `${inputRect.top + Number.parseFloat(inputStyle.borderTopWidth) + Number.parseFloat(inputStyle.paddingTop) - textarea.scrollTop}px`;
    probe.textContent = textarea.value || textarea.placeholder;
    document.body.append(probe);
    const range = document.createRange();
    range.selectNodeContents(probe);
    const textRect = range.getBoundingClientRect();
    probe.remove();
    const fieldInnerTop =
      fieldRect.top + Number.parseFloat(fieldStyle.borderTopWidth);
    const fieldInnerBottom =
      fieldRect.bottom - Number.parseFloat(fieldStyle.borderBottomWidth);
    return {
      fieldCenter: (fieldInnerTop + fieldInnerBottom) / 2,
      sendCenter: (sendRect.top + sendRect.bottom) / 2,
      textCenter: (textRect.top + textRect.bottom) / 2,
    };
  });
}

export async function expectEdgesAligned(
  field: Locator,
  control: Locator,
): Promise<number> {
  await expect
    .poll(async () => {
      const [fieldBox, controlBox] = await Promise.all([
        field.boundingBox(),
        control.boundingBox(),
      ]);
      if (fieldBox === null || controlBox === null)
        return Number.POSITIVE_INFINITY;
      return Math.max(
        Math.abs(
          fieldBox.y + fieldBox.height - (controlBox.y + controlBox.height),
        ),
        Math.abs(fieldBox.y - controlBox.y),
      );
    })
    .toBeLessThanOrEqual(0.5);
  const controlBox = await control.boundingBox();
  expect(controlBox).not.toBeNull();
  return controlBox?.height ?? 0;
}
